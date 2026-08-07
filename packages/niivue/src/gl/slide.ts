import type {
  NVSlide,
  NVSlideColor,
  NVSlideScreen,
  NVSlideScreenRect,
  NVSlideVisibleTile,
} from '@/slide/NVSlide'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  TileTextureCache,
} from '@/slide/tileTextureCache'
import type { UIKitOverlayFrame } from '@/view/NVOverlayHook'
import { NVRenderer } from '@/view/NVRenderer'
import { Shader } from './shader'
import { slideFragShader, slideVertShader } from './slideShader'

type SlideTexture = {
  texture: WebGLTexture
  width: number
  height: number
}

export class SlideRenderer extends NVRenderer {
  private _shader: Shader | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _vertexBuffer: WebGLBuffer | null = null
  private _placeholderTexture: WebGLTexture | null = null
  private _gl: WebGL2RenderingContext | null = null
  // Byte-budgeted: tile textures for scrolled-away regions are evicted each
  // frame instead of accumulating for the life of the renderer.
  private readonly _textures = new TileTextureCache<SlideTexture>(
    DEFAULT_TILE_TEXTURE_BYTES,
    (entry) => this._gl?.deleteTexture(entry.texture),
  )
  /**
   * UIKit overlay hook: invoked at the end of every frame (after the slide tiles,
   * before GL state is restored) so a widget can draw over the slide in screen
   * space. Mirrors the NiiVue view hook. See view/NVOverlayHook.ts.
   */
  overlayDraw: ((frame: UIKitOverlayFrame) => void) | null = null

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return

    this._gl = gl
    this._shader = new Shader(gl, slideVertShader, slideFragShader)
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
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

    this._shader.use(gl)
    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(this._shader.uniforms.slideTexture, 0)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    for (const slide of slides) {
      if (!slide.visible || slide.opacity <= 0) continue
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
      const visible = slide.requestVisibleTiles(screen)
      for (const item of visible.tiles) {
        const bitmap = slide.cachedTileBitmap(item.key)
        const texture = bitmap
          ? this.textureForBitmap(gl, item.key, bitmap)
          : null
        const rect = {
          x: item.screenX,
          y: item.screenY,
          width: item.screenWidth,
          height: item.screenHeight,
        }
        this.drawTile(
          gl,
          width,
          height,
          rect,
          texture?.texture ?? this._placeholderTexture,
          slide.placeholderColor,
          slide.gridColor,
          slide.opacity,
          item,
          !bitmap,
          slide.showTileGrid,
        )
      }
    }

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
    gl.enable(gl.CULL_FACE)
    gl.enable(gl.DEPTH_TEST)
  }

  // Drop every cached tile texture without tearing down the renderer. Tile
  // textures are keyed by tile key (`L{i}/{x}/{y}`), a namespace shared by every
  // slide, and `textureForBitmap` reuses a cached texture whenever key + size
  // match without re-uploading — so a consumer that swaps the slide behind this
  // renderer must call this first, or the new slide inherits the old slide's
  // tiles (ghost tiles).
  clearTextures(): void {
    this._textures.clear()
  }

  destroy(): void {
    this._textures.clear()
    const gl = this._gl
    if (gl) {
      if (this._placeholderTexture) gl.deleteTexture(this._placeholderTexture)
      if (this._vertexBuffer) gl.deleteBuffer(this._vertexBuffer)
      if (this._vao) gl.deleteVertexArray(this._vao)
    }
    this._placeholderTexture = null
    this._vertexBuffer = null
    this._vao = null
    this._shader = null
    this._gl = null
    this.isReady = false
  }

  private textureForBitmap(
    gl: WebGL2RenderingContext,
    key: string,
    bitmap: ImageBitmap,
  ): SlideTexture | null {
    const existing = this._textures.get(key)
    if (
      existing &&
      existing.width === bitmap.width &&
      existing.height === bitmap.height
    ) {
      return existing
    }
    if (existing) this._textures.delete(key)
    const texture = gl.createTexture()
    if (!texture) return null
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    const entry = { texture, width: bitmap.width, height: bitmap.height }
    this._textures.set(key, entry, bitmap.width * bitmap.height * 4)
    return entry
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
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x + rect.width < 0 ||
      rect.y + rect.height < 0 ||
      rect.x > width ||
      rect.y > height
    ) {
      return
    }

    const x0 = (rect.x / width) * 2 - 1
    const x1 = ((rect.x + rect.width) / width) * 2 - 1
    const y0 = 1 - (rect.y / height) * 2
    const y1 = 1 - ((rect.y + rect.height) / height) * 2
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
    gl.uniform4fv(this._shader.uniforms.placeholderColor, placeholderColor)
    gl.uniform4fv(this._shader.uniforms.gridColor, gridColor)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}
