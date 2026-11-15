// Lets a UIKit overlay read the frame drawn so far (a magnifier) on WebGPU,
// where the open pass's attachment cannot be sampled: end the pass, copy its
// resolved target, and continue in a single-sample pass without depth. Views
// that never see a capture pay nothing.

import type { UIKitBackendHandle } from '../view/NVOverlayHook'

type WebGPUHandle = Extract<UIKitBackendHandle, { backend: 'webgpu' }>
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export class SceneCapture {
  private texture: GPUTexture | null = null

  /**
   * The overlay handle for one frame. `target` is the texture the pass
   * resolves to. End `handle.pass`, not the original pass: a capture swaps it.
   */
  handle(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    pass: GPURenderPassEncoder,
    target: GPUTexture,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
    depthFormat?: GPUTextureFormat,
  ): Mutable<WebGPUHandle> {
    let captured: GPUTexture | null = null
    const handle: Mutable<WebGPUHandle> = {
      backend: 'webgpu',
      device,
      pass,
      colorFormat,
      sampleCount,
      depthFormat,
      captureScene: () => {
        if (captured) return captured
        handle.pass.end()
        captured = this.copyOf(device, encoder, target)
        handle.pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: target.createView(), loadOp: 'load', storeOp: 'store' },
          ],
        })
        handle.sampleCount = 1
        handle.depthFormat = undefined
        return captured
      },
    }
    return handle
  }

  private copyOf(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    target: GPUTexture,
  ): GPUTexture {
    let t = this.texture
    if (
      !t ||
      t.width !== target.width ||
      t.height !== target.height ||
      t.format !== target.format
    ) {
      t?.destroy()
      t = device.createTexture({
        size: [target.width, target.height],
        format: target.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      this.texture = t
    }
    encoder.copyTextureToTexture({ texture: target }, { texture: t }, [
      target.width,
      target.height,
    ])
    return t
  }

  destroy(): void {
    this.texture?.destroy()
    this.texture = null
  }
}
