import { BenchGuard } from '@/view/NVBench'
import type NVView from './NVViewGPU'

/**
 * Benchmark harness for the WebGPU backend. Not for production use —
 * `view.render()` is fire-and-forget by design. This helper exists so
 * benchmarks can measure true CPU+GPU wall-clock per frame.
 *
 * Lazily constructed on first access via `view.bench`. Kept in a
 * separate module so bench-only state (offscreen target, concurrent-call
 * guard) does not pollute the hot-path view class.
 */
export class WGPUBench {
  /**
   * When non-null, view.render() writes to this texture instead of the
   * canvas swap chain. Set transiently by renderAndFlushOffscreen().
   */
  targetOverride: GPUTexture | null = null
  private _offscreen: GPUTexture | null = null
  private _guard: BenchGuard

  constructor(private view: NVView) {
    this._guard = new BenchGuard(
      view,
      () => !view.isBusy && view.fontRenderer.isReady,
      'renderAndFlush: view not ready (isBusy or font atlas not loaded)',
    )
  }

  /** Render to the canvas and await GPU completion. */
  async renderAndFlush(): Promise<void> {
    const view = this.view
    await this._guard.run('renderAndFlush', async () => {
      view.render()
      if (view.device) await view.device.queue.onSubmittedWorkDone()
    })
  }

  /**
   * Render to an offscreen texture (bypassing the canvas swap chain) and
   * await GPU completion. Removes compositor / present-time coupling so
   * benchmarks measure pure render cost.
   */
  async renderAndFlushOffscreen(): Promise<void> {
    const view = this.view
    const device = view.device
    if (!device) return
    await this._guard.run('renderAndFlushOffscreen', async () => {
      const w = view.boundsWidth
      const h = view.boundsHeight
      if (
        !this._offscreen ||
        this._offscreen.width !== w ||
        this._offscreen.height !== h
      ) {
        this._offscreen?.destroy()
        this._offscreen = device.createTexture({
          size: { width: w, height: h },
          format: view.preferredCanvasFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        })
      }
      // Suppress sub-canvas mode so render() writes directly to the override
      // texture rather than through _boundsColorTexture + copy-to-canvas.
      const restoreSubCanvas = view.suppressSubCanvasBounds()
      this.targetOverride = this._offscreen
      try {
        view.render()
        await device.queue.onSubmittedWorkDone()
      } finally {
        this.targetOverride = null
        restoreSubCanvas()
      }
    })
  }

  /** Release all GPU resources owned by this bench. */
  destroy(): void {
    this._guard.disposed = true
    if (this._offscreen) this._offscreen.destroy()
    this._offscreen = null
    this.targetOverride = null
  }
}
