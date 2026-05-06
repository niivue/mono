/**
 * Voxel-to-mesh helpers — two paths:
 *
 *   - {@link buildMeshFromVolumeFast}    niimath-only, fast (returns MZ3)
 *   - {@link buildMeshFromVolumeQuality} ITK-Wasm cuberille + repair + smooth
 *                                        (returns .iwm.cbor)
 *
 * Both produce buffers that NiiVue can load directly. Wrap the result in a
 * `File` whose `.name` carries the right extension so NiiVue's reader registry
 * dispatches correctly:
 *
 * ```ts
 * const buf = await buildMeshFromVolumeFast(niimath, vol)
 * await nv.loadMeshes([{ url: new File([buf], 'mesh.mz3') }])
 *
 * const buf = await buildMeshFromVolumeQuality(vol)
 * await nv.loadMeshes([{ url: new File([buf], 'mesh.iwm.cbor') }])
 * ```
 *
 * The ITK-Wasm pipelines used by the Quality path fetch their WASM modules
 * from the npm-default CDN (cdn.jsdelivr.net) at first call. That's the only
 * network dependency in this module — fast path runs entirely in-process.
 * To run offline, vendor the pipelines and call `setPipelinesBaseUrl()`
 * from `@itk-wasm/cuberille` + `@itk-wasm/mesh-filters` at app startup.
 */

import { antiAliasCuberille, cuberille } from '@itk-wasm/cuberille'
import {
  keepLargestComponent,
  repair,
  smoothRemesh,
} from '@itk-wasm/mesh-filters'
import type { NIFTI1, NIFTI2, NVImage } from '@niivue/niivue'
import {
  type Niimath,
  type NiimathStep,
  runNiimathPipeline,
} from '@niivue/nv-ext-niimath'
import { encode } from 'cbor-x'

type CuberilleImage = Parameters<typeof cuberille>[0]

// ---------------------------------------------------------------------------
// Fast path — niimath
// ---------------------------------------------------------------------------

export interface BuildMeshFastOptions {
  /** Iso-surface value. Default: 0.5 (label volumes); set to 240 for scalar. */
  isoValue?: number
  /** Hollowing wall thickness in mm. Negative → hollow with -hollow mm wall. 0 disables. Default 0. */
  hollow?: number
  /** Morphological close radius in mm. 0 disables. Default 0. */
  close?: number
  /** Mesh simplification factor in (0, 1]. Default 0.25. */
  reduce?: number
  /** Fill internal bubbles. Default false. */
  fillBubbles?: boolean
  /** Keep only the largest connected component. Default true. */
  largestOnly?: boolean
}

/**
 * Build a triangle mesh from a label/scalar volume using niimath's isosurface
 * pipeline. Returns an MZ3 ArrayBuffer.
 *
 * Caller owns the {@link Niimath} instance — pass an already-`init()`ed one.
 * The pipeline is serial by nature (the underlying worker reuses one
 * `onmessage` handler), so callers must serialize their own concurrent calls.
 */
export async function buildMeshFromVolumeFast(
  niimath: Niimath,
  volume: NVImage,
  opts: BuildMeshFastOptions = {},
): Promise<ArrayBuffer> {
  if (!volume.img) {
    throw new Error('buildMeshFromVolumeFast: volume has no image data')
  }
  const isoValue = opts.isoValue ?? defaultIsoValue(volume.hdr)
  const reduce = clamp(opts.reduce ?? 0.25, 0.01, 1)
  const hollow = opts.hollow ?? 0
  const close = opts.close ?? 0
  const largestOnly = opts.largestOnly ?? true
  const fillBubbles = opts.fillBubbles ?? false

  const steps: NiimathStep[] = []
  if (hollow < 0) {
    steps.push({ method: 'hollow', args: [0.5, hollow] })
  }
  if (Number.isFinite(close) && close > 0) {
    steps.push({ method: 'close', args: [isoValue, close, 2 * close] })
  }
  steps.push({
    method: 'mesh',
    args: [
      {
        i: isoValue,
        l: largestOnly ? 1 : 0,
        r: reduce,
        b: fillBubbles ? 1 : 0,
      },
    ],
  })

  const blob = await runNiimathPipeline(niimath, volume, steps, 'mesh.mz3')
  return await blob.arrayBuffer()
}

/**
 * Load a fast-path MZ3 buffer into NiiVue and fix its winding so the mesh
 * renders right-side-out under the default mesh shader.
 *
 * niimath emits CW indices; NiiVue's `generateNormals` assumes CCW.
 * Mutating `mesh.indices` alone doesn't propagate to the GPU index buffer
 * (which was created at upload time), so we also call
 * `nv.updateGLVolume()` to re-run `uploadMeshGPU` for all meshes.
 *
 * ```ts
 * const buf = await buildMeshFromVolumeFast(niimath, volume)
 * await loadFastMeshAndFlipFaces(nv, buf)
 * ```
 */
export async function loadFastMeshAndFlipFaces(
  nv: {
    loadMeshes: (meshes: { url: File; name?: string }[]) => Promise<unknown>
    meshes: { indices: Uint32Array }[]
    updateGLVolume: () => Promise<unknown>
  },
  buffer: ArrayBuffer,
  name = 'mesh.mz3',
): Promise<void> {
  await nv.loadMeshes([{ url: new File([buffer], name), name }])
  const indices = nv.meshes[nv.meshes.length - 1].indices
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const tmp = indices[i + 1]
    indices[i + 1] = indices[i + 2]
    indices[i + 2] = tmp
  }
  await nv.updateGLVolume()
}

// ---------------------------------------------------------------------------
// Quality path — ITK-Wasm cuberille + repair + smooth
// ---------------------------------------------------------------------------

export interface BuildMeshQualityOptions {
  /**
   * Iso-surface value. Default: 0.5 for label volumes, 240 for scalar.
   * **Only applied when `useAntiAlias` is false** — `antiAliasCuberille`
   * operates on a normalized image whose iso range is `[-4.0, 4.0]`, so
   * the same number wouldn't carry the same meaning. The anti-alias path
   * uses its WASM default and ignores this field.
   */
  isoValue?: number
  /** Use anti-aliased cuberille. Default true for labels, false for scalar. */
  useAntiAlias?: boolean
  /** Newton iterations during smoothing/remeshing. Default 30. */
  smoothIterations?: number
  /** Output point count as a percent of bounding-box diagonal. Default 25. */
  shrinkPct?: number
  /** Maximum hole area to fill, percent of total area. Default 50. */
  maxHoleArea?: number
}

/**
 * Build a high-quality watertight mesh from a label/scalar volume via
 * ITK-Wasm cuberille → repair → keepLargestComponent → smoothRemesh → repair.
 * Returns an `.iwm.cbor` ArrayBuffer (NiiVue auto-detects via filename).
 *
 * First call fetches `@itk-wasm/cuberille` and `@itk-wasm/mesh-filters` WASM
 * modules from the package's default CDN (cdn.jsdelivr.net).
 */
export async function buildMeshFromVolumeQuality(
  volume: NVImage,
  opts: BuildMeshQualityOptions = {},
): Promise<ArrayBuffer> {
  if (!volume.img) {
    throw new Error('buildMeshFromVolumeQuality: volume has no image data')
  }
  // Many NIfTI intent codes (statistical maps, vectors, etc.) are non-zero
  // and non-label — only NIFTI_INTENT_LABEL (1002) means "discrete labels."
  const isLabel = volume.hdr.intent_code === 1002
  const isoValue = opts.isoValue ?? (isLabel ? 0.5 : 240)
  const useAntiAlias = opts.useAntiAlias ?? isLabel
  const smoothIterations = opts.smoothIterations ?? 30
  const shrinkPct = opts.shrinkPct ?? 25
  const maxHoleArea = opts.maxHoleArea ?? 50

  const itkImage = nvImageToIwi(volume) as unknown as CuberilleImage
  const cuberilleResult = useAntiAlias
    ? await antiAliasCuberille(itkImage, { noClosing: true })
    : await cuberille(itkImage, { isoSurfaceValue: isoValue })
  const { mesh } = cuberilleResult

  const { outputMesh: repaired } = await repair(mesh, {
    maximumHoleArea: maxHoleArea,
  })
  const { outputMesh: largest } = await keepLargestComponent(repaired)
  const { outputMesh: smoothed } = await smoothRemesh(largest, {
    newtonIterations: smoothIterations,
    numberPoints: shrinkPct,
  })
  const { outputMesh: smoothedRepaired } = await repair(smoothed, {
    maximumHoleArea: maxHoleArea,
  })

  // Encode the ITK Mesh object to CBOR bytes — NiiVue's `.iwm.cbor` reader
  // ingests it directly with no transform on the receiving side.
  const cbor = encode(smoothedRepaired) as Uint8Array
  return cbor.buffer.slice(
    cbor.byteOffset,
    cbor.byteOffset + cbor.byteLength,
  ) as ArrayBuffer
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal ITK-Wasm `Image`-shaped object — the actual `Image` class lives in
 * `itk-wasm` (a transitive dep of `@itk-wasm/cuberille`). We construct a
 * structurally-compatible plain object and cast at the call site rather than
 * pulling `itk-wasm` into our own deps for one type import.
 */
interface IWImage {
  imageType: {
    dimension: number
    componentType: string
    pixelType: 'Scalar'
    components: number
  }
  origin: number[]
  spacing: number[]
  direction: Float64Array
  size: number[]
  metadata: unknown[]
  data: ArrayBufferView
}

/**
 * Convert an `NVImage` to the ITK-Wasm `Image` shape `cuberille` /
 * `antiAliasCuberille` consume. Direction + origin are recovered from the
 * NIfTI affine via the same RAS→LPS inversion as `@niivue/cbor-loader`'s
 * `nii2iwi`. `metadata` must be a plain array — `Map` is not the shape the
 * WASM bridge serializes.
 *
 * Float32 label volumes (`intent_code === 1002`) are narrowed to Uint8 to
 * match `antiAliasCuberille`'s expected integer label input.
 */
function nvImageToIwi(volume: NVImage): IWImage {
  const rawImg = volume.img
  if (!rawImg) throw new Error('nvImageToIwi: volume has no image data')
  const hdr = volume.hdr
  const dims = hdr.dims
  const pixDims = hdr.pixDims
  // Float32 label volumes (intent_code 1002) need narrowing to Uint8 —
  // antiAliasCuberille's WASM build asserts on integer label input.
  let data: ArrayBufferView = rawImg
  if (hdr.intent_code === 1002 && rawImg instanceof Float32Array) {
    const u8 = new Uint8Array(rawImg.length)
    for (let i = 0; i < rawImg.length; i++) {
      const v = rawImg[i]
      u8[i] = v > 0 ? (v < 255 ? Math.round(v) : 255) : 0
    }
    data = u8
  }
  const size = [dims[1], dims[2], dims[3]].map((n) => Math.max(1, n | 0))
  const spacing = [pixDims[1] || 1, pixDims[2] || 1, pixDims[3] || 1]
  return {
    imageType: {
      dimension: 3,
      componentType: itkComponentType(data),
      pixelType: 'Scalar',
      components: 1,
    },
    origin: niftiOriginLPS(hdr),
    spacing,
    direction: niftiDirectionLPS(hdr, spacing),
    size,
    metadata: [],
    data,
  }
}

/**
 * Recover the LPS direction matrix (column-major flat 9) from the NIfTI
 * affine via the same RAS→LPS inversion as `@niivue/cbor-loader`'s
 * `nii2iwi`. Throws if the affine is unusable (`sform_code === 0 &&
 * qform_code === 0` or non-finite diagonal) — silently substituting
 * identity would place the mesh at the volume's corner instead of its
 * patient-coordinate origin, which is harder to debug than an explicit
 * failure.
 */
function niftiDirectionLPS(
  hdr: NIFTI1 | NIFTI2,
  spacing: number[],
): Float64Array {
  const a = requireAffine(hdr)
  const sx = spacing[0] || 1
  const sy = spacing[1] || 1
  const sz = spacing[2] || 1
  return new Float64Array([
    a[0][0] / -sx,
    a[1][0] / -sx,
    a[2][0] / sx,
    a[0][1] / -sy,
    a[1][1] / -sy,
    a[2][1] / sy,
    a[0][2] / -sz,
    a[1][2] / -sz,
    a[2][2] / sz,
  ])
}

function niftiOriginLPS(hdr: NIFTI1 | NIFTI2): number[] {
  const a = requireAffine(hdr)
  return [-a[0][3], -a[1][3], a[2][3]]
}

function requireAffine(hdr: NIFTI1 | NIFTI2): number[][] {
  const a = hdr.affine
  if (
    !a ||
    a.length !== 4 ||
    (hdr.sform_code === 0 && hdr.qform_code === 0) ||
    !Number.isFinite(a[0]?.[0]) ||
    !Number.isFinite(a[1]?.[1]) ||
    !Number.isFinite(a[2]?.[2])
  ) {
    throw new Error(
      'nvImageToIwi: NIfTI header has no usable sform/qform — cannot place mesh in patient coordinates.',
    )
  }
  return a
}

function itkComponentType(arr: ArrayBufferView): string {
  if (arr instanceof Uint8Array) return 'uint8'
  if (arr instanceof Int8Array) return 'int8'
  if (arr instanceof Uint16Array) return 'uint16'
  if (arr instanceof Int16Array) return 'int16'
  if (arr instanceof Uint32Array) return 'uint32'
  if (arr instanceof Int32Array) return 'int32'
  if (arr instanceof Float32Array) return 'float32'
  if (arr instanceof Float64Array) return 'float64'
  throw new Error(`Unsupported voxel type ${arr.constructor.name}`)
}

function defaultIsoValue(hdr: NIFTI1 | NIFTI2): number {
  // NIFTI_INTENT_LABEL → 0.5; everything else (T1, statistical maps, …) → 240,
  // matching the legacy brain2print heuristic for already-windowed T1s.
  return hdr.intent_code === 1002 ? 0.5 : 240
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
