import * as NVCmaps from '@/cmap/NVCmaps'
import { applyCORS } from '@/NVLoader'
import blurWGSL from './blur.wgsl?raw'
import sobelWGSL from './sobel.wgsl?raw'

// --- per-device cached pipelines ---
interface GradientPipelines {
  sobelPipeline: GPUComputePipeline
  blurPipeline: GPUComputePipeline
  sobelBindLayout: GPUBindGroupLayout
  blurBindLayout: GPUBindGroupLayout
}
const _deviceCache = new WeakMap<GPUDevice, GradientPipelines>()

// ensure compute & blur pipelines exist and are cached for this device
function ensureComputePipelines(device: GPUDevice): GradientPipelines {
  let cached = _deviceCache.get(device)
  if (cached) return cached
  const compModule = device.createShaderModule({ code: sobelWGSL })
  const sobelPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: compModule, entryPoint: 'main' },
  })
  const blurModule = device.createShaderModule({ code: blurWGSL })
  const blurPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: blurModule, entryPoint: 'main' },
  })
  cached = {
    sobelPipeline,
    blurPipeline,
    sobelBindLayout: sobelPipeline.getBindGroupLayout(0),
    blurBindLayout: blurPipeline.getBindGroupLayout(0),
  }
  _deviceCache.set(device, cached)
  return cached
}

export async function volume2TextureGradientRGBA(
  device: GPUDevice,
  textureRGBA: GPUTexture,
): Promise<GPUTexture> {
  const cached = ensureComputePipelines(device)
  const vx = textureRGBA.width
  const vy = textureRGBA.height
  const vz = textureRGBA.depthOrArrayLayers
  // 1) Create the output textures
  const tempGradientTex = device.createTexture({
    size: [vx, vy, vz],
    format: 'rgba8unorm',
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  })
  const finalVolumeTexture = device.createTexture({
    size: [vx, vy, vz],
    format: 'rgba8unorm',
    dimension: '3d',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  // 2) Create Bind Groups using the input texture directly
  const sobelBindGroup = device.createBindGroup({
    layout: cached.sobelBindLayout,
    entries: [
      { binding: 0, resource: textureRGBA.createView() },
      { binding: 1, resource: tempGradientTex.createView() },
    ],
  })
  const blurBindGroup = device.createBindGroup({
    layout: cached.blurBindLayout,
    entries: [
      { binding: 0, resource: tempGradientTex.createView() },
      { binding: 1, resource: finalVolumeTexture.createView() },
    ],
  })
  // 3) Dispatch
  const encoder = device.createCommandEncoder()
  {
    const pass = encoder.beginComputePass()
    pass.setPipeline(cached.sobelPipeline)
    pass.setBindGroup(0, sobelBindGroup)
    pass.dispatchWorkgroups(
      Math.ceil(vx / 8),
      Math.ceil(vy / 8),
      Math.ceil(vz / 4),
    )
    pass.end()
  }
  {
    const pass2 = encoder.beginComputePass()
    pass2.setPipeline(cached.blurPipeline)
    pass2.setBindGroup(0, blurBindGroup)
    pass2.dispatchWorkgroups(
      Math.ceil(vx / 8),
      Math.ceil(vy / 8),
      Math.ceil(vz / 4),
    )
    pass2.end()
  }
  device.queue.submit([encoder.finish()])
  await device.queue.onSubmittedWorkDone()
  tempGradientTex.destroy()
  return finalVolumeTexture
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
): Promise<GPUTexture> {
  return lutBytes2texture(device, NVCmaps.lutrgba8(lutName))
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
