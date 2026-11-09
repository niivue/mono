// dcm2niix output carries no DICOM identity, so map each slice of the shown NIfTI
// back to the frame it came from by geometry: a frame's ImagePositionPatient, put
// through the inverse sform, gives its slice index. Reading the slice axis off the
// sform makes this immune to dcm2niix's row flip, slice reordering and echo split.

import { isPartType } from './dcm2niixOutputs'

type Vec3 = [number, number, number]

/** Which classic frames the shown output holds: its echo and phase-ness. */
export interface OutputFilter {
  echo?: number
  part: boolean
}

/** The DICOM frame one NIfTI slice came from (MeasurementService fields). */
export interface FrameRef {
  SOPInstanceUID: string
  /** 1-based, as Cornerstone's getSOPInstanceAttributes reports it. */
  frameNumber: number
  referencedImageId?: string
}

/** Slice k = dot(p - origin, normal) for an LPS point p; frames[k] its frame. */
export interface SliceFrames {
  origin: Vec3
  normal: Vec3
  frames: Array<FrameRef | undefined>
}

// How far, in slices, a point may sit off a slice and still lie in it: float32
// sform and pick rounding only.
const ON_PLANE = 0.01
// Frame and slice normals this parallel (cos; ~0.1 degree) share a plane.
const PARALLEL = 1 - 1e-6

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
// dcmjs collapses a one-item sequence to the item itself.
const one = (v: unknown): Record<string, unknown> | undefined =>
  (Array.isArray(v) ? v[0] : v) as Record<string, unknown> | undefined

function vec3(v: unknown, offset = 0): Vec3 | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Vec3 = [
    Number(v[offset]),
    Number(v[offset + 1]),
    Number(v[offset + 2]),
  ]
  return out.every(Number.isFinite) ? out : undefined
}

// The sform of an uncompressed NIfTI-1 header, columns and origin in LPS.
function sformLps(header: ArrayBuffer) {
  const view = new DataView(header)
  if (view.byteLength < 348) return undefined
  const le = view.getInt32(0, true) === 348
  if (!le && view.getInt32(0, false) !== 348) return undefined
  if (view.getInt16(254, le) <= 0) return undefined
  // RAS -> LPS negates rows x and y.
  const at = (r: number, c: number) =>
    (r < 2 ? -1 : 1) * view.getFloat32(280 + 16 * r + 4 * c, le)
  const col = (c: number): Vec3 => [at(0, c), at(1, c), at(2, c)]
  return {
    ci: col(0),
    cj: col(1),
    ck: col(2),
    origin: col(3),
    slices: Math.max(1, view.getInt16(46, le)),
  }
}

function frameImageId(imageId: unknown, frame: number): string | undefined {
  if (typeof imageId !== 'string') return undefined
  // As OHIF derives frame imageIds (extensions/default/src/init.ts).
  if (/\/frames\/\d+$/.test(imageId))
    return imageId.replace(/\/frames\/\d+$/, `/frames/${frame}`)
  return frame === 1 ? imageId : undefined
}

interface Frame {
  ref: FrameRef
  position: Vec3
  normal: Vec3
}

// Every frame with geometry: a classic instance's one frame, or an enhanced
// instance's per-frame plane positions. Classic instances of another echo or
// image part than the shown output's are dropped; other collisions stay unmapped.
function instanceFrames(
  instances: ReadonlyArray<Record<string, unknown>>,
  { echo, part }: OutputFilter,
): Frame[] {
  const out: Frame[] = []
  for (const inst of instances) {
    const sop = inst.SOPInstanceUID
    if (typeof sop !== 'string') continue
    const perFrame = inst.PerFrameFunctionalGroupsSequence
    const add = (frameNumber: number, ipp: unknown, iop: unknown) => {
      const position = vec3(ipp)
      const row = vec3(iop)
      const col = vec3(iop, 3)
      if (!position || !row || !col) return
      const referencedImageId = frameImageId(inst.imageId, frameNumber)
      out.push({
        ref: {
          SOPInstanceUID: sop,
          frameNumber,
          ...(referencedImageId ? { referencedImageId } : {}),
        },
        position,
        normal: cross(row, col),
      })
    }
    if (perFrame) {
      const shared = one(inst.SharedFunctionalGroupsSequence)
      const sharedIop = one(
        shared?.PlaneOrientationSequence,
      )?.ImageOrientationPatient
      const groups = Array.isArray(perFrame) ? perFrame : [perFrame]
      groups.forEach((group: Record<string, unknown>, i) => {
        add(
          i + 1,
          one(group?.PlanePositionSequence)?.ImagePositionPatient,
          one(group?.PlaneOrientationSequence)?.ImageOrientationPatient ??
            sharedIop,
        )
      })
    } else if ((Number(inst.NumberOfFrames) || 1) === 1) {
      const e = inst.EchoNumbers
      const instEcho = Number(Array.isArray(e) ? e[0] : e)
      if (echo !== undefined && instEcho > 0 && instEcho !== echo) continue
      if (isPartType(inst.ImageType) !== part) continue
      add(1, inst.ImagePositionPatient, inst.ImageOrientationPatient)
    }
  }
  return out
}

/**
 * Map the slices of a NIfTI (its header, uncompressed) to the frames of the
 * display set's naturalized instances. A frame maps to the slice it lies in; a
 * slice two frames claim, or none, stays unmapped. Undefined without a sform.
 */
export function buildSliceFrames(
  header: ArrayBuffer,
  instances: ReadonlyArray<Record<string, unknown>>,
  filter: OutputFilter = { part: false },
): SliceFrames | undefined {
  const sform = sformLps(header)
  if (!sform) return undefined
  const { ci, cj, ck } = sform
  const perp = cross(ci, cj)
  const perpLen = Math.hypot(...perp)
  const step = dot(ck, perp)
  if (!perpLen || !step) return undefined
  const sf: SliceFrames = {
    origin: sform.origin,
    normal: [perp[0] / step, perp[1] / step, perp[2] / step],
    frames: new Array(sform.slices).fill(undefined),
  }
  const claimed = new Set<number>()
  for (const { ref, position, normal } of instanceFrames(instances, filter)) {
    // Only a frame lying in a slice is its source: not a tilted or resampled
    // (_Tilt, _Eq) neighbour. The negated test also drops a degenerate IOP.
    if (
      !(
        Math.abs(dot(normal, perp)) >
        PARALLEL * perpLen * Math.hypot(...normal)
      )
    )
      continue
    const k = onSlice(sf, position)
    if (k === undefined) continue
    // Two frames at one position (another echo or image type) stay unmapped.
    sf.frames[k] = claimed.has(k) ? undefined : ref
    claimed.add(k)
  }
  return sf
}

const sliceDepth = (sf: SliceFrames, p: Vec3) =>
  dot(
    [p[0] - sf.origin[0], p[1] - sf.origin[1], p[2] - sf.origin[2]],
    sf.normal,
  )

// The slice an LPS point lies in (within ON_PLANE of its centre), else undefined.
function onSlice(sf: SliceFrames, p: Vec3): number | undefined {
  const depth = sliceDepth(sf, p)
  const k = Math.round(depth)
  return k >= 0 && k < sf.frames.length && Math.abs(depth - k) <= ON_PLANE
    ? k
    : undefined
}

/** The frame whose plane all LPS points lie on, else undefined. */
export function frameAt(
  sf: SliceFrames,
  points: ReadonlyArray<Vec3>,
): FrameRef | undefined {
  const first = points[0]
  const k = first && onSlice(sf, first)
  if (!first || k === undefined) return undefined
  // A reformatted measurement may share the slab but leave the plane: every
  // point on slice k, and within ON_PLANE of one another.
  // A loop, not Math.min(...depths): spreading a large contour overflows the stack.
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const p of points) {
    if (onSlice(sf, p) !== k) return undefined
    const d = sliceDepth(sf, p)
    lo = Math.min(lo, d)
    hi = Math.max(hi, d)
  }
  return hi - lo > ON_PLANE ? undefined : sf.frames[k]
}
