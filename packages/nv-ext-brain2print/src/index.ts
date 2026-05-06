/**
 * @niivue/nv-ext-brain2print
 *
 * Tinygrad-generated WebGPU brain segmentation models for NiiVue.
 *
 * Two models are bundled — `tissue_fast` (fast tissue-class segmentation)
 * and `subcortical` (gray/white + subcortical structures). Both expect a
 * conformed 256³ 1 mm T1 input and emit a label volume sharing that grid.
 *
 * The library exposes four granular helpers so a demo UI can show progress
 * per stage (acquire device → prepare input → run inference → wrap result):
 *
 *   - {@link getBrainGPUDevice}     — request a `GPUDevice` with the limits
 *                                     and features the models need
 *   - {@link prepareInput}          — conform + normalize the input volume
 *   - {@link BRAIN_MODELS}          — `{ name, label, load }` per model
 *   - {@link buildSegmentationVolume} — wrap labels as a label-coloured NVImage
 *
 * Plus the inlined colormap used by both models:
 *
 *   - {@link COLORMAP_TISSUE_SUBCORTICAL}
 *
 * The colormap has no JSON-fetch step. The demo bundles weight
 * `.safetensors` blobs in its `public/` directory and passes the URL (or
 * fetched bytes) to `model.load(device, weights)`.
 */

import {
  type ColorMap,
  makeLabelLut,
  type NIFTI1,
  type NIFTI2,
  type NVExtensionContext,
  type NVImage,
  nii2volume,
} from '@niivue/niivue'
import { COLORMAP_TISSUE_SUBCORTICAL } from './colormap'
import {
  type BuildMeshFastOptions,
  type BuildMeshQualityOptions,
  buildMeshFromVolumeFast,
  buildMeshFromVolumeQuality,
  loadFastMeshAndFlipFaces,
} from './mesh'
import subcorticalImpl from './models/subcortical'
import tissueFastImpl from './models/tissue-fast'

export type { BuildMeshFastOptions, BuildMeshQualityOptions }
export {
  buildMeshFromVolumeFast,
  buildMeshFromVolumeQuality,
  COLORMAP_TISSUE_SUBCORTICAL,
  loadFastMeshAndFlipFaces,
}

const CONFORM_DIM = 256
const EXPECTED_VOXELS = CONFORM_DIM * CONFORM_DIM * CONFORM_DIM
const SPACING_EPSILON = 1e-4

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

export type BrainModelName = 'subcortical' | 'tissue_fast'

/** Callable inference closure returned by {@link BrainModel.load}. Call it
 *  with a normalized 256³ Float32 volume (z-fastest, as produced by
 *  {@link prepareInput}) to get back per-class label outputs (`results[0]`
 *  is the argmax).
 *
 *  Inference calls are **not** internally serialized — the underlying
 *  tinygrad pipeline shares input/output buffers across calls and would
 *  race on writes if invoked concurrently. Callers must serialize their
 *  own calls (the bundled demo does so via a single task chain).
 *
 *  Always `await dispose()` when swapping models or tearing down the view:
 *  it drains the in-flight inference (if any) and destroys every
 *  `GPUBuffer` allocated during `load`. Awaiting before destroying the
 *  parent `GPUDevice` keeps `buffer.destroy()` off a dead device.
 *  Idempotent — a second call resolves immediately. After `dispose()` the
 *  inferer rejects further calls. */
export type BrainInferer = {
  (img32: Float32Array): Promise<Float32Array[]>
  dispose: () => Promise<void>
}

/** A single brain segmentation model. `load` warms up the GPU pipeline and
 *  returns an inferer closure that maps a 256³ Float32 volume to per-class
 *  label outputs (`results[0]` is the argmax volume). Call `dispose()` when
 *  replacing the model or tearing down the view to release GPU buffers. */
export interface BrainModel {
  name: BrainModelName
  label: string
  load: (
    device: GPUDevice,
    weights: ArrayBuffer | Uint8Array | string,
  ) => Promise<BrainInferer>
}

type GeneratedInferer = (img32: Float32Array) => Promise<Float32Array[]>
type ModelImpl = {
  load: (device: GPUDevice, weights: Uint8Array) => Promise<GeneratedInferer>
}
type TrackingDevice = Pick<
  GPUDevice,
  | 'createBindGroup'
  | 'createBindGroupLayout'
  | 'createBuffer'
  | 'createCommandEncoder'
  | 'createComputePipelineAsync'
  | 'createPipelineLayout'
  | 'createShaderModule'
  | 'queue'
>

function destroyBuffers(buffers: GPUBuffer[]): void {
  for (const buffer of buffers) {
    try {
      buffer.destroy()
    } catch {
      // Device loss or double-destroy should not mask the caller's cleanup.
    }
  }
  buffers.length = 0
}

function createTrackingDevice(
  device: GPUDevice,
  buffers: GPUBuffer[],
): GPUDevice {
  const trackingDevice: TrackingDevice = {
    createBindGroup: device.createBindGroup.bind(device),
    createBindGroupLayout: device.createBindGroupLayout.bind(device),
    createBuffer: (descriptor: GPUBufferDescriptor): GPUBuffer => {
      const buffer = device.createBuffer(descriptor)
      buffers.push(buffer)
      return buffer
    },
    createCommandEncoder: device.createCommandEncoder.bind(device),
    createComputePipelineAsync: device.createComputePipelineAsync.bind(device),
    createPipelineLayout: device.createPipelineLayout.bind(device),
    createShaderModule: device.createShaderModule.bind(device),
    queue: device.queue,
  }
  return trackingDevice as unknown as GPUDevice
}

async function readWeights(
  weights: ArrayBuffer | Uint8Array | string,
): Promise<Uint8Array> {
  if (typeof weights !== 'string') {
    return new Uint8Array(weights)
  }
  const response = await fetch(weights)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch brain2print weights from ${weights}: ${response.status} ${response.statusText}`,
    )
  }
  return new Uint8Array(await response.arrayBuffer())
}

function wrapModelLoad(load: ModelImpl['load']): BrainModel['load'] {
  return async (device, weights) => {
    const trackedBuffers: GPUBuffer[] = []
    const bytes = await readWeights(weights)
    let generatedInferer: GeneratedInferer
    try {
      generatedInferer = await load(
        createTrackingDevice(device, trackedBuffers),
        bytes,
      )
    } catch (err) {
      destroyBuffers(trackedBuffers)
      throw err
    }

    let disposed = false
    // Tracks every in-flight inference so `dispose()` can wait for ALL of
    // them to settle before destroying tracked GPU buffers. Tracking only
    // the latest (which earlier versions did) lets a slower call still be
    // running on the buffers we're about to destroy. The library still
    // doesn't serialize concurrent calls — the tinygrad pipeline races on
    // its shared input/output buffers regardless — so callers must serialize
    // their own calls. This `Set` is purely a teardown safety net; entries
    // are only consumed by `dispose()` so we don't bother removing settled
    // ones.
    const inflight = new Set<Promise<unknown>>()

    const inferer = ((img32: Float32Array): Promise<Float32Array[]> => {
      if (disposed) {
        return Promise.reject(new Error('Brain inferer has been disposed'))
      }
      if (img32.length !== EXPECTED_VOXELS) {
        return Promise.reject(
          new Error(
            `Brain inferer expected ${EXPECTED_VOXELS} voxels, got ${img32.length}`,
          ),
        )
      }
      const run = generatedInferer(img32)
      inflight.add(run.catch(() => undefined))
      return run
    }) as BrainInferer

    inferer.dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await Promise.allSettled(inflight)
      destroyBuffers(trackedBuffers)
    }

    return inferer
  }
}

export const BRAIN_MODELS: Record<BrainModelName, BrainModel> = {
  tissue_fast: {
    name: 'tissue_fast',
    label: 'Tissue (fast)',
    load: wrapModelLoad((tissueFastImpl as unknown as ModelImpl).load),
  },
  subcortical: {
    name: 'subcortical',
    label: 'Subcortical',
    load: wrapModelLoad((subcorticalImpl as unknown as ModelImpl).load),
  },
}

// ---------------------------------------------------------------------------
// GPU device acquisition
// ---------------------------------------------------------------------------

/** Buffer size the legacy demo asked for (~1.4 GB) — large enough for a
 *  256³ Float32 volume × a few intermediate tensors. */
const REQUIRED_BUFFER_BYTES = 1_409_286_144

/**
 * Acquire a WebGPU device with the limits + features the brain segmentation
 * models need (`shader-f16`, ~1.4 GB max storage buffer).
 *
 * Returns `null` if the browser/GPU lacks WebGPU, the adapter, the feature,
 * or the buffer-size limit. Callers should display a friendly fallback in
 * that case — the legacy demo failed silently on phones, which we want to
 * avoid here.
 */
export async function getBrainGPUDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) return null
  if (!adapter.features.has('shader-f16')) return null
  if (adapter.limits.maxStorageBufferBindingSize < REQUIRED_BUFFER_BYTES) {
    return null
  }
  if (adapter.limits.maxBufferSize < REQUIRED_BUFFER_BYTES) return null
  try {
    return await adapter.requestDevice({
      requiredFeatures: ['shader-f16'],
      requiredLimits: {
        maxStorageBufferBindingSize: REQUIRED_BUFFER_BYTES,
        maxBufferSize: REQUIRED_BUFFER_BYTES,
      },
    })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Input preparation
// ---------------------------------------------------------------------------

// Transpose helpers between NIfTI memory order (`x + y·size + z·size²`,
// x-axis fastest) and the order the tinygrad models expect (z-axis fastest,
// x-axis slowest). Both directions are needed: forward before inference,
// inverse after. Without this, tissue_fast's coarse classes still look
// plausible, but subcortical's fine anatomical labels land on the wrong
// voxels.
//
// Two functions instead of one with a `direction` flag — keeps the per-
// iteration string compare out of a 16M-element inner loop and makes the
// call sites greppable.

function transposeToModel(data: Float32Array, size: number): Float32Array {
  const out = new Float32Array(data.length)
  let it = 0
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        out[it++] = data[x + y * size + z * size * size]
      }
    }
  }
  return out
}

function transposeFromModel(data: Float32Array, size: number): Float32Array {
  const out = new Float32Array(data.length)
  let it = 0
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        out[x + y * size + z * size * size] = data[it++]
      }
    }
  }
  return out
}

/**
 * Conform `volume` to a 256³ 1 mm grid via `nv-ext-image-processing`'s
 * `conform` transform, then return both the conformed `NVImage` and a
 * normalized `Float32Array` (`[0, 1]`) transposed into the z-fastest
 * memory order the models expect.
 *
 * **Caller must register the `conform` transform on `ctx` before calling
 * this**, e.g. once at app startup:
 *
 * ```ts
 * import { conform } from '@niivue/nv-ext-image-processing'
 * const ctx = nv.createExtensionContext()
 * ctx.registerVolumeTransform(conform)
 * ```
 *
 * The conform pass itself is skipped only when the input is already 256³,
 * 1 mm isotropic (within `SPACING_EPSILON = 1e-4` of 1 mm to absorb the
 * float drift typical of NIfTI pixDims), AND in FreeSurfer-canonical
 * orientation (`permRAS = [-1, 3, -2]`). Matching dims alone is unsafe —
 * a 256³ volume in a different orientation would feed the model voxels
 * from the wrong axes; matching dims + permRAS but at non-1 mm spacing
 * would scale anatomy.
 *
 * After the (possibly skipped) conform, this throws if the result is not
 * actually 256³ with `EXPECTED_VOXELS` (= 256³) entries — a defensive
 * guard against a future transform regression silently feeding the
 * tinygrad pipeline a wrong-sized buffer.
 *
 * Normalization is NaN/Inf-tolerant: non-finite voxels are excluded from
 * the min/max scan and written as `0` in the output. If the finite range
 * is zero (or no finite voxels exist) the entire output is filled with
 * `0` rather than producing NaNs.
 */
export async function prepareInput(
  ctx: NVExtensionContext,
  volume: NVImage,
): Promise<{ conformed: NVImage; img32: Float32Array }> {
  const p = volume.permRAS
  const px = volume.hdr.pixDims
  const isConformed =
    volume.dims[1] === CONFORM_DIM &&
    volume.dims[2] === CONFORM_DIM &&
    volume.dims[3] === CONFORM_DIM &&
    p?.[0] === -1 &&
    p?.[1] === 3 &&
    p?.[2] === -2 &&
    Math.abs((px?.[1] ?? 0) - 1) < SPACING_EPSILON &&
    Math.abs((px?.[2] ?? 0) - 1) < SPACING_EPSILON &&
    Math.abs((px?.[3] ?? 0) - 1) < SPACING_EPSILON
  const conformed = isConformed
    ? volume
    : await ctx.applyVolumeTransform('conform', volume, {
        toRAS: false,
        isLinear: true,
        asFloat32: true,
        isRobustMinMax: false,
      })
  if (!conformed.img) {
    throw new Error('prepareInput: conformed volume has no image data')
  }
  if (
    conformed.dims[1] !== CONFORM_DIM ||
    conformed.dims[2] !== CONFORM_DIM ||
    conformed.dims[3] !== CONFORM_DIM ||
    conformed.img.length !== EXPECTED_VOXELS
  ) {
    throw new Error(
      'prepareInput: conform transform did not produce 256^3 data',
    )
  }
  const native = new Float32Array(conformed.img as ArrayLike<number>)
  const img32 = transposeToModel(native, CONFORM_DIM)
  let mn = Infinity
  let mx = -Infinity
  for (let i = 0; i < img32.length; i++) {
    const v = img32[i]
    if (!Number.isFinite(v)) continue
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  const range = mx - mn
  if (Number.isFinite(range) && range > 0) {
    const scale = 1 / range
    for (let i = 0; i < img32.length; i++) {
      const v = img32[i]
      img32[i] = Number.isFinite(v) ? (v - mn) * scale : 0
    }
  } else {
    img32.fill(0)
  }
  return { conformed, img32 }
}

// ---------------------------------------------------------------------------
// Result wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap a segmentation-label `Float32Array` as a label-coloured `NVImage`
 * sharing the conformed input's geometry. The returned volume has its
 * `colormapLabel` populated via `makeLabelLut(colormap)` so the orient
 * shader picks up the discrete label palette without an extra controller
 * call.
 *
 * Default `opacity` is `0.5` (legacy used 128/255 ≈ 0.502; rounded to
 * match the slider used in the new demo).
 *
 * Throws if `segmentationLabels.length !== 256³` — guards against a
 * model output dim mismatch turning into garbled `nii2volume` data.
 */
export function buildSegmentationVolume(
  conformed: NVImage,
  segmentationLabels: Float32Array,
  colormap: ColorMap,
): NVImage {
  if (segmentationLabels.length !== EXPECTED_VOXELS) {
    throw new Error(
      `buildSegmentationVolume expected ${EXPECTED_VOXELS} labels, got ${segmentationLabels.length}`,
    )
  }
  const clonedHdr: NIFTI1 | NIFTI2 = JSON.parse(JSON.stringify(conformed.hdr))
  clonedHdr.datatypeCode = 16 // DT_FLOAT32
  clonedHdr.numBitsPerVoxel = 32
  clonedHdr.scl_slope = 1
  clonedHdr.scl_inter = 0
  clonedHdr.cal_min = 0
  clonedHdr.cal_max = 0
  // Mark as a label volume so downstream consumers (mesh export, save, etc.)
  // can pick the label-aware code path instead of inheriting `intent_code`
  // from the input T1.
  clonedHdr.intent_code = 1002 // NIFTI_INTENT_LABEL
  // Force a 3D dim count — segmentations are single-frame even if the input
  // was 4D — and clear any per-frame trailing dims that the deep-clone
  // carried over from the conformed source.
  clonedHdr.dims[0] = 3
  clonedHdr.dims[4] = 1
  clonedHdr.dims[5] = 1
  clonedHdr.dims[6] = 1
  // Inverse-transpose: model output is z-fastest; NIfTI storage is x-fastest.
  const niftiOrder = transposeFromModel(segmentationLabels, CONFORM_DIM)
  const seg = nii2volume(clonedHdr, niftiOrder, 'segmentation')
  seg.colormapLabel = makeLabelLut(colormap)
  seg.opacity = 0.5
  return seg
}
