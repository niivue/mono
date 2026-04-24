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
  private _inProgress = false
  // Set by destroy(). Checked after every await so a bench call that was
  // mid-await when the view tore down its bench exits cleanly rather than
  // allocating orphan GPU resources on a disposed view.
  private _disposed = false

  constructor(private view: NVView) {}

  /** Render to the canvas and await GPU completion. */
  async renderAndFlush(): Promise<void> {
    if (this._disposed) return
    if (this._inProgress) {
      throw new Error('renderAndFlush: concurrent call not allowed')
    }
    this._inProgress = true
    try {
      const view = this.view
      if (view.boundsWidth === 0 || view.boundsHeight === 0) view.resize()
      await this._waitForReady()
      if (this._disposed) return
      view.render()
      if (view.device) await view.device.queue.onSubmittedWorkDone()
    } finally {
      this._inProgress = false
    }
  }

  /**
   * Render to an offscreen texture (bypassing the canvas swap chain) and
   * await GPU completion. Removes compositor / present-time coupling so
   * benchmarks measure pure render cost.
   */
  async renderAndFlushOffscreen(): Promise<void> {
    if (this._disposed) return
    const view = this.view
    if (!view.device) return
    if (this._inProgress) {
      throw new Error('renderAndFlushOffscreen: concurrent call not allowed')
    }
    this._inProgress = true
    try {
      if (view.boundsWidth === 0 || view.boundsHeight === 0) view.resize()
      await this._waitForReady()
      if (this._disposed) return
      const w = view.boundsWidth
      const h = view.boundsHeight
      if (
        !this._offscreen ||
        this._offscreen.width !== w ||
        this._offscreen.height !== h
      ) {
        this._offscreen?.destroy()
        this._offscreen = view.device.createTexture({
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
        await view.device.queue.onSubmittedWorkDone()
      } finally {
        this.targetOverride = null
        restoreSubCanvas()
      }
    } finally {
      this._inProgress = false
    }
  }

  /** Release all GPU resources owned by this bench. */
  destroy(): void {
    this._disposed = true
    if (this._offscreen) this._offscreen.destroy()
    this._offscreen = null
    this.targetOverride = null
  }

  private async _waitForReady(): Promise<void> {
    const view = this.view
    const MAX_WAIT_FRAMES = 300
    let tries = 0
    while (
      (view.isBusy || !view.fontRenderer.isReady) &&
      tries < MAX_WAIT_FRAMES
    ) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      tries++
    }
    if (view.isBusy || !view.fontRenderer.isReady) {
      throw new Error(
        'renderAndFlush: view not ready (isBusy or font atlas not loaded)',
      )
    }
  }
}
