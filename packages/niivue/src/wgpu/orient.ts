import * as NVCmaps from '@/cmap/NVCmaps'
import type { NVImage } from '@/NVTypes'
import { buildOrientUniforms, prepareRGBAData } from '@/view/NVOrient'
import orientWGSL from './orient.wgsl?raw'
import * as wgpu from './wgpu'

type PipelineCacheEntry = {
  pipeline: GPUComputePipeline
  layout: GPUBindGroupLayout
}
const _deviceCache = new WeakMap<
  GPUDevice,
  Record<string, PipelineCacheEntry>
>()

function ensurePipeline(
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
  pipelineType: string
  hasNegativeColormap: boolean
}

function rgba2Texture(device: GPUDevice, nvimage: NVImage): GPUTexture {
  const { rgbaData, texDims } = prepareRGBAData(nvimage)
  const rgbaTexture = device.createTexture({
    size: texDims,
    format: 'rgba8unorm',
    dimension: '3d',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC,
  })
  device.queue.writeTexture(
    { texture: rgbaTexture },
    new Uint8Array(rgbaData),
    { bytesPerRow: texDims[0] * 4, rowsPerImage: texDims[1] },
    texDims,
  )
  return rgbaTexture
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

function orientColormapKey(nvimage: NVImage, isLabelVol: boolean): string {
  if (isLabelVol) {
    return `label:${nvimage.colormapLabel?.lut.length ?? 0}:${nvimage.colormapLabel?.min ?? 0}:${nvimage.colormapLabel?.max ?? 0}`
  }
  return `${nvimage.colormap}:${nvimage.colormapNegative ?? ''}`
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
): void {
  const uniformBufferSize = 7 * 16
  const ab = new ArrayBuffer(uniformBufferSize)
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
}

export async function prepareOrientTextureCache(
  device: GPUDevice,
  nvimage: NVImage,
  nvimageTarget: NVImage,
  mtx: Float32Array,
  overlayOpacity = 1,
  existingCache: OrientTextureCache | null = null,
): Promise<OrientTextureCache> {
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
  const canReuse =
    existingCache &&
    existingCache.datatypeCode === nvimage.hdr.datatypeCode &&
    existingCache.pipelineType === pipelineType &&
    existingCache.frame4D === frame4D &&
    existingCache.imageBuffer === nvimage.img.buffer &&
    dimensionsMatch(existingCache.dimsIn, dimsIn) &&
    dimensionsMatch(existingCache.dimsOut, dimsOut) &&
    existingCache.colormapKey === colormapKey
  if (canReuse) {
    writeOrientUniforms(
      device,
      existingCache.uniformBuffer,
      nvimage,
      mtx,
      overlayOpacity,
    )
    return existingCache
  }
  destroyOrientTextureCache(existingCache)
  const cached = ensurePipeline(device, pipelineType)
  const sourceTexture = device.createTexture({
    size: dimsIn,
    format,
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
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
  const uniformBuffer = device.createBuffer({
    size: 7 * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  writeOrientUniforms(device, uniformBuffer, nvimage, mtx, overlayOpacity)
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
      NVCmaps.lutrgba8(nvimage.colormap),
    )
    negativeColormapTexture = colormapTexture
    hasNegativeColormap = !!(
      nvimage.colormapNegative && nvimage.colormapNegative.length > 0
    )
    if (hasNegativeColormap)
      negativeColormapTexture = await wgpu.lutBytes2texture(
        device,
        NVCmaps.lutrgba8(nvimage.colormapNegative),
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
    imageBuffer: nvimage.img.buffer,
    pipelineType,
    hasNegativeColormap,
  }
}

export function dispatchOrient(
  device: GPUDevice,
  cache: OrientTextureCache,
): void {
  const cached = ensurePipeline(device, cache.pipelineType)
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
): Promise<GPUTexture> {
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
  const dimsOut = [
    nvimageTarget.dimsRAS[1],
    nvimageTarget.dimsRAS[2],
    nvimageTarget.dimsRAS[3],
  ]
  const [vxOut, vyOut, vzOut] = dimsOut
  const cached = ensurePipeline(device, pipelineType)
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
  // 2) Prepare uniform buffer (7 vec4s = 112 bytes)
  const uniformBufferSize = 7 * 16
  const uniformBuffer = device.createBuffer({
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const ab = new ArrayBuffer(uniformBufferSize)
  const dv = new DataView(ab)
  // Matrix rows (4 vec4s, 64 bytes)
  for (let i = 0; i < 16; i++) {
    dv.setFloat32(i * 4, mtx[i], true)
  }
  // params + negParams + flags (3 vec4s = 48 bytes at offset 64)
  const u = buildOrientUniforms(nvimage, overlayOpacity)
  const isLabelVol = u.isLabel > 0
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
  device.queue.writeBuffer(uniformBuffer, 0, ab)
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
    const lut = NVCmaps.lutrgba8(nvimage.colormap)
    colormapTex = await wgpu.lutBytes2texture(device, lut)
    negColormapTex = colormapTex
    hasNegColormap = !!(
      nvimage.colormapNegative && nvimage.colormapNegative.length > 0
    )
    if (hasNegColormap) {
      const negLut = NVCmaps.lutrgba8(nvimage.colormapNegative)
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
  colormapTex.destroy()
  if (hasNegColormap) {
    negColormapTex.destroy()
  }
  uniformBuffer.destroy()
  return rgbaTexture
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
 * the background volume alpha is zero. Returns a new texture (old overlay is destroyed).
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
  overlayTexture.destroy()
  return outputTexture
}

/**
 * Read a 3D RGBA8 texture back to CPU as a Uint8Array.
 * Used for multi-overlay blending where intermediate textures must be combined on CPU.
 */
export async function readTexture3D(
  device: GPUDevice,
  texture: GPUTexture,
  dims: number[],
): Promise<Uint8Array> {
  const [w, h, d] = dims
  // WebGPU requires bytesPerRow to be a multiple of 256
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256
  const bufferSize = bytesPerRow * h * d
  const stagingBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: stagingBuffer, bytesPerRow, rowsPerImage: h },
    [w, h, d],
  )
  device.queue.submit([encoder.finish()])
  await stagingBuffer.mapAsync(GPUMapMode.READ)
  const mapped = new Uint8Array(stagingBuffer.getMappedRange())
  const result = new Uint8Array(w * h * d * 4)
  if (bytesPerRow === w * 4) {
    result.set(mapped.subarray(0, result.length))
  } else {
    for (let z = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        const srcOff = (z * h + y) * bytesPerRow
        const dstOff = (z * h + y) * w * 4
        result.set(mapped.subarray(srcOff, srcOff + w * 4), dstOff)
      }
    }
  }
  stagingBuffer.unmap()
  stagingBuffer.destroy()
  return result
}

export function destroy(device: GPUDevice): void {
  _deviceCache.delete(device)
  _blendCache.delete(device)
}

// ---------------------------------------------------------------------------
// Multi-overlay GPU blend
// ---------------------------------------------------------------------------

const blendAccumShaderCode = `
@group(0) @binding(0) var<storage, read_write> accum: array<vec4f>;
@group(1) @binding(0) var overlay: texture_3d<f32>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dims = textureDimensions(overlay);
    if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) { return; }
    let rgba = textureLoad(overlay, vec3i(gid), 0);
    let a = rgba.a;
    if (a <= 0.0) { return; }
    let idx = gid.x + gid.y * dims.x + gid.z * dims.x * dims.y;
    var cur = accum[idx];
    accum[idx] = vec4f(cur.x + rgba.x * a, cur.y + rgba.y * a, cur.z + rgba.z * a, max(cur.w, a));
}
`

const blendNormShaderCode = `
@group(0) @binding(0) var<storage, read> accum: array<vec4f>;
@group(1) @binding(0) var output: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dims = textureDimensions(output);
    if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) { return; }
    let idx = gid.x + gid.y * dims.x + gid.z * dims.x * dims.y;
    let acc = accum[idx];
    let a = acc.w;
    if (a <= 0.0) {
        textureStore(output, vec3i(gid), vec4f(0.0));
        return;
    }
    let rgb = clamp(acc.xyz / a, vec3f(0.0), vec3f(1.0));
    textureStore(output, vec3i(gid), vec4f(rgb, clamp(a, 0.0, 1.0)));
}
`

type BlendPipelineCache = {
  accumPipeline: GPUComputePipeline
  normPipeline: GPUComputePipeline
  layoutAccumBuf: GPUBindGroupLayout
  layoutNormBuf: GPUBindGroupLayout
  layoutOverlay: GPUBindGroupLayout
  layoutOutput: GPUBindGroupLayout
}
const _blendCache = new WeakMap<GPUDevice, BlendPipelineCache>()

function ensureBlendPipelines(device: GPUDevice): BlendPipelineCache {
  const cached = _blendCache.get(device)
  if (cached) return cached
  const layoutAccumBuf = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
    ],
  })
  const layoutNormBuf = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'read-only-storage' },
      },
    ],
  })
  const layoutOverlay = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float', viewDimension: '3d' },
      },
    ],
  })
  const layoutOutput = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { format: 'rgba8unorm', viewDimension: '3d' },
      },
    ],
  })
  const accumPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [layoutAccumBuf, layoutOverlay],
    }),
    compute: {
      module: device.createShaderModule({ code: blendAccumShaderCode }),
      entryPoint: 'main',
    },
  })
  const normPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [layoutNormBuf, layoutOutput],
    }),
    compute: {
      module: device.createShaderModule({ code: blendNormShaderCode }),
      entryPoint: 'main',
    },
  })
  const entry: BlendPipelineCache = {
    accumPipeline,
    normPipeline,
    layoutAccumBuf,
    layoutNormBuf,
    layoutOverlay,
    layoutOutput,
  }
  _blendCache.set(device, entry)
  return entry
}

/**
 * Blend multiple pre-colormapped RGBA8 overlay textures into one on the GPU.
 * Uses additive premultiplied color + max-alpha (same formula as CPU blendOverlayData).
 * This formula is commutative, so overlay order does not affect the result.
 * Eliminates the GPU→CPU readback stall of the legacy path.
 */
export async function blendOverlaysGPU(
  device: GPUDevice,
  overlayTextures: GPUTexture[],
  dimsOut: number[],
): Promise<GPUTexture> {
  const [w, h, d] = dimsOut
  const cache = ensureBlendPipelines(device)

  // Float32 RGBA accumulation buffer — zero-initialized by WebGPU spec
  const accumBuffer = device.createBuffer({
    size: w * h * d * 16,
    usage: GPUBufferUsage.STORAGE,
  })
  const accumBG = device.createBindGroup({
    layout: cache.layoutAccumBuf,
    entries: [{ binding: 0, resource: { buffer: accumBuffer } }],
  })

  const encoder = device.createCommandEncoder()

  // One compute pass per overlay so inter-pass barriers guarantee read-after-write ordering
  for (const tex of overlayTextures) {
    const overlayBG = device.createBindGroup({
      layout: cache.layoutOverlay,
      entries: [{ binding: 0, resource: tex.createView() }],
    })
    const pass = encoder.beginComputePass()
    pass.setPipeline(cache.accumPipeline)
    pass.setBindGroup(0, accumBG)
    pass.setBindGroup(1, overlayBG)
    pass.dispatchWorkgroups(
      Math.ceil(w / 8),
      Math.ceil(h / 8),
      Math.ceil(d / 4),
    )
    pass.end()
  }

  const outputTex = device.createTexture({
    size: dimsOut,
    format: 'rgba8unorm',
    dimension: '3d',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  const normBG = device.createBindGroup({
    layout: cache.layoutNormBuf,
    entries: [{ binding: 0, resource: { buffer: accumBuffer } }],
  })
  const outputBG = device.createBindGroup({
    layout: cache.layoutOutput,
    entries: [{ binding: 0, resource: outputTex.createView() }],
  })
  const normPass = encoder.beginComputePass()
  normPass.setPipeline(cache.normPipeline)
  normPass.setBindGroup(0, normBG)
  normPass.setBindGroup(1, outputBG)
  normPass.dispatchWorkgroups(
    Math.ceil(w / 8),
    Math.ceil(h / 8),
    Math.ceil(d / 4),
  )
  normPass.end()

  device.queue.submit([encoder.finish()])
  // accumBuffer is only read by GPU commands already submitted above;
  // destroy is safe after submit since the GPU retains internal references
  accumBuffer.destroy()
  return outputTex
}
