import * as NVCmaps from '@/cmap/NVCmaps'
import { log } from '@/logger'
import { OVERLAY_ALPHA_BLEND, OVERLAY_COLOR_BLEND } from '@/NVConstants'
import type { NVImage } from '@/NVTypes'
import {
  buildOrientUniforms,
  prepareRGBAData,
  rgbaTextureKey,
} from '@/view/NVOrient'
import type { ChunkPlan } from '@/volume/chunking'
import {
  IDENTITY_MTX,
  type ModulationTextureParams,
  modulationFitsTextureLimit,
} from '@/volume/modulation'
import {
  chunkModulationParams,
  chunkOverlayMatrix,
} from '@/volume/orientChunked'
import orientWGSL from './orient.wgsl?raw'
import * as wgpu from './wgpu'

// Uniform buffer: 12 vec4 = matrix(4) + params/negParams/flags(3) + modMtx(4) + modFlags(1)
const ORIENT_UNIFORM_SIZE = 12 * 16

function supportedModulation(
  device: GPUDevice,
  mod: ModulationTextureParams | null,
): ModulationTextureParams | null {
  if (modulationFitsTextureLimit(mod, device.limits.maxTextureDimension3D)) {
    return mod
  }
  log.warn(
    `modulation disabled: grid ${mod?.dims.join('x')} exceeds WebGPU maxTextureDimension3D (${device.limits.maxTextureDimension3D})`,
  )
  return null
}

/** Create an r32float 3D modulation-weight texture, or a 1x1x1 placeholder. */
export function createModTexture(
  device: GPUDevice,
  mod: ModulationTextureParams | null,
): GPUTexture {
  const dims = mod ? mod.dims : [1, 1, 1]
  const tex = device.createTexture({
    size: dims as [number, number, number],
    format: 'r32float',
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const data = mod ? mod.weight : new Float32Array([1])
  device.queue.writeTexture(
    { texture: tex },
    data as Float32Array<ArrayBuffer>,
    { bytesPerRow: dims[0] * 4, rowsPerImage: dims[1] },
    dims as [number, number, number],
  )
  return tex
}

type PipelineCacheEntry = {
  pipeline: GPUComputePipeline
  layout: GPUBindGroupLayout
}
const _deviceCache = new WeakMap<
  GPUDevice,
  Record<string, PipelineCacheEntry>
>()

export function ensureOrientPipeline(
  device: GPUDevice,
  pipelineType: string,
): PipelineCacheEntry {
  let perDevice = _deviceCache.get(device)
  if (!perDevice) {
    perDevice = {}
    _deviceCache.set(device, perDevice)
  }
  if (perDevice[pipelineType]) {
    return perDevice[pipelineType]
  }
  let shaderSource = orientWGSL
  let sampleType: GPUTextureSampleType = 'uint'
  if (pipelineType === 'float') {
    shaderSource = shaderSource.replaceAll('texture_3d<u32>', 'texture_3d<f32>')
    sampleType = 'unfilterable-float'
  } else if (pipelineType === 'sint') {
    shaderSource = shaderSource.replaceAll('texture_3d<u32>', 'texture_3d<i32>')
    sampleType = 'sint'
  }
  const module = device.createShaderModule({ code: shaderSource })
  const layout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: sampleType, viewDimension: '3d' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        texture: { viewDimension: '2d' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { format: 'rgba8unorm', viewDimension: '3d' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.COMPUTE,
        texture: { viewDimension: '2d' },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
      },
    ],
  })
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: 'main' },
  })
  perDevice[pipelineType] = { pipeline, layout }
  return perDevice[pipelineType]
}

export type OrientTextureCache = {
  sourceTexture: GPUTexture
  outputTexture: GPUTexture
  uniformBuffer: GPUBuffer
  colormapTexture: GPUTexture
  negativeColormapTexture: GPUTexture
  sampler: GPUSampler
  bindGroup: GPUBindGroup
  dimsIn: number[]
  dimsOut: number[]
  datatypeCode: number
  frame4D: number
  colormapKey: string
  imageBuffer: ArrayBufferLike
  /** `nvimage._dataVersion` the source texture was last uploaded from. */
  dataVersion: number
  pipelineType: string
  hasNegativeColormap: boolean
  modTexture: GPUTexture
  modKey: string
}

function createRGBATexture(
  device: GPUDevice,
  texDims: readonly number[],
): GPUTexture {
  return device.createTexture({
    size: [texDims[0], texDims[1], texDims[2]],
    format: 'rgba8unorm',
    dimension: '3d',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC,
  })
}

/** Write RGBA8 voxels over the whole of an existing 3D texture. */
function writeRGBATexture(
  device: GPUDevice,
  texture: GPUTexture,
  rgbaData: Uint8Array,
  texDims: readonly number[],
): void {
  // writeTexture reads straight from the view; only a SharedArrayBuffer-backed
  // one needs copying first.
  const data =
    typeof SharedArrayBuffer !== 'undefined' &&
    rgbaData.buffer instanceof SharedArrayBuffer
      ? new Uint8Array(rgbaData)
      : rgbaData
  device.queue.writeTexture(
    { texture },
    data as Uint8Array<ArrayBuffer>,
    { bytesPerRow: texDims[0] * 4, rowsPerImage: texDims[1] },
    [texDims[0], texDims[1], texDims[2]],
  )
}

function rgba2Texture(device: GPUDevice, nvimage: NVImage): GPUTexture {
  const { rgbaData, texDims } = prepareRGBAData(nvimage)
  const rgbaTexture = createRGBATexture(device, texDims)
  writeRGBATexture(device, rgbaTexture, rgbaData, texDims)
  return rgbaTexture
}

/**
 * An RGB/RGBA volume's RGBA8 texture, kept across updates so new voxels are
 * written into it instead of a new allocation (see prepareRGBATextureCache).
 */
export type RGBATextureCache = {
  texture: GPUTexture
  texDims: number[]
  /** rgbaTextureKey of the voxels last written. */
  key: string
}

/**
 * Upload an RGB/RGBA volume into `existing`'s texture when its dims still
 * match (queue.writeTexture, no allocation), else into a new texture
 * (destroying the old one). `skipUnchanged` returns `existing` untouched when
 * its rgbaTextureKey still matches; the overlay slot passes false, matching
 * the WebGL2 renderer, whose background masking rewrites that texture.
 */
export function prepareRGBATextureCache(
  device: GPUDevice,
  nvimage: NVImage,
  existing: RGBATextureCache | null,
  skipUnchanged: boolean,
): RGBATextureCache {
  const key = rgbaTextureKey(nvimage)
  if (existing && skipUnchanged && existing.key === key) return existing
  const { rgbaData, texDims } = prepareRGBAData(nvimage)
  let cache = existing
  if (!cache || !dimensionsMatch(cache.texDims, texDims)) {
    destroyRGBATextureCache(existing)
    cache = { texture: createRGBATexture(device, texDims), texDims, key }
  }
  writeRGBATexture(device, cache.texture, rgbaData, texDims)
  cache.key = key
  return cache
}

export function destroyRGBATextureCache(cache: RGBATextureCache | null): void {
  cache?.texture.destroy()
}

function getTextureFormat(nvimage: NVImage): {
  format: GPUTextureFormat
  pipelineType: string
  bytesPerVoxel: number
} {
  const dt = nvimage.hdr.datatypeCode
  if (dt === 2)
    return { format: 'r8uint', pipelineType: 'uint', bytesPerVoxel: 1 }
  if (dt === 4)
    return { format: 'r16sint', pipelineType: 'sint', bytesPerVoxel: 2 }
  if (dt === 8)
    return { format: 'r32sint', pipelineType: 'sint', bytesPerVoxel: 4 }
  if (dt === 16 || dt === 32)
    return { format: 'r32float', pipelineType: 'float', bytesPerVoxel: 4 }
  if (dt === 512)
    return { format: 'r16uint', pipelineType: 'uint', bytesPerVoxel: 2 }
  if (dt === 768)
    return { format: 'r32uint', pipelineType: 'uint', bytesPerVoxel: 4 }
  throw new Error(`Unsupported NIfTI datatype ${dt}`)
}

const _labelColormapIds = new WeakMap<object, number>()
let _nextLabelColormapId = 1

function labelColormapId(colormapLabel: object): number {
  const existing = _labelColormapIds.get(colormapLabel)
  if (existing) return existing
  const id = _nextLabelColormapId++
  _labelColormapIds.set(colormapLabel, id)
  return id
}

function orientColormapKey(nvimage: NVImage, isLabelVol: boolean): string {
  if (isLabelVol) {
    const label = nvimage.colormapLabel
    return label
      ? `label:${labelColormapId(label)}:${labelColormapId(label.lut)}`
      : 'label:none'
  }
  return `${NVCmaps.colormapKey(nvimage.colormap)}:${NVCmaps.colormapKey(nvimage.colormapNegative)}:${nvimage.isColormapInverted ? 1 : 0}`
}

function dimensionsMatch(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function writeOrientUniforms(
  device: GPUDevice,
  uniformBuffer: GPUBuffer,
  nvimage: NVImage,
  mtx: Float32Array,
  overlayOpacity: number,
  mod: ModulationTextureParams | null = null,
): void {
  const ab = new ArrayBuffer(ORIENT_UNIFORM_SIZE)
  const dv = new DataView(ab)
  for (let i = 0; i < 16; i++) dv.setFloat32(i * 4, mtx[i], true)
  const u = buildOrientUniforms(nvimage, overlayOpacity)
  dv.setFloat32(64, u.slope, true)
  dv.setFloat32(68, u.intercept, true)
  dv.setFloat32(72, u.calMin, true)
  dv.setFloat32(76, u.calMax, true)
  dv.setFloat32(80, u.mnNeg, true)
  dv.setFloat32(84, u.mxNeg, true)
  dv.setFloat32(88, u.isAlphaThreshold, true)
  dv.setFloat32(92, u.isColorbarFromZero, true)
  dv.setFloat32(96, u.overlayOpacity, true)
  dv.setFloat32(100, u.isLabel, true)
  dv.setFloat32(104, u.labelMin, true)
  dv.setFloat32(108, u.labelWidth, true)
  // modMtx (offset 112, 4 vec4s) + modFlags (offset 176)
  const modMtx = mod ? mod.mtx : IDENTITY_MTX
  for (let i = 0; i < 16; i++) dv.setFloat32(112 + i * 4, modMtx[i], true)
  dv.setFloat32(176, mod ? mod.mode : 0, true)
  dv.setFloat32(180, u.atlasOutline, true)
  device.queue.writeBuffer(uniformBuffer, 0, ab)
}

export function destroyOrientTextureCache(
  cache: OrientTextureCache | null,
): void {
  if (!cache) return
  cache.sourceTexture.destroy()
  cache.outputTexture.destroy()
  cache.uniformBuffer.destroy()
  cache.colormapTexture.destroy()
  if (cache.hasNegativeColormap) cache.negativeColormapTexture.destroy()
  cache.modTexture.destroy()
}

/** Upload the current frame of `nvimage.img` into the orient source texture. */
function writeSourceTexture(
  device: GPUDevice,
  sourceTexture: GPUTexture,
  nvimage: NVImage,
  dimsIn: number[],
  bytesPerVoxel: number,
): void {
  if (!nvimage.img) throw new Error('overlay2Texture: missing image data')
  const frame4D = nvimage.frame4D ?? 0
  const frameByteOffset = frame4D * nvimage.nVox3D * bytesPerVoxel
  const frameByteLength = nvimage.nVox3D * bytesPerVoxel
  const imgView = new Uint8Array(
    nvimage.img.buffer,
    nvimage.img.byteOffset + frameByteOffset,
    frameByteLength,
  )
  const imgData =
    typeof SharedArrayBuffer !== 'undefined' &&
    imgView.buffer instanceof SharedArrayBuffer
      ? new Uint8Array(imgView)
      : imgView
  device.queue.writeTexture(
    { texture: sourceTexture },
    imgData as Uint8Array<ArrayBuffer>,
    {
      bytesPerRow: Math.floor(dimsIn[0] * bytesPerVoxel),
      rowsPerImage: dimsIn[1],
    },
    dimsIn,
  )
}

export async function prepareOrientTextureCache(
  device: GPUDevice,
  nvimage: NVImage,
  nvimageTarget: NVImage,
  mtx: Float32Array,
  overlayOpacity = 1,
  existingCache: OrientTextureCache | null = null,
  mod: ModulationTextureParams | null = null,
): Promise<OrientTextureCache> {
  mod = supportedModulation(device, mod)
  if (!nvimage.dimsRAS || !nvimageTarget.dimsRAS)
    throw new Error('overlay2Texture: missing dimsRAS')
  if (!nvimage.img) throw new Error('overlay2Texture: missing image data')
  const { format, pipelineType, bytesPerVoxel } = getTextureFormat(nvimage)
  const dimsIn = [nvimage.dims[1], nvimage.dims[2], nvimage.dims[3]]
  const dimsOut = [
    nvimageTarget.dimsRAS[1],
    nvimageTarget.dimsRAS[2],
    nvimageTarget.dimsRAS[3],
  ]
  const frame4D = nvimage.frame4D ?? 0
  const u = buildOrientUniforms(nvimage, overlayOpacity)
  const colormapKey = orientColormapKey(nvimage, u.isLabel > 0)
  const modKey = mod ? mod.key : ''
  const canReuse =
    existingCache &&
    existingCache.datatypeCode === nvimage.hdr.datatypeCode &&
    existingCache.pipelineType === pipelineType &&
    existingCache.frame4D === frame4D &&
    existingCache.imageBuffer === nvimage.img.buffer &&
    dimensionsMatch(existingCache.dimsIn, dimsIn) &&
    dimensionsMatch(existingCache.dimsOut, dimsOut) &&
    existingCache.colormapKey === colormapKey &&
    existingCache.modKey === modKey
  if (canReuse) {
    // Same buffer, but the voxels may have been edited in place
    // (updateVolumeData): rewrite the source texture without reallocating it.
    const dataVersion = nvimage._dataVersion ?? 0
    if (existingCache.dataVersion !== dataVersion) {
      writeSourceTexture(
        device,
        existingCache.sourceTexture,
        nvimage,
        dimsIn,
        bytesPerVoxel,
      )
      existingCache.dataVersion = dataVersion
    }
    writeOrientUniforms(
      device,
      existingCache.uniformBuffer,
      nvimage,
      mtx,
      overlayOpacity,
      mod,
    )
    return existingCache
  }
  destroyOrientTextureCache(existingCache)
  const cached = ensureOrientPipeline(device, pipelineType)
  const sourceTexture = device.createTexture({
    size: dimsIn,
    format,
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  writeSourceTexture(device, sourceTexture, nvimage, dimsIn, bytesPerVoxel)
  // Record what was just uploaded NOW: the colormap uploads below await, and an
  // updateVolumeData landing in that gap bumps the version. Reading it after the
  // awaits would mark those newer voxels as uploaded when they are not.
  const uploadedBuffer = nvimage.img.buffer
  const uploadedVersion = nvimage._dataVersion ?? 0
  const uniformBuffer = device.createBuffer({
    size: ORIENT_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  writeOrientUniforms(device, uniformBuffer, nvimage, mtx, overlayOpacity, mod)
  const modTexture = createModTexture(device, mod)
  const outputTexture = device.createTexture({
    size: dimsOut,
    format: 'rgba8unorm',
    dimension: '3d',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  let colormapTexture: GPUTexture
  let negativeColormapTexture: GPUTexture
  let hasNegativeColormap = false
  let sampler: GPUSampler
  if (u.isLabel > 0) {
    const labelLut = nvimage.colormapLabel?.lut
    if (!labelLut) throw new Error('Label colormap LUT is undefined')
    const nLabels = labelLut.length / 4
    colormapTexture = device.createTexture({
      size: [nLabels, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture: colormapTexture },
      Uint8Array.from(labelLut),
      { bytesPerRow: nLabels * 4, rowsPerImage: 1 },
      [nLabels, 1],
    )
    negativeColormapTexture = colormapTexture
    sampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    })
  } else {
    colormapTexture = await wgpu.lutBytes2texture(
      device,
      NVCmaps.lutrgba8(nvimage.colormap, nvimage.isColormapInverted),
    )
    negativeColormapTexture = colormapTexture
    hasNegativeColormap = !!(
      nvimage.colormapNegative && nvimage.colormapNegative.length > 0
    )
    if (hasNegativeColormap)
      negativeColormapTexture = await wgpu.lutBytes2texture(
        device,
        NVCmaps.lutrgba8(nvimage.colormapNegative, nvimage.isColormapInverted),
      )
    sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  }
  const bindGroup = device.createBindGroup({
    layout: cached.layout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: sourceTexture.createView() },
      { binding: 2, resource: colormapTexture.createView() },
      { binding: 3, resource: outputTexture.createView() },
      { binding: 4, resource: sampler },
      { binding: 5, resource: negativeColormapTexture.createView() },
      { binding: 6, resource: modTexture.createView() },
    ],
  })
  return {
    sourceTexture,
    outputTexture,
    uniformBuffer,
    colormapTexture,
    negativeColormapTexture,
    sampler,
    bindGroup,
    dimsIn,
    dimsOut,
    datatypeCode: nvimage.hdr.datatypeCode,
    frame4D,
    colormapKey,
    imageBuffer: uploadedBuffer,
    dataVersion: uploadedVersion,
    pipelineType,
    hasNegativeColormap,
    modTexture,
    modKey,
  }
}

export function dispatchOrient(
  device: GPUDevice,
  cache: OrientTextureCache,
): void {
  const cached = ensureOrientPipeline(device, cache.pipelineType)
  const [vxOut, vyOut, vzOut] = cache.dimsOut
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(cached.pipeline)
  pass.setBindGroup(0, cache.bindGroup)
  pass.dispatchWorkgroups(
    Math.ceil(vxOut / 8),
    Math.ceil(vyOut / 8),
    Math.ceil(vzOut / 4),
  )
  pass.end()
  device.queue.submit([encoder.finish()])
}

/**
 * Transform a scalar volume to an RGBA8 3D texture by applying a spatial
 * transformation matrix, calibration (slope/intercept), and colormap lookup.
 * Handles both base volumes and overlays via the isOverlay flag.
 * Matches the WebGL2 gl/orientOverlay.ts implementation for identical results.
 */
export async function volume2Texture(
  device: GPUDevice,
  nvimage: NVImage,
  nvimageTarget: NVImage,
  mtx: Float32Array,
  overlayOpacity = 1,
  outDimsOverride?: readonly number[],
  mod: ModulationTextureParams | null = null,
  sharedModTexture: GPUTexture | null = null,
): Promise<GPUTexture> {
  mod = supportedModulation(device, mod)
  if (!nvimage.dimsRAS || !nvimageTarget.dimsRAS) {
    throw new Error('overlay2Texture: missing dimsRAS')
  }
  if (!nvimage.img) {
    throw new Error('overlay2Texture: missing image data')
  }
  const dt = nvimage.hdr.datatypeCode
  // Handle RGB/RGBA images directly (PAQD gets special decode)
  if (dt === 2304 || dt === 128) {
    return rgba2Texture(device, nvimage)
  }
  let format: GPUTextureFormat = 'r8uint'
  let pipelineType = 'uint'
  let bytesPerVoxel = 1
  if (dt === 2) {
    // UINT8
    format = 'r8uint'
  } else if (dt === 4 || dt === 8) {
    // INT16 or INT32
    format = dt === 4 ? 'r16sint' : 'r32sint'
    pipelineType = 'sint'
    bytesPerVoxel = dt === 4 ? 2 : 4
  } else if (dt === 16 || dt === 32) {
    // FLOAT32 or COMPLEX
    format = 'r32float'
    pipelineType = 'float'
    bytesPerVoxel = 4
  } else if (dt === 512 || dt === 768) {
    // UINT16 or UINT32
    format = dt === 512 ? 'r16uint' : 'r32uint'
    bytesPerVoxel = dt === 512 ? 2 : 4
  } else {
    throw new Error(`Unsupported NIfTI datatype ${dt}`)
  }
  const dimsIn = [nvimage.dims[1], nvimage.dims[2], nvimage.dims[3]]
  // Output dims default to the target's RAS grid. A chunked caller passes a
  // chunk's texDims here and a pre-composed mtx (chunkOverlayMatrix) so this
  // same pass renders one chunk-sized sub-texture.
  const dimsOut = outDimsOverride
    ? [outDimsOverride[0], outDimsOverride[1], outDimsOverride[2]]
    : [
        nvimageTarget.dimsRAS[1],
        nvimageTarget.dimsRAS[2],
        nvimageTarget.dimsRAS[3],
      ]
  const [vxOut, vyOut, vzOut] = dimsOut
  const cached = ensureOrientPipeline(device, pipelineType)
  // 1) Upload input scalar texture (offset by frame4D for 4D volumes)
  const scalarTexture = device.createTexture({
    size: dimsIn,
    format: format,
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const frame = nvimage.frame4D ?? 0
  const frameByteOffset = frame * nvimage.nVox3D * bytesPerVoxel
  const frameByteLength = nvimage.nVox3D * bytesPerVoxel
  const imgView = new Uint8Array(
    nvimage.img.buffer,
    nvimage.img.byteOffset + frameByteOffset,
    frameByteLength,
  )
  // Defensive copy: SharedArrayBuffer-backed views would create a TOCTOU race with GPU upload
  const imgData =
    typeof SharedArrayBuffer !== 'undefined' &&
    imgView.buffer instanceof SharedArrayBuffer
      ? new Uint8Array(imgView)
      : imgView
  device.queue.writeTexture(
    { texture: scalarTexture },
    imgData as Uint8Array<ArrayBuffer>,
    {
      bytesPerRow: Math.floor(dimsIn[0] * bytesPerVoxel),
      rowsPerImage: dimsIn[1],
    },
    dimsIn,
  )
  // 2) Prepare uniform buffer (shared layout with the cached orient path).
  const uniformBuffer = device.createBuffer({
    size: ORIENT_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  writeOrientUniforms(device, uniformBuffer, nvimage, mtx, overlayOpacity, mod)
  const isLabelVol = buildOrientUniforms(nvimage, overlayOpacity).isLabel > 0
  const modTexture = sharedModTexture ?? createModTexture(device, mod)
  // 3) Create RGBA storage texture sized dimsOut
  const rgbaTexture = device.createTexture({
    size: dimsOut,
    format: 'rgba8unorm',
    dimension: '3d',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  // 4) Colormap textures and sampler
  let colormapTex: GPUTexture
  let negColormapTex: GPUTexture
  let hasNegColormap = false
  let sampler: GPUSampler
  if (isLabelVol) {
    // Label colormap: variable-width LUT with nearest filtering
    const labelLut = nvimage.colormapLabel?.lut
    if (!labelLut) {
      throw new Error('Label colormap LUT is undefined')
    }
    const nLabels = labelLut.length / 4
    colormapTex = device.createTexture({
      size: [nLabels, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture: colormapTex },
      Uint8Array.from(labelLut),
      { bytesPerRow: nLabels * 4, rowsPerImage: 1 },
      [nLabels, 1],
    )
    negColormapTex = colormapTex
    sampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    })
  } else {
    // Continuous colormap: 256-wide LUT with linear filtering
    const lut = NVCmaps.lutrgba8(nvimage.colormap, nvimage.isColormapInverted)
    colormapTex = await wgpu.lutBytes2texture(device, lut)
    negColormapTex = colormapTex
    hasNegColormap = !!(
      nvimage.colormapNegative && nvimage.colormapNegative.length > 0
    )
    if (hasNegColormap) {
      const negLut = NVCmaps.lutrgba8(
        nvimage.colormapNegative,
        nvimage.isColormapInverted,
      )
      negColormapTex = await wgpu.lutBytes2texture(device, negLut)
    }
    sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
  }
  // 5) Create bind group
  const bindGroup = device.createBindGroup({
    layout: cached.layout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: scalarTexture.createView() },
      { binding: 2, resource: colormapTex.createView() },
      { binding: 3, resource: rgbaTexture.createView() },
      { binding: 4, resource: sampler },
      { binding: 5, resource: negColormapTex.createView() },
      { binding: 6, resource: modTexture.createView() },
    ],
  })
  // 6) Dispatch compute with dimsOut
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(cached.pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(
    Math.ceil(vxOut / 8),
    Math.ceil(vyOut / 8),
    Math.ceil(vzOut / 4),
  )
  pass.end()
  device.queue.submit([encoder.finish()])
  await device.queue.onSubmittedWorkDone()
  // Cleanup intermediate resources (keep rgbaTexture for caller)
  scalarTexture.destroy()
  if (!sharedModTexture) modTexture.destroy()
  colormapTex.destroy()
  if (hasNegColormap) {
    negColormapTex.destroy()
  }
  uniformBuffer.destroy()
  return rgbaTexture
}

/**
 * Build one RGBA8 overlay texture per chunk for a chunked oversized volume.
 *
 * Each chunk is oriented independently: the output texture is sized to the
 * chunk's `texDims` (halo included) and `volume2Texture` runs with the matrix
 * from `chunkOverlayMatrix`, which folds the chunk-local -> full-volume affine
 * lift into the overlay matrix. The per-chunk textures align 1:1 with the
 * volume chunks (shared ChunkPlan), so the renderer's per-chunk uniforms and
 * `chunkTexCoord` sample them seam-free. Returns one texture per `plan.chunks`.
 *
 * `mod` is the overlay's full-volume modulation (see `buildModulationParams`);
 * its matrix is re-targeted per chunk with `chunkModulationParams` so the
 * modulator is sampled at the same voxels the whole-volume path would use.
 */
export async function overlay2TextureChunked(
  device: GPUDevice,
  nvimage: NVImage,
  nvimageTarget: NVImage,
  mtx: Float32Array,
  plan: ChunkPlan,
  overlayOpacity = 1,
  mod: ModulationTextureParams | null = null,
): Promise<GPUTexture[]> {
  mod = supportedModulation(device, mod)
  const [dx, dy, dz] = plan.volumeDims
  const out: GPUTexture[] = []
  const sharedModTexture = mod ? createModTexture(device, mod) : null
  try {
    for (const desc of plan.chunks) {
      const [ox, oy, oz] = desc.texOrigin
      const [sx, sy, sz] = desc.texDims
      const scale = [sx / dx, sy / dy, sz / dz]
      const offset = [ox / dx, oy / dy, oz / dz]
      out.push(
        await volume2Texture(
          device,
          nvimage,
          nvimageTarget,
          chunkOverlayMatrix(mtx, scale, offset),
          overlayOpacity,
          desc.texDims,
          chunkModulationParams(mod, scale, offset),
          sharedModTexture,
        ),
      )
    }
  } finally {
    sharedModTexture?.destroy()
  }
  return out
}

const maskShaderCode = `
@group(0) @binding(0) var background: texture_3d<f32>;
@group(0) @binding(1) var overlayIn: texture_3d<f32>;
@group(0) @binding(2) var overlayOut: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dims = textureDimensions(background, 0);
    if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) { return; }
    let coord = vec3i(gid);
    let bg = textureLoad(background, coord, 0);
    let ov = textureLoad(overlayIn, coord, 0);
    if (bg.a == 0.0) {
        textureStore(overlayOut, coord, vec4f(ov.rgb, 0.0));
    } else {
        textureStore(overlayOut, coord, ov);
    }
}
`

function ensureMaskPipeline(device: GPUDevice): PipelineCacheEntry {
  let perDevice = _deviceCache.get(device)
  if (!perDevice) {
    perDevice = {}
    _deviceCache.set(device, perDevice)
  }
  if (perDevice.mask) {
    return perDevice.mask
  }
  const module = device.createShaderModule({ code: maskShaderCode })
  const layout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { viewDimension: '3d' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { viewDimension: '3d' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { format: 'rgba8unorm', viewDimension: '3d' },
      },
    ],
  })
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: 'main' },
  })
  perDevice.mask = { pipeline, layout }
  return perDevice.mask
}

/**
 * Mask overlay texture by background volume: zero out overlay alpha wherever
 * the background volume alpha is zero. Returns a new texture; the input is
 * left alone, since an orient or RGBA cache may own it and write to it again.
 */
export async function maskOverlayByBackground(
  device: GPUDevice,
  volumeTexture: GPUTexture,
  overlayTexture: GPUTexture,
): Promise<GPUTexture> {
  const dims = [
    overlayTexture.width,
    overlayTexture.height,
    overlayTexture.depthOrArrayLayers,
  ]
  const cached = ensureMaskPipeline(device)
  const outputTexture = device.createTexture({
    size: dims,
    format: 'rgba8unorm',
    dimension: '3d',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  const bindGroup = device.createBindGroup({
    layout: cached.layout,
    entries: [
      { binding: 0, resource: volumeTexture.createView() },
      { binding: 1, resource: overlayTexture.createView() },
      { binding: 2, resource: outputTexture.createView() },
    ],
  })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(cached.pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(
    Math.ceil(dims[0] / 8),
    Math.ceil(dims[1] / 8),
    Math.ceil(dims[2] / 4),
  )
  pass.end()
  device.queue.submit([encoder.finish()])
  await device.queue.onSubmittedWorkDone()
  return outputTexture
}

export function destroy(device: GPUDevice): void {
  _deviceCache.delete(device)
  _blendCache.delete(device)
}

// ---------------------------------------------------------------------------
// Multi-overlay GPU blend
// ---------------------------------------------------------------------------

// Five f32 per voxel of blend accumulator (see blendAccumShaderCode)
const BLEND_BYTES_PER_VOXEL = 20

function blendBufferBudget(limits: GPUSupportedLimits): number {
  return Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize)
}

/** Largest w = h whose blend accumulator slice (w * h voxels) fits the device. */
export function maxBlendSliceDim(limits: GPUSupportedLimits): number {
  return Math.floor(
    Math.sqrt(blendBufferBudget(limits) / BLEND_BYTES_PER_VOXEL),
  )
}

// Accumulator per voxel: premultiplied colour sum P.rgb, alpha sum S, then max
// alpha (MAX) or union alpha 1 - prod(1 - a) (OVER). Same math as the CPU
// blendOverlayData; ALPHA_BLEND / COLOR_BLEND are OVERLAY_*_BLEND values.
const blendAccumShaderCode = `
override ALPHA_BLEND: u32 = 0u;
struct Slab { z0: u32, zCount: u32 }
@group(0) @binding(0) var<storage, read_write> accum: array<f32>;
@group(0) @binding(1) var<uniform> slab: Slab;
@group(1) @binding(0) var overlay: texture_3d<f32>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dims = textureDimensions(overlay);
    if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= slab.zCount) { return; }
    let rgba = textureLoad(overlay, vec3i(vec3u(gid.xy, gid.z + slab.z0)), 0);
    let a = rgba.a;
    if (a <= 0.0) { return; }
    let k = (gid.x + gid.y * dims.x + gid.z * dims.x * dims.y) * 5u;
    accum[k] += rgba.r * a;
    accum[k + 1u] += rgba.g * a;
    accum[k + 2u] += rgba.b * a;
    accum[k + 3u] += a;
    let u = accum[k + 4u];
    accum[k + 4u] = select(max(u, a), u + a - u * a, ALPHA_BLEND == 2u);
}
`

const blendNormShaderCode = `
override ALPHA_BLEND: u32 = 0u;
override COLOR_BLEND: u32 = 0u;
struct Slab { z0: u32, zCount: u32 }
@group(0) @binding(0) var<storage, read_write> accum: array<f32>;
@group(0) @binding(1) var<uniform> slab: Slab;
@group(1) @binding(0) var output: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dims = textureDimensions(output);
    if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= slab.zCount) { return; }
    let pos = vec3i(vec3u(gid.xy, gid.z + slab.z0));
    let k = (gid.x + gid.y * dims.x + gid.z * dims.x * dims.y) * 5u;
    let sum = accum[k + 3u];
    if (sum <= 0.0) {
        textureStore(output, pos, vec4f(0.0));
        return;
    }
    let a = select(accum[k + 4u], min(sum, 1.0), ALPHA_BLEND == 1u);
    let norm = select(a, sum, COLOR_BLEND == 1u);
    let rgb = clamp(vec3f(accum[k], accum[k + 1u], accum[k + 2u]) / norm, vec3f(0.0), vec3f(1.0));
    textureStore(output, pos, vec4f(rgb, a));
}
`

// Per device: shared layouts and shader modules, plus pipelines keyed by
// alphaBlend * 2 + colorBlend. The norm pass reuses the accum layout.
type BlendDeviceCache = {
  layoutAccum: GPUBindGroupLayout
  layoutOverlay: GPUBindGroupLayout
  layoutOutput: GPUBindGroupLayout
  accumModule: GPUShaderModule
  normModule: GPUShaderModule
  pipelines: Map<
    number,
    { accumPipeline: GPUComputePipeline; normPipeline: GPUComputePipeline }
  >
}
const _blendCache = new WeakMap<GPUDevice, BlendDeviceCache>()

function ensureBlendPipelines(
  device: GPUDevice,
  alphaBlend: number,
  colorBlend: number,
): BlendDeviceCache & {
  accumPipeline: GPUComputePipeline
  normPipeline: GPUComputePipeline
} {
  // Unknown values fall back to MAX / ADDITIVE as in the CPU path; this also
  // keeps override constants valid u32s and the cache bounded to six entries.
  if (
    alphaBlend !== OVERLAY_ALPHA_BLEND.ADDITIVE &&
    alphaBlend !== OVERLAY_ALPHA_BLEND.OVER
  )
    alphaBlend = OVERLAY_ALPHA_BLEND.MAX
  if (colorBlend !== OVERLAY_COLOR_BLEND.MEAN)
    colorBlend = OVERLAY_COLOR_BLEND.ADDITIVE
  let dev = _blendCache.get(device)
  if (!dev) {
    const visibility = GPUShaderStage.COMPUTE
    dev = {
      layoutAccum: device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility, buffer: { type: 'storage' } },
          { binding: 1, visibility, buffer: { type: 'uniform' } },
        ],
      }),
      layoutOverlay: device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility,
            texture: { sampleType: 'float', viewDimension: '3d' },
          },
        ],
      }),
      layoutOutput: device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility,
            storageTexture: { format: 'rgba8unorm', viewDimension: '3d' },
          },
        ],
      }),
      accumModule: device.createShaderModule({ code: blendAccumShaderCode }),
      normModule: device.createShaderModule({ code: blendNormShaderCode }),
      pipelines: new Map(),
    }
    _blendCache.set(device, dev)
  }
  const key = alphaBlend * 2 + colorBlend
  let pipes = dev.pipelines.get(key)
  if (!pipes) {
    pipes = {
      accumPipeline: device.createComputePipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [dev.layoutAccum, dev.layoutOverlay],
        }),
        compute: {
          module: dev.accumModule,
          entryPoint: 'main',
          constants: { ALPHA_BLEND: alphaBlend },
        },
      }),
      normPipeline: device.createComputePipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [dev.layoutAccum, dev.layoutOutput],
        }),
        compute: {
          module: dev.normModule,
          entryPoint: 'main',
          constants: { ALPHA_BLEND: alphaBlend, COLOR_BLEND: colorBlend },
        },
      }),
    }
    dev.pipelines.set(key, pipes)
  }
  return { ...dev, ...pipes }
}

/**
 * Blend multiple pre-colormapped RGBA8 overlay textures into one on the GPU.
 * Same formulas as CPU blendOverlayData (see there); all commutative, so
 * overlay order does not affect the result.
 * Eliminates the GPU→CPU readback stall of the legacy path.
 */
export async function blendOverlaysGPU(
  device: GPUDevice,
  overlayTextures: GPUTexture[],
  dimsOut: number[],
  alphaBlend: number,
  colorBlend: number,
): Promise<GPUTexture> {
  const [w, h, d] = dimsOut
  const cache = ensureBlendPipelines(device, alphaBlend, colorBlend)
  const outputTex = device.createTexture({
    size: dimsOut,
    format: 'rgba8unorm',
    dimension: '3d',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  const outputBG = device.createBindGroup({
    layout: cache.layoutOutput,
    entries: [{ binding: 0, resource: outputTex.createView() }],
  })
  const overlayBGs = overlayTextures.map((tex) =>
    device.createBindGroup({
      layout: cache.layoutOverlay,
      entries: [{ binding: 0, resource: tex.createView() }],
    }),
  )
  // Blend in z-slabs sized to the device buffer limits; typical volumes and
  // chunks are one slab. NVViewGPU caps the chunk threshold at
  // maxBlendSliceDim so one slice fits for plans it builds; caller-supplied
  // chunk plans are not capped, hence the floor of one slice.
  const sliceBytes = w * h * BLEND_BYTES_PER_VOXEL
  const budget = blendBufferBudget(device.limits)
  const slabDepth = Math.max(1, Math.min(d, Math.floor(budget / sliceBytes)))
  // Zero-initialized by the WebGPU spec; cleared again before later slabs
  const accumBuffer = device.createBuffer({
    size: sliceBytes * slabDepth,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  const slabBuffer = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const accumBG = device.createBindGroup({
    layout: cache.layoutAccum,
    entries: [
      { binding: 0, resource: { buffer: accumBuffer } },
      { binding: 1, resource: { buffer: slabBuffer } },
    ],
  })
  const nx = Math.ceil(w / 8)
  const ny = Math.ceil(h / 8)
  for (let z0 = 0; z0 < d; z0 += slabDepth) {
    const zCount = Math.min(slabDepth, d - z0)
    const nz = Math.ceil(zCount / 4)
    // One submit per slab: queue order lands this write before its passes
    device.queue.writeBuffer(slabBuffer, 0, new Uint32Array([z0, zCount]))
    const encoder = device.createCommandEncoder()
    if (z0 > 0) encoder.clearBuffer(accumBuffer)
    // One compute pass per overlay so inter-pass barriers guarantee read-after-write ordering
    for (const overlayBG of overlayBGs) {
      const pass = encoder.beginComputePass()
      pass.setPipeline(cache.accumPipeline)
      pass.setBindGroup(0, accumBG)
      pass.setBindGroup(1, overlayBG)
      pass.dispatchWorkgroups(nx, ny, nz)
      pass.end()
    }
    const normPass = encoder.beginComputePass()
    normPass.setPipeline(cache.normPipeline)
    normPass.setBindGroup(0, accumBG)
    normPass.setBindGroup(1, outputBG)
    normPass.dispatchWorkgroups(nx, ny, nz)
    normPass.end()
    device.queue.submit([encoder.finish()])
  }
  // Only read by GPU commands already submitted above; destroy is safe after
  // submit since the GPU retains internal references
  accumBuffer.destroy()
  slabBuffer.destroy()
  return outputTex
}
