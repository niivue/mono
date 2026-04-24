import type NVGlview from './NVViewGL'

/**
 * Benchmark harness for the WebGL2 backend. Not for production use —
 * `view.render()` is fire-and-forget by design. This helper exists so
 * benchmarks can measure true CPU+GPU wall-clock per frame.
 *
 * Lazily constructed on first access via `view.bench`. Kept in a
 * separate module so bench-only state (offscreen FBO, concurrent-call
 * guard) does not pollute the hot-path view class.
 */
export class GLBench {
  private _fbo: WebGLFramebuffer | null = null
  private _colorRbo: WebGLRenderbuffer | null = null
  private _depthRbo: WebGLRenderbuffer | null = null
  private _fboW = 0
  private _fboH = 0
  private _inProgress = false
  // Set by destroy(). Checked after every await so a bench call that was
  // mid-await when the view tore down its bench exits cleanly rather than
  // allocating orphan GPU resources on a disposed view.
  private _disposed = false

  constructor(private view: NVGlview) {}

  /** Offscreen FBO sized to the last bench render, or null before first call. */
  get fbo(): WebGLFramebuffer | null {
    return this._fbo
  }
  get fboW(): number {
    return this._fboW
  }
  get fboH(): number {
    return this._fboH
  }

  /** Render to the canvas and block until the GPU finishes. */
  async renderAndFlush(): Promise<void> {
    if (this._disposed) return
    const view = this.view
    const gl = view.gl
    if (!gl) return
    if (this._inProgress) {
      throw new Error('renderAndFlush: concurrent call not allowed')
    }
    this._inProgress = true
    try {
      if (view.boundsWidth === 0 || view.boundsHeight === 0) view.resize()
      await this._waitForReady()
      if (this._disposed) return
      view.render()
      // Force true GPU sync. gl.finish() is unreliable on some ANGLE/Metal
      // paths (returns after flush, not completion). Reading a single pixel
      // serializes the CPU against all prior GPU work — the standard
      // WebGL benchmarking sync technique. Scissor is disabled at the end
      // of render(), so (0,0) is always readable.
      const pix = new Uint8Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pix)
    } finally {
      this._inProgress = false
    }
  }

  /**
   * Render to an offscreen FBO (bypassing the canvas swap chain) and block
   * until the GPU finishes. Removes compositor / present-time coupling so
   * benchmarks measure pure render cost.
   *
   * Sub-renderers in this backend (orient overlay, gradient) unbind to the
   * default framebuffer when done. To keep our offscreen target active
   * across those internal passes, we transiently redirect
   * `bindFramebuffer(target, null)` to bind our FBO instead. Restored on
   * exit. A single-flight guard prevents re-entrancy corrupting the shim.
   */
  async renderAndFlushOffscreen(): Promise<void> {
    if (this._disposed) return
    const view = this.view
    const gl = view.gl
    if (!gl) return
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
      this._ensureFbo(gl, w, h)
      const myFbo = this._fbo
      if (!myFbo) return
      const mutGL = gl as unknown as Pick<
        WebGL2RenderingContext,
        'bindFramebuffer'
      >
      const orig = gl.bindFramebuffer.bind(gl)
      mutGL.bindFramebuffer = (target, fb) =>
        orig(target, fb === null ? myFbo : fb)
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null) // → redirected to myFbo
        view.render()
        const pix = new Uint8Array(4)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pix)
      } finally {
        mutGL.bindFramebuffer = orig
        orig(gl.FRAMEBUFFER, null)
      }
    } finally {
      this._inProgress = false
    }
  }

  /** Release all GPU resources owned by this bench. */
  destroy(): void {
    this._disposed = true
    const gl = this.view.gl
    if (gl) {
      if (this._fbo) gl.deleteFramebuffer(this._fbo)
      if (this._colorRbo) gl.deleteRenderbuffer(this._colorRbo)
      if (this._depthRbo) gl.deleteRenderbuffer(this._depthRbo)
    }
    this._fbo = null
    this._colorRbo = null
    this._depthRbo = null
    this._fboW = 0
    this._fboH = 0
  }

  private async _waitForReady(): Promise<void> {
    const view = this.view
    const MAX_WAIT_FRAMES = 300
    let tries = 0
    while (view.isBusy && tries < MAX_WAIT_FRAMES) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      tries++
    }
    if (view.isBusy) {
      throw new Error('renderAndFlush: view still busy after waiting')
    }
  }

  private _ensureFbo(gl: WebGL2RenderingContext, w: number, h: number): void {
    if (this._fbo && this._fboW === w && this._fboH === h) return
    if (this._fbo) gl.deleteFramebuffer(this._fbo)
    if (this._colorRbo) gl.deleteRenderbuffer(this._colorRbo)
    if (this._depthRbo) gl.deleteRenderbuffer(this._depthRbo)
    this._fbo = null
    this._colorRbo = null
    this._depthRbo = null

    const color = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, color)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h)
    const depth = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h)
    gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.RENDERBUFFER,
      color,
    )
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      depth,
    )
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo)
      gl.deleteRenderbuffer(color)
      gl.deleteRenderbuffer(depth)
      throw new Error(
        `renderAndFlushOffscreen: FBO incomplete (status 0x${status.toString(16)}) at ${w}x${h}`,
      )
    }
    this._fbo = fbo
    this._colorRbo = color
    this._depthRbo = depth
    this._fboW = w
    this._fboH = h
  }
}
