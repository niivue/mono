// A bare-canvas host for uikit overlays, standing in for NiiVue: it owns a
// WebGL2 context or a WebGPU device, renders on demand (drawScene schedules
// one frame), and implements UIKitHost and registerOverlayRenderer as NiiVue
// does, so UIKitControls and overlays attach to either unchanged. Each frame
// clears, calls the app's `draw`, then every overlay in registration order.

import type { UIKitHost } from './controls'
import type {
  UIKitBackendHandle,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from './hook'
import type { RGBA } from './text/layout'

export interface UIKitCanvasHostOptions {
  backend: 'webgl2' | 'webgpu'
  /** Each frame's clear colour. Default opaque near-black. */
  clearColor?: RGBA
  /** The app's own drawing, before the overlays (WebGPU: into the open pass). */
  draw?: (frame: UIKitOverlayFrame) => void
}

export class UIKitCanvasHost implements UIKitHost {
  private readonly renderers: UIKitOverlayRenderer[] = []
  private readonly observer: ResizeObserver
  private raf = 0

  private constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext | null,
    private readonly gpu: {
      device: GPUDevice
      context: GPUCanvasContext
      format: GPUTextureFormat
    } | null,
    private readonly options: UIKitCanvasHostOptions,
  ) {
    this.resize(
      canvas.clientWidth * devicePixelRatio,
      canvas.clientHeight * devicePixelRatio,
    )
    this.observer = new ResizeObserver(([e]) => {
      const box = e.devicePixelContentBoxSize?.[0]
      this.resize(
        box ? box.inlineSize : e.contentRect.width * devicePixelRatio,
        box ? box.blockSize : e.contentRect.height * devicePixelRatio,
      )
      // Render now: a resize clears the canvas, and a frame later shows blank.
      this.render()
    })
    try {
      // Fires on devicePixelRatio changes (zoom, another monitor) too.
      this.observer.observe(canvas, { box: 'device-pixel-content-box' })
    } catch {
      this.observer.observe(canvas) // Safari has no device-pixel-content-box
    }
  }

  /** Get the context (WebGPU: adapter, device, configured canvas) and draw once. */
  static async create(
    canvas: HTMLCanvasElement,
    options: UIKitCanvasHostOptions,
  ): Promise<UIKitCanvasHost> {
    let host: UIKitCanvasHost
    if (options.backend === 'webgl2') {
      // Opaque: the overlays blend alpha too, so translucent fills would
      // otherwise leave the canvas see-through.
      const gl = canvas.getContext('webgl2', { alpha: false })
      if (!gl) throw new Error('UIKit: WebGL2 is unavailable')
      host = new UIKitCanvasHost(canvas, gl, null, options)
    } else {
      const adapter = await navigator.gpu?.requestAdapter()
      if (!adapter) throw new Error('UIKit: WebGPU is unavailable')
      const device = await adapter.requestDevice()
      const context = canvas.getContext('webgpu')
      if (!context) throw new Error('UIKit: no WebGPU canvas context')
      const format = navigator.gpu.getPreferredCanvasFormat()
      context.configure({ device, format, alphaMode: 'opaque' })
      host = new UIKitCanvasHost(
        canvas,
        null,
        { device, context, format },
        options,
      )
    }
    host.drawScene()
    return host
  }

  get backend(): 'webgl2' | 'webgpu' {
    return this.gl ? 'webgl2' : 'webgpu'
  }

  /** Add an overlay drawn after the app's content; returns its unregister. */
  registerOverlayRenderer(renderer: UIKitOverlayRenderer): () => void {
    this.renderers.push(renderer)
    this.drawScene()
    return () => {
      const i = this.renderers.indexOf(renderer)
      if (i >= 0) this.renderers.splice(i, 1)
      this.drawScene()
    }
  }

  drawScene(): void {
    this.raf ||= requestAnimationFrame(() => this.render())
  }

  clientToCanvas(clientX: number, clientY: number): [number, number] | null {
    const r = this.canvas.getBoundingClientRect()
    const x = clientX - r.left
    const y = clientY - r.top
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return null
    return [
      (x * this.canvas.width) / r.width,
      (y * this.canvas.height) / r.height,
    ]
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.observer.disconnect()
    this.renderers.length = 0
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext()
    this.gpu?.device.destroy()
  }

  private resize(width: number, height: number): void {
    // At least 1 px (WebGPU rejects an empty texture); assigning clears, so
    // only on change.
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
  }

  private render(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    const { width, height } = this.canvas
    const [r, g, b, a] = this.options.clearColor ?? [0.05, 0.05, 0.08, 1]
    const { gl, gpu } = this
    let handle: UIKitBackendHandle
    let finish: () => void
    if (gl) {
      gl.viewport(0, 0, width, height)
      gl.clearColor(r, g, b, a)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      handle = { backend: 'webgl2', gl }
      finish = () => {}
    } else if (gpu) {
      const encoder = gpu.device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: gpu.context.getCurrentTexture().createView(),
            clearValue: { r, g, b, a },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      // ponytail: no captureScene, so a WebGPU magnifier shows nothing here.
      handle = {
        backend: 'webgpu',
        device: gpu.device,
        pass,
        colorFormat: gpu.format,
        sampleCount: 1,
      }
      finish = () => {
        pass.end()
        gpu.device.queue.submit([encoder.finish()])
      }
    } else return
    // settled: this host has no work of its own in flight.
    const frame: UIKitOverlayFrame = {
      handle,
      bounds: { x: 0, y: 0, width, height },
      // The backing store's own scale: device-pixel-content-box can disagree
      // with window.devicePixelRatio (emulated dpr), and widgets must match it.
      dpr: this.canvas.clientWidth
        ? width / this.canvas.clientWidth
        : devicePixelRatio,
      settled: true,
    }
    this.options.draw?.(frame)
    gl?.viewport(0, 0, width, height) // the hook promises the bounds viewport
    for (const renderer of this.renderers) renderer.drawOverlay(frame)
    finish()
  }
}
