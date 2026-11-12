import type { NVSlide, NVSlideTileSamples } from '@/slide/NVSlide'
import {
  DEFAULT_RAW_POOL_BYTES,
  type FuseJob,
  FuseLutRows,
  type FuseTile,
  fuseTarget,
  fuseTiles,
  fuseUniforms,
  type RawFormat,
  rawFormat,
} from '@/slide/slideFuse'
import type { GutterAt } from '@/slide/tileGutter'
import { TileTextureCache } from '@/slide/tileTextureCache'
import { setTexParams } from './glUtil'
import { Shader } from './shader'
import type { TileGutterGL, TileTextureGL } from './tileGutter'

// The fuse pass (slide/slideFuse.ts) on WebGL2: renders each scalar tile's
// visible channels into its RGBA8 tile texture, one triangle per channel,
// blended with MAX or a clamped sum.

type RawGL = { texture: WebGLTexture | null; format: RawFormat }

const vertSrc = `#version 300 es
void main() {
  // One triangle over the viewport.
  gl_Position = vec4(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0, 0.0, 1.0);
}`

const fragSrc = (sampler: string): string => `#version 300 es
precision highp float;
precision highp int;
uniform highp ${sampler} raw;
uniform highp sampler2D lut;
// fuseUniforms, halved: calMin head, width / 512, LUT row, invert; then the calMin remainder
uniform vec4 window;
uniform float calMinRest;
out vec4 color;
void main() {
  float v = float(texelFetch(raw, ivec2(gl_FragCoord.xy) - 1, 0).r);
  // max() keeps the compiler from folding the two uniforms into one float32 calMin.
  // Halved, as the uniforms (fuseUniforms): v - calMin cannot overflow.
  float d = max(v * 0.5 - window.x, -3.4e38) - calMinRest;
  // n / w is the level; d * 255 / 256 cannot overflow either.
  float n = d * 0.99609375;
  float w = window.y;
  // Math.round(n / w): floor(x + 0.5), then undo a division rounded across a tie.
  float g = floor(n / w + 0.5);
  if ((g - 0.5) * w > n) g -= 1.0;
  else if ((g + 0.5) * w <= n) g += 1.0;
  // NaN fails the test: level 0, as fuseSamples (clamp(NaN) is undefined).
  g = n > 0.0 ? min(g, 255.0) : 0.0;
  if (window.w > 0.5) g = 255.0 - g;
  color = vec4(texelFetch(lut, ivec2(int(g), int(window.z)), 0).rgb, 1.0);
}`

const SAMPLERS: Record<RawFormat, string> = {
  u8: 'usampler2D',
  u16: 'usampler2D',
  i16: 'isampler2D',
  f32: 'sampler2D',
}

export class TileFuserGL {
  private _gl: WebGL2RenderingContext | null = null
  private readonly _pool: TileTextureCache<RawGL>
  private readonly _luts = new FuseLutRows()
  private _lutTexture: WebGLTexture | null = null
  private _lutVersion = -1
  private readonly _shaders = new Map<string, Shader>()
  private _fb: WebGLFramebuffer | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _jobs: FuseJob<TileTextureGL>[] = []
  private _maxTexture = 0

  constructor(maxRawPoolBytes = DEFAULT_RAW_POOL_BYTES) {
    this._pool = new TileTextureCache<RawGL>(maxRawPoolBytes, (raw) =>
      this._gl?.deleteTexture(raw.texture),
    )
  }

  /** GPU bytes of pooled raw layers. */
  get poolBytes(): number {
    return this._pool.bytes
  }

  /** The tile texture of scalar `tile`, queued for `flush` (see `fuseTarget`). */
  textureFor(
    gl: WebGL2RenderingContext,
    gutter: TileGutterGL,
    cache: TileTextureCache<TileTextureGL>,
    at: GutterAt,
    slide: NVSlide,
    tile: FuseTile,
  ): TileTextureGL | null {
    this._maxTexture ||= gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    return fuseTarget(
      this._jobs,
      cache,
      at,
      slide,
      tile,
      this._maxTexture,
      (width, height) => gutter.create(gl, width, height, at),
    )
  }

  /** Fuse the queued tiles, then refresh their gutters (`sync` false: defer). */
  flush(
    gl: WebGL2RenderingContext,
    gutter: TileGutterGL,
    cache: TileTextureCache<TileTextureGL>,
    sync: boolean,
  ): void {
    const jobs = this._jobs
    if (jobs.length === 0) return
    this._jobs = []
    this._gl = gl
    for (const job of jobs)
      for (const l of job.plan.layers) this._luts.row(l.colormap)
    // The callers draw mid-frame (NVViewGL's slide plane): keep their state.
    const saved = {
      fb: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
      clear: gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array,
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      active: gl.getParameter(gl.ACTIVE_TEXTURE) as number,
      align: gl.getParameter(gl.UNPACK_ALIGNMENT) as number,
      flipY: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean,
      eqRgb: gl.getParameter(gl.BLEND_EQUATION_RGB) as number,
      eqAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA) as number,
      srcRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number,
      dstRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
      srcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA) as number,
      dstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
      caps: [gl.BLEND, gl.SCISSOR_TEST, gl.DEPTH_TEST, gl.CULL_FACE].map(
        (cap) => [cap, gl.isEnabled(cap)] as const,
      ),
    }
    gl.activeTexture(gl.TEXTURE1)
    const unit1 = gl.getParameter(gl.TEXTURE_BINDING_2D)
    this._syncLut(gl)
    gl.activeTexture(gl.TEXTURE0)
    const unit0 = gl.getParameter(gl.TEXTURE_BINDING_2D)

    this._fb ??= gl.createFramebuffer()
    this._vao ??= gl.createVertexArray()
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._fb)
    gl.bindVertexArray(this._vao)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.clearColor(0, 0, 0, 1)
    // Edge tiles have odd widths: rows are not 4-byte aligned.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    fuseTiles(
      jobs,
      this._pool,
      (s, plane) => this._upload(gl, s, plane),
      ({ target, plan }, layers) => {
        gl.framebufferTexture2D(
          gl.DRAW_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          target.texture,
          0,
        )
        gl.viewport(0, 0, target.width + 2, target.height + 2)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.viewport(1, 1, target.width, target.height)
        gl.blendEquation(plan.additive ? gl.FUNC_ADD : gl.MAX)
        for (const [l, raw] of layers) {
          const shader = this._shader(gl, raw.format)
          shader.use(gl)
          const u = fuseUniforms(l, this._luts.row(l.colormap), plan.invert)
          gl.uniform4f(shader.uniforms.window ?? null, u[0], u[1], u[2], u[3])
          gl.uniform1f(shader.uniforms.calMinRest ?? null, u[4])
          gl.bindTexture(gl.TEXTURE_2D, raw.texture)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
      },
    )
    gl.framebufferTexture2D(
      gl.DRAW_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      null,
      0,
    )

    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.fb)
    const [x, y, w, h] = saved.viewport
    gl.viewport(x as number, y as number, w as number, h as number)
    const [r, g, b, a] = saved.clear
    gl.clearColor(r as number, g as number, b as number, a as number)
    gl.useProgram(saved.program)
    gl.bindVertexArray(saved.vao)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, saved.align)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, saved.flipY)
    gl.blendEquationSeparate(saved.eqRgb, saved.eqAlpha)
    gl.blendFuncSeparate(
      saved.srcRgb,
      saved.dstRgb,
      saved.srcAlpha,
      saved.dstAlpha,
    )
    for (const [cap, on] of saved.caps)
      if (on) gl.enable(cap)
      else gl.disable(cap)
    gl.bindTexture(gl.TEXTURE_2D, unit0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, unit1)
    gl.activeTexture(saved.active)

    gutter.sync(
      gl,
      jobs.map((j) => j.target),
      cache,
      sync,
    )
  }

  // The LUT texture on unit 1 (active), re-uploaded when a colormap was added.
  private _syncLut(gl: WebGL2RenderingContext): void {
    if (this._lutVersion !== this._luts.version) {
      gl.deleteTexture(this._lutTexture)
      this._lutTexture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this._lutTexture)
      setTexParams(gl, gl.TEXTURE_2D, gl.NEAREST)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        256,
        this._luts.rows,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this._luts.data,
      )
      this._lutVersion = this._luts.version
    }
    gl.bindTexture(gl.TEXTURE_2D, this._lutTexture)
  }

  private _shader(gl: WebGL2RenderingContext, format: RawFormat): Shader {
    const sampler = SAMPLERS[format]
    let shader = this._shaders.get(sampler)
    if (!shader) {
      shader = new Shader(gl, vertSrc, fragSrc(sampler))
      shader.use(gl)
      gl.uniform1i(shader.uniforms.raw ?? null, 0)
      gl.uniform1i(shader.uniforms.lut ?? null, 1)
      this._shaders.set(sampler, shader)
    }
    return shader
  }

  // Plane `plane` of `s` as an integer (or float) texture on unit 0.
  private _upload(
    gl: WebGL2RenderingContext,
    s: NVSlideTileSamples,
    plane: number,
  ): RawGL {
    const format = rawFormat(s.samples)
    const [internal, layout, type] = {
      u8: [gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE],
      u16: [gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT],
      i16: [gl.R16I, gl.RED_INTEGER, gl.SHORT],
      f32: [gl.R32F, gl.RED, gl.FLOAT],
    }[format]
    const n = s.width * s.height
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, s.width, s.height)
    // Integer textures are incomplete under linear filtering.
    setTexParams(gl, gl.TEXTURE_2D, gl.NEAREST)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      s.width,
      s.height,
      layout,
      type,
      s.samples.subarray(plane * n, (plane + 1) * n),
    )
    return { texture, format }
  }

  /** Drop the pooled raw layers (tile textures belong to the caller's cache). */
  clear(): void {
    this._pool.clear()
    this._jobs = []
  }

  destroy(gl: WebGL2RenderingContext | null): void {
    this._gl = gl
    this.clear()
    for (const shader of this._shaders.values())
      gl?.deleteProgram(shader.program)
    this._shaders.clear()
    gl?.deleteTexture(this._lutTexture)
    gl?.deleteFramebuffer(this._fb)
    gl?.deleteVertexArray(this._vao)
    this._lutTexture = null
    this._lutVersion = -1
    this._maxTexture = 0
    this._fb = null
    this._vao = null
  }
}
