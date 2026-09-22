import * as NVCmaps from '@/cmap/NVCmaps'
import { applyCORS } from '@/NVLoader'
import {
  GRAD_EPS,
  GRAD_SCALE,
  GRAD_SHIFT,
  SOBEL_RADIUS,
} from '@/view/NVGradient'
import sobelWGSL from './sobel.wgsl?raw'

// --- per-device cached pipelines ---
interface GradientPipelines {
  blurPipeline: GPUComputePipeline
  sobelPipeline: GPUComputePipeline
  sampler: GPUSampler
}
const _deviceCache = new WeakMap<GPUDevice, GradientPipelines>()

// ensure the gradient pipeline exists and is cached for this device
function ensureComputePipelines(device: GPUDevice): GradientPipelines {
  let cached = _deviceCache.get(device)
  if (cached) return cached
  const module = device.createShaderModule({ code: sobelWGSL })
  const pipeline = (entryPoint: 'blur' | 'sobel') =>
    device.createComputePipeline({
      layout: 'auto',
      compute: {
        module,
        entryPoint,
        // Pipeline-overridable constants rather than string-interpolated
        // literals, so this and the GLSL in gl/gradient.ts read the same
        // numbers from view/NVGradient.ts by construction.
        constants: {
          sobelRadius: SOBEL_RADIUS,
          gradEps: GRAD_EPS,
          gradShift: GRAD_SHIFT,
          gradScale: GRAD_SCALE,
        },
      },
    })
  // LINEAR + clamp-to-edge, matching the filtering and wrap gl/gradient.ts
  // sets on its input texture. The filtering makes each fractional corner tap
  // a trilinear blend, so it is load-bearing, not a default.
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  })
  cached = {
    blurPipeline: pipeline('blur'),
    sobelPipeline: pipeline('sobel'),
    sampler,
  }
  _deviceCache.set(device, cached)
  return cached
}

/**
 * Await-free gradient build, for callers that cannot be async.
 *
 * The `await onSubmittedWorkDone()` in the async wrapper below is a
 * synchronisation convenience, not a correctness requirement: the compute pass
 * and every later render pass that samples its output go on the same queue, so
 * the queue already orders the write before the read. This variant encodes and
 * submits exactly the same work and hands back the texture immediately, which
 * is what lets the per-frame lazy fill run inside the synchronous frame hook.
 */
export function volume2TextureGradientRGBASync(
  device: GPUDevice,
  textureRGBA: GPUTexture,
): GPUTexture {
  const cached = ensureComputePipelines(device)
  const size: [number, number, number] = [
    textureRGBA.width,
    textureRGBA.height,
    textureRGBA.depthOrArrayLayers,
  ]
  const [vx, vy, vz] = size
  const usage =
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
  // Pass 1 blurs the alpha into `blurred`, pass 2 takes its Sobel. WebGL2
  // keeps the blur in R8, but that is not a storage format here, so the temp
  // is rgba8unorm with the value in red and dies right after the submit.
  const blurred = device.createTexture({
    size,
    format: 'rgba8unorm',
    dimension: '3d',
    usage,
  })
  const finalVolumeTexture = device.createTexture({
    size,
    format: 'rgba8unorm',
    dimension: '3d',
    usage: usage | GPUTextureUsage.COPY_SRC,
  })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  for (const [pipeline, input, output] of [
    [cached.blurPipeline, textureRGBA, blurred],
    [cached.sobelPipeline, blurred, finalVolumeTexture],
  ] as const) {
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: input.createView() },
          { binding: 1, resource: output.createView() },
          { binding: 2, resource: cached.sampler },
        ],
      }),
    )
    pass.dispatchWorkgroups(
      Math.ceil(vx / 8),
      Math.ceil(vy / 8),
      Math.ceil(vz / 4),
    )
  }
  pass.end()
  device.queue.submit([encoder.finish()])
  blurred.destroy()
  return finalVolumeTexture
}

export async function volume2TextureGradientRGBA(
  device: GPUDevice,
  textureRGBA: GPUTexture,
): Promise<GPUTexture> {
  const texture = volume2TextureGradientRGBASync(device, textureRGBA)
  await device.queue.onSubmittedWorkDone()
  return texture
}

export async function lutBytes2texture(
  device: GPUDevice,
  lut: Uint8ClampedArray,
): Promise<GPUTexture> {
  const texture = device.createTexture({
    size: [256, 1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const lutUpload = new Uint8Array(lut)
  device.queue.writeTexture(
    { texture: texture },
    lutUpload,
    { bytesPerRow: 256 * 4, rowsPerImage: 1 },
    [256, 1],
  )
  await device.queue.onSubmittedWorkDone()
  return texture
}

export async function lut2texture(
  device: GPUDevice,
  lutName: string,
  invert = false,
): Promise<GPUTexture> {
  return lutBytes2texture(device, NVCmaps.lutrgba8(lutName, invert))
}

export async function bitmap2texture(
  device: GPUDevice,
  imageSrc: string,
): Promise<GPUTexture> {
  const image = new Image()
  applyCORS(image)
  image.src = imageSrc
  await image.decode()
  const bitmap = await createImageBitmap(image)
  const texture = device.createTexture({
    size: [bitmap.width, bitmap.height, 1],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const src = { source: bitmap }
  const dst = { texture: texture }
  device.queue.copyExternalImageToTexture(src, dst, [
    bitmap.width,
    bitmap.height,
  ])
  await device.queue.onSubmittedWorkDone()
  return texture
}

export async function bitmap2textureOrFallback(
  device: GPUDevice,
  imageSrc: string,
): Promise<GPUTexture> {
  if (!imageSrc) {
    // 1x1 white fallback: matcap_rgb * color = color
    const texture = device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    )
    return texture
  }
  return bitmap2texture(device, imageSrc)
}

export function destroy(device: GPUDevice): void {
  _deviceCache.delete(device)
}
