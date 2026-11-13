import { ubuntu } from '@/assets/fonts'
import type {
  NVSlide,
  NVSlideScreen,
  NVSlideVisibleTile,
} from '@/slide/NVSlide'
import {
  rawPoolBytes,
  SlideBudgetRegistration,
  type SlideRendererOptions,
} from '@/slide/slideFuse'
import {
  buildSlideOverlay,
  SLIDE_OVERLAY_MAX_GLYPHS,
  SLIDE_OVERLAY_MAX_LINES,
  type SlideOverlayContent,
} from '@/slide/slideOverlay'
import {
  beginSlideFrame,
  SlideFramePlan,
  screenPixels,
  writeRectNdc,
  writeTileUv,
} from '@/slide/slideTiles'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  TileTextureCache,
} from '@/slide/tileTextureCache'
import { buildLine } from '@/view/NVLine'
import type { UIKitOverlayFrame } from '@/view/NVOverlayHook'
import { ColorLutTexturesGL } from './colorLut'
import { FontRenderer } from './font'
import { setTexParams } from './glUtil'
import { LineRenderer } from './line'
import { Shader } from './shader'
import { slideFragShader, slideVertShader } from './slideShader'
import { TileFuserGL } from './tileFuse'
import { TileGutterGL, type TileTextureGL } from './tileGutter'

// Not an NVRenderer: `render(slides, screen)` draws with the context given to
// `init`, so it has no `draw(gl, ...)`.
export class SlideRenderer {
  private _isReady = false
  private _plainShader: Shader | null = null
  private _lutShader: Shader | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _vertexBuffer: WebGLBuffer | null = null
  private _placeholderTexture: WebGLTexture | null = null
  private _gl: WebGL2RenderingContext | null = null
  private readonly _luts = new ColorLutTexturesGL()
  // Byte-budgeted: tile textures for scrolled-away regions are evicted each
  // frame instead of accumulating for the life of the renderer.
  private readonly _textures: TileTextureCache<TileTextureGL>
  private readonly _gutter = new TileGutterGL()
  private readonly _fuser: TileFuserGL
  private readonly _budget: SlideBudgetRegistration
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

  private readonly _maxPoolBytes: number
  private readonly _plan = new SlideFramePlan()
  private readonly _planTextures: (TileTextureGL | null)[] = []
  private readonly _ndc = new Float32Array(4)
  private readonly _uv = new Float32Array(4)

  constructor({ maxRawPoolBytes }: SlideRendererOptions = {}) {
    const poolBytes = rawPoolBytes(maxRawPoolBytes)
    this._maxPoolBytes = poolBytes
    this._fuser = new TileFuserGL(poolBytes)
    this._budget = new SlideBudgetRegistration(this, poolBytes)
    this._textures = new TileTextureCache<TileTextureGL>(
      DEFAULT_TILE_TEXTURE_BYTES,
      (entry) => {
        this._gl?.deleteTexture(entry.texture)
        if (entry.labels) this._gl?.deleteTexture(entry.labels)
      },
    )
  }

  get isReady(): boolean {
    return this._isReady
  }

  init(gl: WebGL2RenderingContext): void {
    if (this._isReady) return

    this._gl = gl
    this._gutter.gl = gl
    this._fuser.gl = gl
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
      gl.uniform1i(shader.uniforms.labelTexture ?? null, 2)
    }
    this._vao = gl.createVertexArray()
    if (!this._vao) throw new Error('Failed to create slide VAO')
    this._vertexBuffer = gl.createBuffer()
    if (!this._vertexBuffer) throw new Error('Failed to create slide buffer')

    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    // The unit quad's corners in triangle-strip order TL, TR, BL, BR.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
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

    this._isReady = true
  }

  /**
   * Draw `slides` with the context given to `init` (no-op before it): per
   * slide its background, fallback tiles, then target tiles (SlideFramePlan),
   * every upload and fuse done before the first draw.
   */
  render(slides: readonly NVSlide[], screen: NVSlideScreen): void {
    this._budget.sync(slides)
    const gl = this._gl
    const placeholder = this._placeholderTexture
    if (!gl || !this._plainShader || !this._vao || !placeholder) return
    const [dpr, width, height] = screenPixels(screen)
    const nearest = this.isNearestInterpolation
    const plan = this._plan
    const textures = this._planTextures
    gl.activeTexture(gl.TEXTURE0)
    beginSlideFrame(
      plan,
      slides,
      screen,
      this._textures,
      this._fuser,
      this._gutter,
      this._maxPoolBytes,
      nearest,
      textures,
    )

    // Self-contained: own the full canvas viewport and clear it each frame so
    // the demo just calls render() once per frame.
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindVertexArray(this._vao)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    // Alpha as WebGPU's ALPHA_BLEND: the canvas stays opaque, so a translucent
    // quad never lets the page show through.
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    )
    const ndc = this._ndc
    const uv = this._uv
    // Unit 2's binding before the first label texture, restored after the slides.
    let unit2: WebGLTexture | null | undefined
    for (let s = 0; s < plan.slides.length; s++) {
      const slide = plan.slides[s] as NVSlide
      const shader = this.useShader(gl, slide)
      const u = shader.uniforms
      gl.uniform1f(u.opacity, slide.opacity)
      const b = slide.screenRectForSlide(screen)
      if (writeRectNdc(b.x, b.y, b.width, b.height, width, height, ndc, 0)) {
        gl.uniform4fv(u.rect, ndc)
        gl.uniform4f(u.uvRect, 0, 0, 1, 1)
        gl.uniform4fv(u.placeholderColor, slide.backgroundColor)
        gl.uniform1i(u.isPlaceholder, 1)
        gl.uniform1i(u.showGrid, 0)
        gl.bindTexture(gl.TEXTURE_2D, placeholder)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      gl.uniform4fv(u.placeholderColor, slide.placeholderColor)
      gl.uniform4fv(u.gridColor, slide.gridColor)
      const sum = slide.channelBlend === 'additive' ? 2 : 1
      let quadNearest: boolean | null = null
      let quadLabels = -1
      for (
        let q = plan.slideStart[s] as number;
        q < (plan.slideEnd[s] as number);
        q++
      ) {
        const upload = plan.quadUpload[q] as number
        const texture = upload < 0 ? null : textures[upload]
        const isFallback = plan.quadFallback[q] as boolean
        // A deferred (or failed) upload draws nothing, so its fallback shows.
        if (!texture && (isFallback || upload >= 0)) continue
        const tile = plan.quads[q] as NVSlideVisibleTile
        if (
          !writeRectNdc(
            tile.screenX,
            tile.screenY,
            tile.screenWidth,
            tile.screenHeight,
            width,
            height,
            ndc,
            0,
          )
        )
          continue
        writeTileUv(tile, uv, 0)
        const labels = texture?.labels ? sum : 0
        if (labels !== quadLabels) {
          quadLabels = labels
          gl.uniform1i(u.labelBlend, labels)
        }
        if (texture?.labels) {
          gl.activeTexture(gl.TEXTURE2)
          if (unit2 === undefined)
            unit2 = gl.getParameter(
              gl.TEXTURE_BINDING_2D,
            ) as WebGLTexture | null
          gl.bindTexture(gl.TEXTURE_2D, texture.labels)
          gl.activeTexture(gl.TEXTURE0)
        }
        // A fused tile of label channels samples nearest whatever the mode.
        const n = nearest || texture?.nearest === true
        if (n !== quadNearest) {
          quadNearest = n
          gl.uniform1i(u.isNearest, n ? 1 : 0)
          gl.bindSampler(0, n ? this._nearestSampler : null)
        }
        gl.uniform4fv(u.rect, ndc)
        gl.uniform4fv(u.uvRect, uv)
        gl.uniform1i(u.isPlaceholder, texture ? 0 : 1)
        gl.uniform1i(u.showGrid, !isFallback && slide.showTileGrid ? 1 : 0)
        gl.bindTexture(gl.TEXTURE_2D, texture ? texture.texture : placeholder)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    }

    if (unit2 !== undefined) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, unit2)
      gl.activeTexture(gl.TEXTURE0)
    }
    // The overlay's font atlas keeps its own (linear) filtering.
    gl.bindSampler(0, null)
    this._drawOverlay(gl, width, height, dpr)

    // UIKit overlay hook: last screen-space draw of the frame, with blend on and
    // depth/cull off (the widget sets and restores its own state as needed).
    if (this.overlayDraw) {
      this.overlayDraw({
        handle: { backend: 'webgl2', gl },
        bounds: { x: 0, y: 0, width, height },
        dpr,
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
    this._fuser.clear()
    this._luts.clear(this._gl)
  }

  // The plain shader unless the slide has a colour table to apply.
  private useShader(gl: WebGL2RenderingContext, slide: NVSlide): Shader {
    const lut = slide.displayColorLut
    const shader = (lut && this._lutShader) || (this._plainShader as Shader)
    shader.use(gl)
    if (lut) this._luts.bind(gl, lut)
    return shader
  }

  destroy(): void {
    this._budget.clear()
    this._textures.clear()
    this._fuser.destroy()
    this._luts.clear(this._gl)
    this._lines.destroy()
    this._font.destroy()
    this._gutter.destroy()
    const gl = this._gl
    if (gl) {
      if (this._placeholderTexture) gl.deleteTexture(this._placeholderTexture)
      if (this._vertexBuffer) gl.deleteBuffer(this._vertexBuffer)
      if (this._vao) gl.deleteVertexArray(this._vao)
      gl.deleteSampler(this._nearestSampler)
      for (const shader of [this._plainShader, this._lutShader])
        if (shader) gl.deleteProgram(shader.program)
    }
    this._nearestSampler = null
    this._placeholderTexture = null
    this._vertexBuffer = null
    this._vao = null
    this._plainShader = null
    this._lutShader = null
    this._gl = null
    this._isReady = false
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
}
