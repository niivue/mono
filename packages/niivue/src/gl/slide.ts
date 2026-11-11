import { ubuntu } from '@/assets/fonts'
import type {
  NVSlide,
  NVSlideColor,
  NVSlideScreen,
  NVSlideScreenRect,
  NVSlideVisibleTile,
} from '@/slide/NVSlide'
import {
  buildSlideOverlay,
  SLIDE_OVERLAY_MAX_GLYPHS,
  SLIDE_OVERLAY_MAX_LINES,
  type SlideOverlayContent,
} from '@/slide/slideOverlay'
import { forEachSlideTile, slideRectNdc } from '@/slide/slideTiles'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  slideTileKey,
  TileTextureCache,
} from '@/slide/tileTextureCache'
import { buildLine } from '@/view/NVLine'
import type { UIKitOverlayFrame } from '@/view/NVOverlayHook'
import { NVRenderer } from '@/view/NVRenderer'
import { timeChunkPhase } from '@/volume/chunkTiming'
import { ColorLutTexturesGL } from './colorLut'
import { FontRenderer } from './font'
import { setTexParams } from './glUtil'
import { LineRenderer } from './line'
import { Shader } from './shader'
import { slideFragShader, slideVertShader } from './slideShader'
import { TileGutterGL, type TileTextureGL } from './tileGutter'

export class SlideRenderer extends NVRenderer {
  private _shader: Shader | null = null // the variant in use
  private _plainShader: Shader | null = null
  private _lutShader: Shader | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _vertexBuffer: WebGLBuffer | null = null
  private _placeholderTexture: WebGLTexture | null = null
  private _gl: WebGL2RenderingContext | null = null
  private readonly _luts = new ColorLutTexturesGL()
  // Byte-budgeted: tile textures for scrolled-away regions are evicted each
  // frame instead of accumulating for the life of the renderer.
  private readonly _textures = new TileTextureCache<TileTextureGL>(
    DEFAULT_TILE_TEXTURE_BYTES,
    (entry) => this._gl?.deleteTexture(entry.texture),
  )
  private readonly _gutter = new TileGutterGL()
  /**
   * UIKit overlay hook: invoked at the end of every frame (after the slide tiles,
   * before GL state is restored) so a widget can draw over the slide in screen
   * space. Mirrors the NiiVue view hook. See view/NVOverlayHook.ts.
   */
  overlayDraw: ((frame: UIKitOverlayFrame) => void) | null = null
  /**
   * Rulers and selection drawn over the tiles with NiiVue's own line and font
   * renderers, before `overlayDraw` (see `slideOverlayContent`).
   */
  overlay: SlideOverlayContent | null = null
  /**
   * Sample tiles with nearest-neighbour filtering instead of linear, so each
   * source pixel shows as a crisp square when zoomed in.
   */
  isNearestInterpolation = false
  // Overrides the tiles' linear filtering while isNearestInterpolation is on.
  private _nearestSampler: WebGLSampler | null = null
  private readonly _lines = new LineRenderer()
  private readonly _font = new FontRenderer()

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return

    this._gl = gl
    this._nearestSampler = gl.createSampler()
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.samplerParameteri(this._nearestSampler, p, gl.NEAREST)
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.samplerParameteri(this._nearestSampler, p, gl.CLAMP_TO_EDGE)
    this._lines.init(gl)
    // The atlas loads asynchronously; labels draw from the frame after.
    void this._font.init(gl, ubuntu)
    this._plainShader = new Shader(gl, slideVertShader, slideFragShader(false))
    this._lutShader = new Shader(gl, slideVertShader, slideFragShader(true))
    // Sampler units are program state: set once (the lookup table is on unit 1).
    for (const shader of [this._plainShader, this._lutShader]) {
      shader.use(gl)
      gl.uniform1i(shader.uniforms.slideTexture, 0)
      gl.uniform1i(shader.uniforms.colorLut ?? null, 1)
    }
    this._shader = this._plainShader
    this._vao = gl.createVertexArray()
    if (!this._vao) throw new Error('Failed to create slide VAO')
    this._vertexBuffer = gl.createBuffer()
    if (!this._vertexBuffer) throw new Error('Failed to create slide buffer')

    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, 16 * 4, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8)
    gl.bindVertexArray(null)

    this._placeholderTexture = gl.createTexture()
    if (!this._placeholderTexture) {
      throw new Error('Failed to create slide placeholder texture')
    }
    gl.bindTexture(gl.TEXTURE_2D, this._placeholderTexture)
    setTexParams(gl, gl.TEXTURE_2D, gl.LINEAR)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    )
    gl.bindTexture(gl.TEXTURE_2D, null)

    this.isReady = true
  }

  draw(
    gl: WebGL2RenderingContext,
    slides: readonly NVSlide[],
    screen: NVSlideScreen,
  ): void {
    if (
      !this.isReady ||
      !this._shader ||
      !this._vao ||
      !this._vertexBuffer ||
      !this._placeholderTexture
    ) {
      return
    }
    const placeholder = this._placeholderTexture
    const width = Math.max(
      1,
      Math.floor(screen.widthCss * (screen.devicePixelRatio ?? 1)),
    )
    const height = Math.max(
      1,
      Math.floor(screen.heightCss * (screen.devicePixelRatio ?? 1)),
    )

    // Evict BEFORE beginFrame so the previous frame's working set (still
    // marked with the current frame stamp) is exempt; see TileTextureCache.
    this._textures.evictToBudget()
    this._textures.beginFrame()

    // Self-contained: own the full canvas viewport and clear it each frame so
    // the demo just calls draw() once per frame.
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.activeTexture(gl.TEXTURE0)
    if (!this.isNearestInterpolation) this._gutter.resync(gl, this._textures)
    gl.bindSampler(0, this.isNearestInterpolation ? this._nearestSampler : null)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    for (const slide of slides) {
      if (!slide.visible || slide.opacity <= 0) continue
      this.useShader(gl, slide)
      const bounds = slide.screenRectForSlide(screen)
      this.drawRect(
        gl,
        width,
        height,
        bounds,
        this._placeholderTexture,
        slide.backgroundColor,
        slide.opacity,
        false,
      )
      // Upload every tile before drawing any: an upload refreshes resident
      // neighbours' gutters, which must land before those are drawn (WebGPU
      // submits its gutter copies ahead of the frame).
      const quads: [
        NVSlideVisibleTile,
        TileTextureGL | null,
        NVSlideScreenRect,
        boolean,
      ][] = []
      forEachSlideTile(slide, screen, (item, bitmap, rect, isFallback) => {
        const texture = bitmap ? this.textureForBitmap(gl, item, bitmap) : null
        if (!isFallback || texture)
          quads.push([item, texture, rect, isFallback])
      })
      for (const [item, texture, rect, isFallback] of quads)
        this.drawTile(
          gl,
          width,
          height,
          rect,
          texture?.texture ?? placeholder,
          slide.placeholderColor,
          slide.gridColor,
          slide.opacity,
          item,
          !texture,
          !isFallback && slide.showTileGrid,
        )
    }

    // The overlay's font atlas keeps its own (linear) filtering.
    gl.bindSampler(0, null)
    this._drawOverlay(gl, width, height, screen.devicePixelRatio ?? 1)

    // UIKit overlay hook: last screen-space draw of the frame, with blend on and
    // depth/cull off (the widget sets and restores its own state as needed).
    if (this.overlayDraw) {
      this.overlayDraw({
        handle: { backend: 'webgl2', gl },
        bounds: { x: 0, y: 0, width, height },
        dpr: screen.devicePixelRatio ?? 1,
        settled: true,
      })
    }

    gl.bindVertexArray(null)
    gl.bindTexture(gl.TEXTURE_2D, null)
    this._luts.bind(gl, null)
    gl.enable(gl.CULL_FACE)
    gl.enable(gl.DEPTH_TEST)
  }

  // Drop every cached tile texture without tearing down the renderer: frees a
  // swapped-out slide's tiles now rather than when the byte budget evicts them
  // (textures are keyed by slide, see slideTileKey).
  clearTextures(): void {
    this._textures.clear()
    this._luts.clear(this._gl)
  }

  // The plain shader unless the slide has a colour table to apply.
  private useShader(gl: WebGL2RenderingContext, slide: NVSlide): void {
    const lut = slide.displayColorLut
    const shader = lut ? this._lutShader : this._plainShader
    if (!shader) return
    this._shader = shader
    shader.use(gl)
    if (lut) this._luts.bind(gl, lut)
  }

  destroy(): void {
    this._textures.clear()
    this._luts.clear(this._gl)
    this._lines.destroy()
    this._font.destroy()
    this._gutter.destroy(this._gl)
    const gl = this._gl
    if (gl) {
      if (this._placeholderTexture) gl.deleteTexture(this._placeholderTexture)
      if (this._vertexBuffer) gl.deleteBuffer(this._vertexBuffer)
      if (this._vao) gl.deleteVertexArray(this._vao)
      gl.deleteSampler(this._nearestSampler)
    }
    this._nearestSampler = null
    this._placeholderTexture = null
    this._vertexBuffer = null
    this._vao = null
    this._shader = null
    this._plainShader = null
    this._lutShader = null
    this._gl = null
    this.isReady = false
  }

  private _drawOverlay(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    dpr: number,
  ): void {
    if (!this.overlay || !this._font.isReady) return
    this._lines.resize(gl, width, height)
    this._font.resize(gl, width, height, dpr)
    const { lines, labels } = buildSlideOverlay(
      this.overlay,
      (...a) => this._font.buildText(...a),
      buildLine,
      this._font.fontPx * 0.5,
    )
    this._lines.draw(gl, null, null, null, lines, SLIDE_OVERLAY_MAX_LINES)
    this._font.draw(gl, null, null, null, labels, SLIDE_OVERLAY_MAX_GLYPHS)
    // The line and font passes re-enable depth and culling; the overlay hook
    // expects both off.
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
  }

  private textureForBitmap(
    gl: WebGL2RenderingContext,
    item: NVSlideVisibleTile,
    bitmap: ImageBitmap,
  ): TileTextureGL | null {
    // Keyed by the bitmap too: a re-windowed tile is a new bitmap (set() replaces).
    const key = slideTileKey(item.slide, item.key)
    const existing = this._textures.get(key, bitmap)
    if (existing) return existing
    // Timed as `upload` alongside the volume path's brick uploads: a slide tile
    // and a volume brick are two consumers of the same streamed source, and
    // both pay their texture cost on this thread.
    return timeChunkPhase(
      'upload',
      () =>
        this._gutter.upload(
          gl,
          bitmap,
          {
            slide: item.slide,
            key,
            level: item.level.index,
            col: item.tile.x,
            row: item.tile.y,
          },
          this._textures,
          // Nearest needs no gutter (the shader clamps); resync fills it.
          !this.isNearestInterpolation,
        ),
      bitmap.width * bitmap.height * 4,
    )
  }

  private drawRect(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    rect: NVSlideScreenRect,
    texture: WebGLTexture,
    color: NVSlideColor,
    opacity: number,
    showGrid: boolean,
  ): void {
    this.drawQuad(gl, width, height, rect, texture, color, color, opacity, {
      uvTop: 0,
      uvBottom: 1,
      isPlaceholder: true,
      showGrid,
    })
  }

  private drawTile(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    rect: NVSlideScreenRect,
    texture: WebGLTexture,
    placeholderColor: NVSlideColor,
    gridColor: NVSlideColor,
    opacity: number,
    item: NVSlideVisibleTile,
    isPlaceholder: boolean,
    showGrid: boolean,
  ): void {
    this.drawQuad(
      gl,
      width,
      height,
      rect,
      texture,
      placeholderColor,
      gridColor,
      opacity,
      {
        uvTop: item.flipY ? 1 : 0,
        uvBottom: item.flipY ? 0 : 1,
        isPlaceholder,
        showGrid,
      },
    )
  }

  private drawQuad(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    rect: NVSlideScreenRect,
    texture: WebGLTexture,
    placeholderColor: NVSlideColor,
    gridColor: NVSlideColor,
    opacity: number,
    options: {
      uvTop: number
      uvBottom: number
      isPlaceholder: boolean
      showGrid: boolean
    },
  ): void {
    if (!this._shader) return
    const ndc = slideRectNdc(rect, width, height)
    if (!ndc) return
    const [x0, y0, x1, y1] = ndc
    const vertices = new Float32Array([
      x0,
      y0,
      0,
      options.uvTop,
      x1,
      y0,
      1,
      options.uvTop,
      x0,
      y1,
      0,
      options.uvBottom,
      x1,
      y1,
      1,
      options.uvBottom,
    ])
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1f(this._shader.uniforms.opacity, opacity)
    gl.uniform1i(
      this._shader.uniforms.isPlaceholder,
      options.isPlaceholder ? 1 : 0,
    )
    gl.uniform1i(this._shader.uniforms.showGrid, options.showGrid ? 1 : 0)
    gl.uniform1i(
      this._shader.uniforms.isNearest,
      this.isNearestInterpolation ? 1 : 0,
    )
    gl.uniform4fv(this._shader.uniforms.placeholderColor, placeholderColor)
    gl.uniform4fv(this._shader.uniforms.gridColor, gridColor)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}
