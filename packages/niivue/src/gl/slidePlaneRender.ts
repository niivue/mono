import { colorLutGlsl } from '@/slide/colorLutShader'
import type { NVSlide, NVSlideCachedTile } from '@/slide/NVSlide'
import {
  DEFAULT_RAW_POOL_BYTES,
  isFuseTile,
  SlideBudgetRegistration,
  tileTextureBudget,
} from '@/slide/slideFuse'
import {
  cornerQuad,
  type SlidePlaneAnnotation,
  type SlidePlaneTile,
} from '@/slide/slidePlane'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  slideTileKey,
  TileTextureCache,
} from '@/slide/tileTextureCache'
import { NVRenderer } from '@/view/NVRenderer'
import { ColorLutTexturesGL } from './colorLut'
import { setTexParams } from './glUtil'
import { Shader } from './shader'
import { TileFuserGL } from './tileFuse'
import { TileGutterGL, type TileTextureGL } from './tileGutter'

// Draws an NVSlide as a textured plane in the 3D render tile. Each tile of the
// chosen slide level is a world-mm quad (computed by `slidePlaneTiles`); this
// renderer uploads the tile's cached bitmap (or fuses its samples, see
// tileFuse.ts) to a GPU texture and draws the quad
// with the render tile's MVP (world mm -> clip), so the slide composites with
// the volume in its own space and depth. Tiles stream in via NVSlide's cache;
// the controller redraws on the slide's `change` event, and this renderer
// uploads any newly-resident bitmaps on the next frame.

const vertSrc = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
uniform mat4 mvpMtx;
out vec2 vUV;
void main(){ vUV = aUV; gl_Position = mvpMtx * vec4(aPos, 1.0); }`

/** Fragment shader, with or without the slide's colour table lookup. */
const fragSrc = (lut: boolean): string => `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D tileTex;
uniform float opacity;
${colorLutGlsl(lut)}
out vec4 outColor;
void main(){
  vec4 c = texture(tileTex, vUV);
  outColor = vec4(applyColorLut(c.rgb), c.a * opacity);
}`

export class SlidePlaneRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null // plain: identity tables and annotations
  private _lutShader: Shader | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _vbo: WebGLBuffer | null = null
  // One texture per resident tile, keyed by NVSlide tile key. Byte-budgeted:
  // textures for tiles that leave the working set are evicted each frame.
  private readonly _textures = new TileTextureCache<TileTextureGL>(
    DEFAULT_TILE_TEXTURE_BYTES,
    (tile) => this._gl?.deleteTexture(tile.texture),
  )
  private readonly _gutter = new TileGutterGL()
  private readonly _fuser = new TileFuserGL()
  private readonly _budget = new SlideBudgetRegistration(
    this,
    DEFAULT_RAW_POOL_BYTES,
  )
  // Annotation overlay (slide-space drawing) texture + uploaded version.
  private _annTex: WebGLTexture | null = null
  private _annVersion = -1
  private readonly _luts = new ColorLutTexturesGL()

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl
    this._shader = new Shader(gl, vertSrc, fragSrc(false))
    this._lutShader = new Shader(gl, vertSrc, fragSrc(true))
    // Sampler units are program state: set once (the lookup table is on unit 1).
    for (const shader of [this._shader, this._lutShader]) {
      shader.use(gl)
      gl.uniform1i(shader.uniforms.tileTex ?? null, 0)
      gl.uniform1i(shader.uniforms.colorLut ?? null, 1)
    }
    this._vao = gl.createVertexArray()
    this._vbo = gl.createBuffer()
    if (!this._vao || !this._vbo) {
      throw new Error('Failed to create slide-plane GL objects')
    }
    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    // Interleaved [pos.xyz, uv.xy] = 5 floats / 20 bytes per vertex.
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12)
    gl.bindVertexArray(null)
    this.isReady = true
  }

  private _textureFor(
    gl: WebGL2RenderingContext,
    slide: NVSlide,
    tile: SlidePlaneTile,
    cached: NVSlideCachedTile,
  ): TileTextureGL | null {
    const at = { ...tile, slide, key: slideTileKey(slide, tile.key) }
    if (isFuseTile(cached))
      return this._fuser.textureFor(
        gl,
        this._gutter,
        this._textures,
        at,
        slide,
        cached,
      )
    const { bitmap } = cached
    if (!bitmap) return null
    const existing = this._textures.get(at.key, bitmap)
    if (existing) return existing
    return this._gutter.upload(gl, bitmap, at, this._textures)
  }

  /** Bind the program and uniforms, and set the plane's depth/blend state. */
  private _begin(
    gl: WebGL2RenderingContext,
    shader: Shader,
    mvpMatrix: Float32Array,
    opacity: number,
  ): void {
    shader.use(gl)
    if (shader.uniforms.mvpMtx) {
      gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
    }
    if (shader.uniforms.opacity) {
      gl.uniform1f(shader.uniforms.opacity, opacity)
    }
    // Depth-test so volume in front occludes the plane, but don't write depth
    // (the plane is a thin overlay; let later layers blend over it too).
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(false)
    // The plane is two-sided — show it from either face.
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  draw(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    tiles: readonly SlidePlaneTile[],
    slide: NVSlide,
    opacity = 1,
  ): void {
    if (!this.isReady || !this._shader || !this._vao || !this._vbo) return
    this._budget.sync([slide])
    // Evict BEFORE beginFrame so the previous frame's working set is exempt.
    // The raw pool takes its bytes from the texture budget only while it holds
    // layers (scalar tiles), so RGB slides keep the whole budget.
    this._textures.evictToBudget(tileTextureBudget(this._fuser.poolBytes))
    this._textures.beginFrame()
    gl.activeTexture(gl.TEXTURE0)
    // Upload and fuse every tile before drawing any: an upload refreshes
    // resident neighbours' gutters, which must land before those are drawn.
    const drawn: [SlidePlaneTile, TileTextureGL][] = []
    for (const tile of tiles) {
      const cached = slide.cachedTile(tile.key)
      const tex = cached && this._textureFor(gl, slide, tile, cached)
      if (tex) drawn.push([tile, tex])
    }
    this._fuser.flush(gl, this._gutter, this._textures, true)
    const lut = slide.displayColorLut
    let shader = this._shader
    if (lut && this._lutShader) {
      shader = this._lutShader
      this._luts.bind(gl, lut)
    }
    this._begin(gl, shader, mvpMatrix, opacity)
    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    for (const [tile, tex] of drawn) {
      gl.bufferData(
        gl.ARRAY_BUFFER,
        cornerQuad(tile.corners, tex),
        gl.DYNAMIC_DRAW,
      )
      gl.bindTexture(gl.TEXTURE_2D, tex.texture)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    if (lut) this._luts.bind(gl, null)
    gl.bindVertexArray(null)
    gl.depthMask(true)
  }

  /** Draw the slide-space annotation raster as one quad over the whole slide. */
  drawAnnotation(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    ann: SlidePlaneAnnotation,
    opacity = 1,
  ): void {
    if (!this.isReady || !this._shader || !this._vao || !this._vbo) return
    if (!this._annTex) this._annTex = gl.createTexture()
    if (!this._annTex) return
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._annTex)
    if (this._annVersion !== ann.version) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        ann.width,
        ann.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        ann.rgba,
      )
      setTexParams(gl, gl.TEXTURE_2D, gl.LINEAR, gl.NEAREST)
      this._annVersion = ann.version
    }
    this._begin(gl, this._shader, mvpMatrix, opacity)
    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    gl.bufferData(gl.ARRAY_BUFFER, cornerQuad(ann.corners), gl.DYNAMIC_DRAW)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    gl.depthMask(true)
  }

  /** Unregister from the slide last drawn; the next draw registers again. */
  clearBudget(): void {
    this._budget.clear()
  }

  destroy(): void {
    this._budget.clear()
    const gl = this._gl
    if (!gl) return
    this._textures.clear()
    this._fuser.destroy(gl)
    this._gutter.destroy(gl)
    this._luts.clear(gl)
    if (this._annTex) gl.deleteTexture(this._annTex)
    if (this._vao) gl.deleteVertexArray(this._vao)
    if (this._vbo) gl.deleteBuffer(this._vbo)
    if (this._shader?.program) gl.deleteProgram(this._shader.program)
    if (this._lutShader?.program) gl.deleteProgram(this._lutShader.program)
    this._lutShader = null
    this.isReady = false
    this._shader = null
    this._vao = null
    this._vbo = null
    this._annTex = null
    this._gl = null
  }
}
