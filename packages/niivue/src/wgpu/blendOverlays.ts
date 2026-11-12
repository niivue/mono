// Multi-overlay GPU blend (WebGPU): blendOverlaysGPU, used by the whole-volume
// overlay pass and the streamed channel-stack fuse. Mirrored by
// gl/blendOverlays.ts; same math as the CPU blendOverlayData.
import { OVERLAY_ALPHA_BLEND, OVERLAY_COLOR_BLEND } from '@/NVConstants'

// Six f32 per voxel of blend accumulator (see blendAccumShaderCode)
const BLEND_BYTES_PER_VOXEL = 24

function blendBufferBudget(limits: GPUSupportedLimits): number {
  return Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize)
}

/** Largest w = h whose blend accumulator slice (w * h voxels) fits the device. */
export function maxBlendSliceDim(limits: GPUSupportedLimits): number {
  return Math.floor(
    Math.sqrt(blendBufferBudget(limits) / BLEND_BYTES_PER_VOXEL),
  )
}

// Accumulator per voxel: premultiplied colour P.rgb (composited in order for
// colour OVER, a per-component max for colour MAX), alpha sum S, max alpha M and union alpha 1 - prod(1 - a). Same
// math as the CPU blendOverlayData; ALPHA_BLEND / COLOR_BLEND are
// OVERLAY_*_BLEND values. One pass per overlay keeps the order.
const blendAccumShaderCode = `
override COLOR_BLEND: u32 = 0u;
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
    let k = (gid.x + gid.y * dims.x + gid.z * dims.x * dims.y) * 6u;
    if (COLOR_BLEND == 3u) {
        accum[k] = max(accum[k], rgba.r * a);
        accum[k + 1u] = max(accum[k + 1u], rgba.g * a);
        accum[k + 2u] = max(accum[k + 2u], rgba.b * a);
    } else {
        let keep = select(1.0, 1.0 - a, COLOR_BLEND == 2u);
        accum[k] = accum[k] * keep + rgba.r * a;
        accum[k + 1u] = accum[k + 1u] * keep + rgba.g * a;
        accum[k + 2u] = accum[k + 2u] * keep + rgba.b * a;
    }
    accum[k + 3u] += a;
    accum[k + 4u] = max(accum[k + 4u], a);
    let u = accum[k + 5u];
    accum[k + 5u] = u + a - u * a;
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
    let k = (gid.x + gid.y * dims.x + gid.z * dims.x * dims.y) * 6u;
    let sum = accum[k + 3u];
    if (sum <= 0.0) {
        textureStore(output, pos, vec4f(0.0));
        return;
    }
    let m = accum[k + 4u];
    let u = accum[k + 5u];
    let a = select(select(m, min(sum, 1.0), ALPHA_BLEND == 1u), u, ALPHA_BLEND == 2u);
    let norm = select(select(a, sum, COLOR_BLEND == 1u), u, COLOR_BLEND == 2u);
    let rgb = clamp(vec3f(accum[k], accum[k + 1u], accum[k + 2u]) / norm, vec3f(0.0), vec3f(1.0));
    textureStore(output, pos, vec4f(rgb, a));
}
`

// Per device: shared layouts and shader modules, plus the accum pipelines
// keyed by colorBlend (the only override the accum shader reads) and the norm
// pipelines by alphaBlend * 4 + colorBlend. The norm pass reuses the accum
// layout.
type BlendDeviceCache = {
  layoutAccum: GPUBindGroupLayout
  layoutOverlay: GPUBindGroupLayout
  layoutOutput: GPUBindGroupLayout
  accumModule: GPUShaderModule
  normModule: GPUShaderModule
  accumPipelines: Map<number, GPUComputePipeline>
  normPipelines: Map<number, GPUComputePipeline>
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
  // keeps override constants valid u32s and the cache bounded to four accum and
  // twelve norm pipelines.
  if (
    alphaBlend !== OVERLAY_ALPHA_BLEND.ADDITIVE &&
    alphaBlend !== OVERLAY_ALPHA_BLEND.UNION
  )
    alphaBlend = OVERLAY_ALPHA_BLEND.MAX
  if (
    colorBlend !== OVERLAY_COLOR_BLEND.MEAN &&
    colorBlend !== OVERLAY_COLOR_BLEND.OVER &&
    colorBlend !== OVERLAY_COLOR_BLEND.MAX
  )
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
      accumPipelines: new Map(),
      normPipelines: new Map(),
    }
    _blendCache.set(device, dev)
  }
  let accumPipeline = dev.accumPipelines.get(colorBlend)
  if (!accumPipeline) {
    accumPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [dev.layoutAccum, dev.layoutOverlay],
      }),
      compute: {
        module: dev.accumModule,
        entryPoint: 'main',
        constants: { COLOR_BLEND: colorBlend },
      },
    })
    dev.accumPipelines.set(colorBlend, accumPipeline)
  }
  const normKey = alphaBlend * 4 + colorBlend
  let normPipeline = dev.normPipelines.get(normKey)
  if (!normPipeline) {
    normPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [dev.layoutAccum, dev.layoutOutput],
      }),
      compute: {
        module: dev.normModule,
        entryPoint: 'main',
        constants: { ALPHA_BLEND: alphaBlend, COLOR_BLEND: colorBlend },
      },
    })
    dev.normPipelines.set(normKey, normPipeline)
  }
  return { ...dev, accumPipeline, normPipeline }
}

/**
 * Blend multiple pre-colormapped RGBA8 overlay textures into one on the GPU.
 * Same formulas as CPU blendOverlayData (see there); only colour OVER depends
 * on overlay order.
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

/** Forget this device's blend pipelines (orient.ts destroy calls it). */
export function destroyBlend(device: GPUDevice): void {
  _blendCache.delete(device)
}
