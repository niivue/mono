import { calculateRAS } from '@/math/NVTransforms'
import type { NVImage } from '@/NVTypes'
import type { Vec3f, Vec3i } from './chunking'
import { calculateWorldExtents, createNiftiHeader } from './utils'

/** Inputs for {@link createStreamingNVImage}. */
export interface StreamingVolumeSpec {
  /** Volume dims in voxels `[x, y, z]` (the finest level / common grid). */
  shape: Vec3i
  /** Voxel spacing in mm `[x, y, z]`. */
  spacing: Vec3f
  /** NIfTI datatype code (see `NiiDataType`). */
  datatypeCode: number
  /** Display window minimum. */
  calMin: number
  /** Display window maximum. */
  calMax: number
  /** Display name (defaults to `id`, then `'streamed volume'`). */
  name?: string
  /**
   * Stable id used to target plan swaps. Defaults to a fresh unique id so two
   * volumes built without an explicit id never collide on the shared
   * `'streamed volume'` name (host plan-swap lookup is id-or-name find-first).
   */
  id?: string
  /**
   * Optional source URL. Both renderers key their per-volume chunk texture
   * cache on `url || name`, so when omitted this defaults to a unique
   * `streamed://<id>` (never fetched for a chunked volume — the URL is a cache
   * key only, all bytes arrive via `chunkSource`) so two default-created
   * streamed volumes never collide on the shared `'streamed volume'` name.
   */
  url?: string
  /** Colormap name (default `'gray'`). */
  colormap?: string
  /** Whether values below `calMin` are transparent (default `true`). */
  isTransparentBelowCalMin?: boolean
  /** Layer opacity `[0, 1]` (default `1`). */
  opacity?: number
}

// Monotonic session counter for the fallback id path. A counter alone is
// collision-free within a session and needs no entropy source.
let streamIdCounter = 0

/**
 * A process-unique id for a default-created streamed volume. Prefers
 * `crypto.randomUUID()` but that is only defined in a secure context, so a plain
 * http LAN page (where NiiVue is routinely served) would throw. Falls back to a
 * monotonic module-level counter, which is collision-free within a session
 * without relying on `Date.now()`/`Math.random()`.
 */
function nextStreamId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  streamIdCounter += 1
  return `streamed-${streamIdCounter}`
}

/**
 * Build an `NVImage` skeleton for a streamed volume: a NIfTI header plus the
 * fully-derived RAS/oblique transforms (`matRAS`, `frac2mm`, extents, `mm000`,
 * ...) computed by the same {@link calculateRAS} the NIfTI loader uses — but
 * with `img: null`. The caller attaches a `chunkPlan` + `chunkSource` so the
 * renderer streams voxels on demand instead of reading an in-memory array.
 *
 * The grid is axis-aligned RAS with the affine `diag(spacing)`; voxel centres
 * sit at `(i + 0.5) * spacing`, so two streamed volumes covering the same mm
 * box register. Replaces the ~150 lines of hand-rolled header/affine math a
 * consumer would otherwise write.
 */
export function createStreamingNVImage(spec: StreamingVolumeSpec): NVImage {
  const { shape, spacing, datatypeCode } = spec
  const name = spec.name ?? spec.id ?? 'streamed volume'
  // Default to a unique id, not the shared human-readable name: the host's plan
  // swap resolves a volume by id-or-name find-first, so two default-name volumes
  // sharing the id 'streamed volume' would route one handle's swap onto the other.
  const id = spec.id ?? nextStreamId()
  // The renderers key their chunk texture cache on `url || name`. `name` stays
  // the shared human-readable 'streamed volume', so default the URL to a unique
  // value derived from the (unique) id — otherwise two default streamed volumes
  // collide on the name key and the second reuses the first's chunk manager.
  const url = spec.url ?? `streamed://${id}`
  // Axis-aligned RAS affine: diag(spacing) with the origin at voxel [0,0,0].
  const affine = [
    spacing[0],
    0,
    0,
    0,
    0,
    spacing[1],
    0,
    0,
    0,
    0,
    spacing[2],
    0,
    0,
    0,
    0,
    1,
  ]
  const hdr = createNiftiHeader([...shape], [...spacing], affine, datatypeCode)
  hdr.cal_min = spec.calMin
  hdr.cal_max = spec.calMax
  hdr.description = 'streamed logical volume'

  const { extentsMin, extentsMax } = calculateWorldExtents(
    [...shape],
    new Float32Array(hdr.affine.flat()),
  )

  const volume: NVImage = {
    name,
    id,
    url,
    hdr,
    originalAffine: hdr.affine.map((row) => [...row]),
    img: null,
    dims: hdr.dims.slice(0, 4),
    nVox3D: shape[0] * shape[1] * shape[2],
    extentsMin,
    extentsMax,
    calMin: spec.calMin,
    calMax: spec.calMax,
    robustMin: spec.calMin,
    robustMax: spec.calMax,
    globalMin: spec.calMin,
    globalMax: spec.calMax,
    colormap: spec.colormap ?? 'gray',
    isTransparentBelowCalMin: spec.isTransparentBelowCalMin ?? true,
    opacity: spec.opacity ?? 1,
    isColorbarVisible: false,
    isLegendVisible: false,
    frame4D: 0,
    nFrame4D: 1,
    nTotalFrame4D: 1,
  }

  // Derive matRAS / frac2mm / dimsRAS / extents-ortho / mm000... exactly as the
  // NIfTI loader does. `calculateRAS` reads only the header, so `img === null`
  // is fine.
  calculateRAS(volume)

  const dimsMM = [
    (volume.pixDimsRAS?.[1] ?? spacing[0]) * (volume.dimsRAS?.[1] ?? shape[0]),
    (volume.pixDimsRAS?.[2] ?? spacing[1]) * (volume.dimsRAS?.[2] ?? shape[1]),
    (volume.pixDimsRAS?.[3] ?? spacing[2]) * (volume.dimsRAS?.[3] ?? shape[2]),
  ]
  const longest = Math.max(dimsMM[0], dimsMM[1], dimsMM[2]) || 1
  volume.volScale = [
    dimsMM[0] / longest,
    dimsMM[1] / longest,
    dimsMM[2] / longest,
  ]

  return volume
}
