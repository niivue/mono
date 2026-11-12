import { colorLutGlsl } from '@/slide/colorLutShader'
import type { NVSlide, NVSlideCachedTile } from '@/slide/NVSlide'
import {
  DEFAULT_RAW_POOL_BYTES,
  isFuseTile,
  SlideBudgetRegistration,
} from '@/slide/slideFuse'
import {
  cornerQuad,
  type SlidePlaneAnnotation,
  type SlidePlaneTile,
  slideExtentCorners,
} from '@/slide/slidePlane'
import {
  frameTextureBudget,
  planeQuad,
  planTextures,
  sameTiles,
} from '@/slide/slideTiles'
import type { GutterAt } from '@/slide/tileGutter'
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
uniform int isNearest;
// A mixed fused tile's label channels (slideFuse.ts fuseTarget), combined
// nearest with the intensity: 0 none, 1 max, 2 saturating sum.
uniform sampler2D labelTexture;
uniform int labelBlend;
${colorLutGlsl(lut)}
out vec4 outColor;
void main(){
  vec2 uv = vUV;
  // Nearest: clamp to the interior's edge texels so the gutter never shows
  // (as the 2D slide shader does).
  if (isNearest == 1) {
    vec2 size = vec2(textureSize(tileTex, 0));
    uv = clamp(uv * size, vec2(1.5), size - 1.5) / size;
  }
  vec4 c = texture(tileTex, uv);
  if (labelBlend != 0) {
    ivec2 size = textureSize(tileTex, 0);
    vec3 l = texelFetch(labelTexture, clamp(ivec2(vUV * vec2(size)), ivec2(1), size - 2), 0).rgb;
    c.rgb = labelBlend == 2 ? min(c.rgb + l, 1.0) : max(c.rgb, l);
  }
  outColor = vec4(applyColorLut(c.rgb), c.a * opacity);
}`

// Interleaved [pos.xyz, uv.xy]: 5 floats a vertex, 20 a quad.
const QUAD_FLOATS = 20

function quadVao(
  gl: WebGL2RenderingContext,
): [WebGLVertexArrayObject, WebGLBuffer] {
  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  if (!vao || !vbo) throw new Error('Failed to create slide-plane GL objects')
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12)
  gl.bindVertexArray(null)
  return [vao, vbo]
}

export class SlidePlaneRenderer extends NVRenderer {
  /** Sample tiles nearest-neighbour instead of linear (the views set it). */
  isNearestInterpolation = false
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null // plain: identity tables and annotations
  private _lutShader: Shader | null = null
  // Tiles: the absent-colour quad (vertices 0-3), then one quad per tile.
  private _vao: WebGLVertexArrayObject | null = null
  private _vbo: WebGLBuffer | null = null
  private _annVao: WebGLVertexArrayObject | null = null
  private _annVbo: WebGLBuffer | null = null
  private _annCorners: SlidePlaneAnnotation['corners'] | null = null
  private _nearestSampler: WebGLSampler | null = null
  // One texture per resident tile, keyed by NVSlide tile key. Byte-budgeted:
  // textures for tiles that leave the working set are evicted each frame.
  private readonly _textures = new TileTextureCache<TileTextureGL>(
    DEFAULT_TILE_TEXTURE_BYTES,
    (tile) => {
      this._gl?.deleteTexture(tile.texture)
      if (tile.labels) this._gl?.deleteTexture(tile.labels)
    },
  )
  private readonly _gutter = new TileGutterGL()
  private readonly _fuser = new TileFuserGL()
  private readonly _budget = new SlideBudgetRegistration(
    this,
    DEFAULT_RAW_POOL_BYTES,
  )
  // The tile set the vertex buffer holds, with the texture size each quad's
  // UVs were inset for (a decoded or fitted tile can differ from its manifest).
  private _built: readonly SlidePlaneTile[] = []
  private _builtFor: {
    slide: NVSlide
    pixelToWorld?: readonly number[]
  } | null = null
  private readonly _insets: { width: number; height: number }[] = []
  private readonly _cached: (NVSlideCachedTile | null)[] = []
  private readonly _ats: GutterAt[] = []
  private readonly _drawn: (TileTextureGL | null)[] = []
  private readonly _at = new WeakMap<SlidePlaneTile, GutterAt>()
  // The slide's absent colour as a 1x1 texture, and the colour it holds.
  private _bgTex: WebGLTexture | null = null
  private readonly _bgSource = new Float64Array(4)
  private readonly _bgColor = new Uint8ClampedArray(4)
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
      gl.uniform1i(shader.uniforms.labelTexture ?? null, 2)
    }
    ;[this._vao, this._vbo] = quadVao(gl)
    ;[this._annVao, this._annVbo] = quadVao(gl)
    this._nearestSampler = gl.createSampler()
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.samplerParameteri(this._nearestSampler, p, gl.NEAREST)
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.samplerParameteri(this._nearestSampler, p, gl.CLAMP_TO_EDGE)
    this.isReady = true
  }

  private _atOf(slide: NVSlide, tile: SlidePlaneTile): GutterAt {
    let at = this._at.get(tile)
    if (!at) {
      at = { ...tile, slide, key: slideTileKey(slide, tile.key) }
      this._at.set(tile, at)
    }
    return at
  }

  private _textureFor(
    gl: WebGL2RenderingContext,
    slide: NVSlide,
    at: GutterAt,
    cached: NVSlideCachedTile,
  ): TileTextureGL | null {
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
    gl.uniform1i(shader.uniforms.isNearest ?? null, 0)
    gl.uniform1i(shader.uniforms.labelBlend ?? null, 0)
    // Depth-test so volume in front occludes the plane, but don't write depth
    // (the plane is a thin overlay; let later layers blend over it too).
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(false)
    // The plane is two-sided — show it from either face.
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  // One vertex buffer for the tile set: the extent quad, then every tile.
  // ponytail: one buffer, so two render tiles with different tile sets
  // rebuild it per draw; per-tile buffers if that shows up in a profile.
  private _buildVertices(
    gl: WebGL2RenderingContext,
    tiles: readonly SlidePlaneTile[],
    slide: NVSlide,
    pixelToWorld?: readonly number[],
  ): void {
    const data = new Float32Array((tiles.length + 1) * QUAD_FLOATS)
    if (pixelToWorld) {
      const { width, height } = slide.manifest
      data.set(cornerQuad(slideExtentCorners(pixelToWorld, width, height)))
    }
    this._insets.length = 0
    tiles.forEach((tile, i) => {
      data.set(planeQuad(tile, tile), (i + 1) * QUAD_FLOATS)
      this._insets.push(tile)
    })
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    this._built = tiles
    this._builtFor = { slide, pixelToWorld }
  }

  /**
   * Draw `tiles` (coarser fallback tiles first, then the target level) with
   * `mvpMatrix`. With `pixelToWorld` and a slide whose manifest states its
   * absent colour (DICOM (0048,0015)), the slide extent is filled with
   * `slide.backgroundColor` under the tiles; otherwise holes stay transparent.
   */
  draw(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    tiles: readonly SlidePlaneTile[],
    slide: NVSlide,
    opacity = 1,
    pixelToWorld?: readonly number[],
  ): void {
    if (!this.isReady || !this._shader || !this._vao || !this._vbo) return
    this._budget.sync([slide])
    if (this._gl) this._fuser.retainLabelTables(this._gl, [slide])
    const cached = this._cached
    const ats = this._ats
    cached.length = ats.length = 0
    let fuses = false
    for (const tile of tiles) {
      const c = slide.cachedTile(tile.key)
      if (c && isFuseTile(c)) fuses = true
      cached.push(c)
      ats.push(this._atOf(slide, tile))
    }
    // Evict BEFORE beginFrame so the previous frame's working set is exempt.
    this._textures.evictToBudget(
      frameTextureBudget(fuses, this._fuser.poolBytes, DEFAULT_RAW_POOL_BYTES),
    )
    this._textures.beginFrame()
    gl.activeTexture(gl.TEXTURE0)
    // Upload and fuse every tile before drawing any: an upload refreshes
    // resident neighbours' gutters, which must land before those are drawn.
    const drawn = this._drawn
    planTextures(
      this._textures,
      ats,
      cached,
      (i) =>
        this._textureFor(
          gl,
          slide,
          ats[i] as GutterAt,
          cached[i] as NVSlideCachedTile,
        ),
      drawn,
    )
    this._fuser.flush(gl, this._gutter, this._textures, true)

    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    const absent = pixelToWorld && slide.manifest.backgroundColor
    const built = this._builtFor
    if (
      !sameTiles(tiles, this._built) ||
      built?.slide !== slide ||
      built.pixelToWorld !== pixelToWorld
    )
      this._buildVertices(gl, tiles, slide, pixelToWorld)
    if (absent) {
      this._begin(gl, this._shader, mvpMatrix, opacity)
      gl.bindTexture(gl.TEXTURE_2D, this._absentTexture(gl, slide))
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    const lut = slide.displayColorLut
    const shader = (lut && this._lutShader) || this._shader
    if (lut) this._luts.bind(gl, lut)
    this._begin(gl, shader, mvpMatrix, opacity)
    let nearest = false
    let labelBlend = 0
    // Unit 2's binding before the first label texture (a shared context), restored after.
    let unit2: WebGLTexture | null | undefined
    const sum = slide.channelBlend === 'additive' ? 2 : 1
    for (let i = 0; i < tiles.length; i++) {
      const tex = drawn[i]
      if (!tex) continue
      const inset = this._insets[i] as { width: number; height: number }
      if (tex.width !== inset.width || tex.height !== inset.height) {
        this._insets[i] = tex
        const tile = tiles[i] as SlidePlaneTile
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          (i + 1) * QUAD_FLOATS * 4,
          planeQuad(tile, tex),
        )
      }
      // A fused tile of label channels samples nearest whatever the mode.
      const n = this.isNearestInterpolation || tex.nearest === true
      if (n !== nearest) {
        nearest = n
        gl.uniform1i(shader.uniforms.isNearest ?? null, n ? 1 : 0)
        gl.bindSampler(0, n ? this._nearestSampler : null)
      }
      const blend = tex.labels ? sum : 0
      if (blend !== labelBlend) {
        labelBlend = blend
        gl.uniform1i(shader.uniforms.labelBlend ?? null, blend)
      }
      if (tex.labels) {
        gl.activeTexture(gl.TEXTURE2)
        if (unit2 === undefined)
          unit2 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
        gl.bindTexture(gl.TEXTURE_2D, tex.labels)
        gl.activeTexture(gl.TEXTURE0)
      }
      gl.bindTexture(gl.TEXTURE_2D, tex.texture)
      gl.drawArrays(gl.TRIANGLE_STRIP, (i + 1) * 4, 4)
    }
    if (unit2 !== undefined) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, unit2)
      gl.activeTexture(gl.TEXTURE0)
    }
    gl.bindSampler(0, null)
    if (lut) this._luts.bind(gl, null)
    gl.bindVertexArray(null)
    gl.depthMask(true)
  }

  // A 1x1 texture of the slide's absent colour, re-uploaded when it changes.
  private _absentTexture(
    gl: WebGL2RenderingContext,
    slide: NVSlide,
  ): WebGLTexture | null {
    const color = slide.backgroundColor
    if (this._bgTex && color.every((c, i) => c === this._bgSource[i]))
      return this._bgTex
    this._bgTex ??= gl.createTexture()
    this._bgSource.set(color)
    this._bgColor.set(color.map((c) => c * 255))
    gl.bindTexture(gl.TEXTURE_2D, this._bgTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this._bgColor,
    )
    setTexParams(gl, gl.TEXTURE_2D, gl.NEAREST)
    return this._bgTex
  }

  /** Draw the slide-space annotation raster as one quad over the whole slide. */
  drawAnnotation(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    ann: SlidePlaneAnnotation,
    opacity = 1,
  ): void {
    if (!this.isReady || !this._shader || !this._annVao) return
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
    gl.bindVertexArray(this._annVao)
    if (this._annCorners !== ann.corners) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this._annVbo)
      gl.bufferData(gl.ARRAY_BUFFER, cornerQuad(ann.corners), gl.STATIC_DRAW)
      this._annCorners = ann.corners
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    gl.depthMask(true)
  }

  /** Unregister from the slide last drawn; the next draw registers again. */
  clearBudget(): void {
    this._budget.clear()
    // The replaced slide's label tables go too; a new slide re-makes its own.
    if (this._gl) this._fuser.retainLabelTables(this._gl, [])
  }

  destroy(): void {
    this._budget.clear()
    const gl = this._gl
    if (!gl) return
    this._textures.clear()
    this._fuser.destroy(gl)
    this._gutter.destroy(gl)
    this._luts.clear(gl)
    for (const t of [this._annTex, this._bgTex]) if (t) gl.deleteTexture(t)
    for (const v of [this._vao, this._annVao]) if (v) gl.deleteVertexArray(v)
    for (const b of [this._vbo, this._annVbo]) if (b) gl.deleteBuffer(b)
    gl.deleteSampler(this._nearestSampler)
    if (this._shader?.program) gl.deleteProgram(this._shader.program)
    if (this._lutShader?.program) gl.deleteProgram(this._lutShader.program)
    this._lutShader = null
    this.isReady = false
    this._shader = null
    this._vao = this._annVao = null
    this._vbo = this._annVbo = null
    this._annTex = this._bgTex = null
    this._nearestSampler = null
    this._annCorners = null
    this._built = []
    this._builtFor = null
    this._gl = null
  }
}
