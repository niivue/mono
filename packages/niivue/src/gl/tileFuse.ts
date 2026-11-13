import type { NVSlide, NVSlideTileSamples } from '@/slide/NVSlide'
import {
  DEFAULT_RAW_POOL_BYTES,
  type FuseJob,
  FuseLutRows,
  type FuseTile,
  fuseTarget,
  fuseTiles,
  fuseUniforms,
  type LabelTable,
  labelUniforms,
  liveLabelTables,
  pruneLabelTables,
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
// fuseUniforms, all times scale: calMin head, width, LUT row, invert; then the calMin remainder
uniform vec4 window;
uniform float calMinRest;
uniform float scale;
out vec4 color;
void main() {
  float v = float(texelFetch(raw, ivec2(gl_FragCoord.xy) - 1, 0).r);
  // max() keeps the compiler from folding the two uniforms into one float32 calMin.
  // Scaled as the uniforms (fuseUniforms); a sample far outside the window
  // may reach +-Infinity, which still lands on level 255 or 0.
  float d = max(v * scale - window.x, -3.4e38) - calMinRest;
  float n = d * 255.0;
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

// Label layers (fuseSamples' label loop): the ID through its table, else the
// labelColor hash, the highlight scale applied; integer math, so exact.
const labelFragSrc = (sampler: string): string => `#version 300 es
precision highp float;
precision highp int;
uniform highp ${sampler} raw;
uniform highp usampler2D table;
// labelUniforms: selected ID, scale of the others in 256ths, table size, table width
uniform uvec4 label;
out vec4 color;
uvec3 labelColor(uint h) {
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return 64u + (((uvec3(h, h >> 8u, h >> 16u) & 255u) * 3u) >> 2u);
}
void main() {
  float v = float(texelFetch(raw, ivec2(gl_FragCoord.xy) - 1, 0).r);
  // uint() of NaN or a negative is undefined: 0, as labelId.
  uint id = v > 0.0 ? uint(v) : 0u;
  uvec3 c = id < label.z ? texelFetch(table, ivec2(id % label.w, id / label.w), 0).rgb : labelColor(id);
  c = (c * (id == label.x ? 256u : label.y)) >> 8u;
  color = vec4(vec3(c) / 255.0, 1.0);
}`

const SAMPLERS: Record<RawFormat, string> = {
  u8: 'usampler2D',
  u16: 'usampler2D',
  i16: 'isampler2D',
  f32: 'sampler2D',
}

export class TileFuserGL {
  /** The context tiles are fused in; the renderer sets it in `init`. */
  gl: WebGL2RenderingContext | null = null
  private readonly _pool: TileTextureCache<RawGL>
  private readonly _luts = new FuseLutRows()
  private _lutTexture: WebGLTexture | null = null
  private _lutVersion = -1
  private readonly _shaders = new Map<string, Shader>()
  // One per labelColors array, freed by clear.
  private readonly _tables = new Map<LabelTable, WebGLTexture | null>()
  private _fb: WebGLFramebuffer | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _jobs: FuseJob<TileTextureGL>[] = []
  private _maxTexture = 0

  constructor(maxRawPoolBytes = DEFAULT_RAW_POOL_BYTES) {
    this._pool = new TileTextureCache<RawGL>(maxRawPoolBytes, (raw) =>
      this.gl?.deleteTexture(raw.texture),
    )
  }

  /** GPU bytes of pooled raw layers. */
  get poolBytes(): number {
    return this._pool.bytes
  }

  /** The tile texture of scalar `tile`, queued for `flush` (see `fuseTarget`). */
  textureFor(
    gutter: TileGutterGL,
    cache: TileTextureCache<TileTextureGL>,
    at: GutterAt,
    slide: NVSlide,
    tile: FuseTile,
  ): TileTextureGL | null {
    const gl = this.gl as WebGL2RenderingContext
    this._maxTexture ||= gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    return fuseTarget(
      this._jobs,
      cache,
      at,
      slide,
      tile,
      this._maxTexture,
      (width, height, labels) => {
        const t = gutter.create(width, height, at)
        // Read with texelFetch (nearest), so it needs no gutter of its own.
        if (labels) t.labels = gutter.create(width, height, at).texture
        return t
      },
    )
  }

  /** Fuse the queued tiles, then refresh their gutters (`sync` false: defer). */
  flush(
    gutter: TileGutterGL,
    cache: TileTextureCache<TileTextureGL>,
    sync: boolean,
  ): void {
    const jobs = this._jobs
    if (jobs.length === 0) return
    this._jobs = []
    const gl = this.gl as WebGL2RenderingContext
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
    const hasLabels = jobs.some((j) => j.plan.labels.length > 0)
    let unit2: WebGLTexture | null = null
    if (hasLabels) {
      gl.activeTexture(gl.TEXTURE2)
      unit2 = gl.getParameter(gl.TEXTURE_BINDING_2D)
    }
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
      ({ target, plan }, layers, labels) => {
        const into = (texture: WebGLTexture) => {
          gl.framebufferTexture2D(
            gl.DRAW_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            texture,
            0,
          )
          gl.viewport(0, 0, target.width + 2, target.height + 2)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.viewport(1, 1, target.width, target.height)
        }
        into(target.texture)
        gl.blendEquation(plan.additive ? gl.FUNC_ADD : gl.MAX)
        for (const [l, raw] of layers) {
          const shader = this._shader(gl, raw.format)
          shader.use(gl)
          const u = fuseUniforms(l, this._luts.row(l.colormap), plan.invert)
          gl.uniform4f(shader.uniforms.window ?? null, u[0], u[1], u[2], u[3])
          gl.uniform1f(shader.uniforms.calMinRest ?? null, u[4])
          gl.uniform1f(shader.uniforms.scale ?? null, u[5])
          gl.bindTexture(gl.TEXTURE_2D, raw.texture)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
        if (target.labels) into(target.labels)
        for (const [l, raw] of labels) {
          const shader = this._shader(gl, raw.format, true)
          shader.use(gl)
          const [sel, other, size, width] = labelUniforms(l)
          gl.uniform4ui(shader.uniforms.label ?? null, sel, other, size, width)
          gl.activeTexture(gl.TEXTURE2)
          gl.bindTexture(gl.TEXTURE_2D, this._table(gl, l.table))
          gl.activeTexture(gl.TEXTURE0)
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
    if (hasLabels) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, unit2)
    }
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, unit1)
    gl.activeTexture(saved.active)

    gutter.sync(
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

  private _shader(
    gl: WebGL2RenderingContext,
    format: RawFormat,
    label = false,
  ): Shader {
    const sampler = SAMPLERS[format]
    const key = label ? `label ${sampler}` : sampler
    let shader = this._shaders.get(key)
    if (!shader) {
      shader = new Shader(
        gl,
        vertSrc,
        label ? labelFragSrc(sampler) : fragSrc(sampler),
      )
      shader.use(gl)
      gl.uniform1i(shader.uniforms.raw ?? null, 0)
      gl.uniform1i(shader.uniforms.lut ?? null, 1)
      gl.uniform1i(shader.uniforms.table ?? null, 2)
      this._shaders.set(key, shader)
    }
    return shader
  }

  // The RGBA8UI texture of `table`, made on first use.
  private _table(
    gl: WebGL2RenderingContext,
    table: LabelTable,
  ): WebGLTexture | null {
    let texture = this._tables.get(table)
    if (texture === undefined) {
      texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      const rows = table.colors.length / table.width
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8UI, table.width, rows)
      setTexParams(gl, gl.TEXTURE_2D, gl.NEAREST)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        table.width,
        rows,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        new Uint8Array(table.colors.buffer),
      )
      this._tables.set(table, texture)
    }
    return texture
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

  /**
   * Free the label tables (CPU and GPU) no slide in `slides` uses: a replaced
   * label slide's tables go on the next frame. No-op without tables.
   */
  retainLabelTables(slides: readonly NVSlide[]): void {
    if (this._tables.size === 0) return
    pruneLabelTables(this._tables, liveLabelTables(slides), (t) =>
      this.gl?.deleteTexture(t),
    )
  }

  /** Drop the pooled raw layers and label tables (tile textures belong to the caller's cache). */
  clear(): void {
    this._pool.clear()
    this._jobs = []
    for (const texture of this._tables.values()) this.gl?.deleteTexture(texture)
    this._tables.clear()
  }

  destroy(): void {
    const gl = this.gl
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
