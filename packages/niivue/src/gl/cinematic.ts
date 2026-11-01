import { log } from '@/logger'
import type { CinematicOptions, NVImage } from '@/NVTypes'
import {
  type BakedTransferFunction,
  CinematicCpuCache,
  CinematicFrameTimer,
  type CinematicGeometry,
  type CinematicTileInput,
  DISPLAY_PARAM_FLOATS,
  EXT_PARAM_FLOATS,
  MARCH_PARAM_FLOATS,
  MATERIAL_TEXELS,
  packDisplayParams,
  packExtinctionParams,
  TF_H,
  TF_W,
  tileKey,
  tileMarchParams,
} from '@/view/NVCinematic'
import { NVRenderer } from '@/view/NVRenderer'
import {
  cinematicDisplayShader,
  cinematicDownsampleShader,
  cinematicExtinctionShader,
  cinematicGradientShader,
  cinematicMarchShader,
  cinematicVertexShader,
} from './cinematicShader'
import { Shader } from './shader'

/** Per-tile accumulation, keyed by tile index. */
type TileState = {
  width: number
  height: number
  /** RGBA16F running mean. */
  accum: WebGLTexture
  /** R32F first-hit window depth, written on frame 0 only. */
  depth: WebGLTexture
  /** accum + depth, for frame 0 (blending off). */
  firstFbo: WebGLFramebuffer
  /** accum only, for blended frames (R32F cannot blend). */
  accumFbo: WebGLFramebuffer
  /** Frames accumulated since the last reset. */
  frame: number
  /** Everything that resets the accumulation (camera, size, scene, options). */
  key: string
  maxFrames: number
  usedThisFrame: boolean
}

// Uniform block binding points.
const MARCH_BLOCK = 0
const EXT_BLOCK = 1
const DISPLAY_BLOCK = 2

type GLState = {
  fbo: WebGLFramebuffer | null
  viewport: Int32Array
  program: WebGLProgram | null
  vao: WebGLVertexArrayObject | null
  activeTexture: number
  blend: boolean
  depthTest: boolean
  scissor: boolean
  cull: boolean
  depthMask: boolean
  depthFunc: number
}

type TimerQueryExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
// Frames whose timings may await readback; later frames go untimed.
const MAX_PENDING_TIMINGS = 4

export class CinematicRenderer extends NVRenderer {
  private gl: WebGL2RenderingContext | null = null
  private cpu = new CinematicCpuCache()
  private marchShader: Shader | null = null
  private extinctionShader: Shader | null = null
  private downsampleShader: Shader | null = null
  private gradientShader: Shader | null = null
  private displayShader: Shader | null = null
  private vao: WebGLVertexArrayObject | null = null
  private prepFbo: WebGLFramebuffer | null = null
  private marchParams: WebGLBuffer | null = null
  private extParams: WebGLBuffer | null = null
  private displayParams: WebGLBuffer | null = null
  private huTex: WebGLTexture | null = null
  private gradTex: WebGLTexture | null = null
  private extTex: WebGLTexture | null = null
  private matIdTex: WebGLTexture | null = null
  private matTable: WebGLTexture | null = null
  private tfColor: WebGLTexture | null = null
  private tfMat: WebGLTexture | null = null
  private tfMaxA: WebGLTexture | null = null
  private geometry: CinematicGeometry | null = null
  private tf: BakedTransferFunction | null = null
  private labelInfo: [number, number, number, number] = [0, 1, 0, 0]
  private needsGradient = false
  private needsExtinction = false
  private tiles = new Map<number, TileState>()
  private preparedThisFrame = false
  private options: CinematicOptions | null = null
  private optionsKey = ''
  // Borrowed from the standard renderer; it owns the texture and its updates.
  private overlayTex: WebGLTexture | null = null
  private overlayVersion = -1
  private timer = new CinematicFrameTimer()
  private isRefining = false
  // EXT_disjoint_timer_query_webgl2 (often absent): one TIME_ELAPSED query per
  // marched tile, read back a few frames later.
  private timerExt: TimerQueryExt | null = null
  private frameQueries: WebGLQuery[] = []
  private pendingTimings: { queries: WebGLQuery[]; generation: number }[] = []

  /** Label problem reported by the CPU cache (e.g. values above 254). */
  get labelProblem(): string {
    return this.cpu.labelProblem
  }

  /** Mean GPU ms per refinement frame, or null (see CinematicFrameTimer). */
  get frameMs(): number | null {
    return this.timer.meanMs(this.isRefining)
  }

  /**
   * Stays not ready without EXT_color_buffer_float (float render targets) or
   * when its shaders fail to compile.
   */
  init(gl: WebGL2RenderingContext): void {
    if (!gl.getExtension('EXT_color_buffer_float')) return
    this.gl = gl
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    const shader = (fs: string, blocks: [string, number][]): Shader => {
      const s = new Shader(gl, cinematicVertexShader, fs)
      for (const [name, binding] of blocks) {
        gl.uniformBlockBinding(
          s.program,
          gl.getUniformBlockIndex(s.program, name),
          binding,
        )
      }
      return s
    }
    // A driver that rejects these shaders leaves cinematic unavailable (the
    // view draws COMPOSITE), not the whole view.
    try {
      this.marchShader = shader(cinematicMarchShader, [['Params', MARCH_BLOCK]])
      this.extinctionShader = shader(cinematicExtinctionShader, [
        ['ExtParams', EXT_BLOCK],
      ])
      this.downsampleShader = shader(cinematicDownsampleShader, [])
      this.gradientShader = shader(cinematicGradientShader, [])
      this.displayShader = shader(cinematicDisplayShader, [
        ['Display', DISPLAY_BLOCK],
      ])
    } catch (err) {
      log.warn(`cinematic shaders failed: ${err}`)
      return
    }
    this.vao = gl.createVertexArray()
    this.prepFbo = gl.createFramebuffer()
    const ubo = (floats: number): WebGLBuffer | null => {
      const b = gl.createBuffer()
      gl.bindBuffer(gl.UNIFORM_BUFFER, b)
      gl.bufferData(gl.UNIFORM_BUFFER, floats * 4, gl.DYNAMIC_DRAW)
      gl.bindBuffer(gl.UNIFORM_BUFFER, null)
      return b
    }
    this.marchParams = ubo(MARCH_PARAM_FLOATS)
    this.extParams = ubo(EXT_PARAM_FLOATS)
    this.displayParams = ubo(DISPLAY_PARAM_FLOATS)
    this.matIdTex = this._uploadMaterialIds(new Uint8Array(1), [1, 1, 1])
    this.matTable = this._texture2D(
      gl.RGBA32F,
      MATERIAL_TEXELS,
      1,
      gl.RGBA,
      gl.FLOAT,
      new Float32Array(MATERIAL_TEXELS * 4),
      gl.NEAREST,
    )
    this.isReady = true
  }

  private _params(tex: WebGLTexture, target: number, filter: number): void {
    const gl = this.gl
    if (!gl) return
    gl.bindTexture(target, tex)
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(
      target,
      gl.TEXTURE_MAG_FILTER,
      filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR,
    )
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  }

  private _texture2D(
    internalFormat: number,
    w: number,
    h: number,
    format: number,
    type: number,
    data: ArrayBufferView | null,
    filter: number,
  ): WebGLTexture {
    const gl = this.gl
    if (!gl) throw new Error('cinematic: not initialized')
    const tex = gl.createTexture()
    this._params(tex, gl.TEXTURE_2D, filter)
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, w, h)
    if (data) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, type, data)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    }
    gl.bindTexture(gl.TEXTURE_2D, null)
    return tex
  }

  private _texture3D(
    dims: readonly number[],
    internalFormat: number,
    filter: number,
    mipLevelCount = 1,
  ): WebGLTexture {
    const gl = this.gl
    if (!gl) throw new Error('cinematic: not initialized')
    const tex = gl.createTexture()
    this._params(tex, gl.TEXTURE_3D, filter)
    gl.texStorage3D(
      gl.TEXTURE_3D,
      mipLevelCount,
      internalFormat,
      dims[0],
      dims[1],
      dims[2],
    )
    return tex
  }

  private _upload3D(
    tex: WebGLTexture,
    dims: readonly number[],
    format: number,
    type: number,
    data: ArrayBufferView,
  ): void {
    const gl = this.gl
    if (!gl) return
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      0,
      0,
      0,
      dims[0],
      dims[1],
      dims[2],
      format,
      type,
      data,
    )
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.bindTexture(gl.TEXTURE_3D, null)
  }

  private _uploadMaterialIds(
    ids: Uint8Array,
    dims: readonly number[],
  ): WebGLTexture {
    const gl = this.gl
    if (!gl) throw new Error('cinematic: not initialized')
    const tex = this._texture3D(dims, gl.R8UI, gl.NEAREST)
    this._upload3D(tex, dims, gl.RED_INTEGER, gl.UNSIGNED_BYTE, ids)
    return tex
  }

  private _uploadTF(tf: BakedTransferFunction): void {
    const gl = this.gl
    if (!gl) return
    for (const t of [this.tfColor, this.tfMat, this.tfMaxA]) gl.deleteTexture(t)
    const make = (
      data: Uint8Array,
      internal: number,
      format: number,
      h = TF_H,
    ) =>
      this._texture2D(
        internal,
        TF_W,
        h,
        format,
        gl.UNSIGNED_BYTE,
        data,
        gl.LINEAR,
      )
    this.tfColor = make(tf.color, gl.RGBA8, gl.RGBA)
    this.tfMat = make(tf.material, gl.RG8, gl.RG)
    this.tfMaxA = make(tf.maxAlpha, gl.R8, gl.RED, 1)
    this.tf = tf
  }

  private _saveState(): GLState {
    const gl = this.gl as WebGL2RenderingContext
    return {
      fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING),
      viewport: gl.getParameter(gl.VIEWPORT),
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
      blend: gl.isEnabled(gl.BLEND),
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
      scissor: gl.isEnabled(gl.SCISSOR_TEST),
      cull: gl.isEnabled(gl.CULL_FACE),
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
      depthFunc: gl.getParameter(gl.DEPTH_FUNC),
    }
  }

  private _restoreState(s: GLState): void {
    const gl = this.gl as WebGL2RenderingContext
    const toggle = (cap: number, on: boolean): void =>
      on ? gl.enable(cap) : gl.disable(cap)
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo)
    gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3])
    gl.useProgram(s.program)
    gl.bindVertexArray(s.vao)
    toggle(gl.BLEND, s.blend)
    toggle(gl.DEPTH_TEST, s.depthTest)
    toggle(gl.SCISSOR_TEST, s.scissor)
    toggle(gl.CULL_FACE, s.cull)
    gl.depthMask(s.depthMask)
    gl.depthFunc(s.depthFunc)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.activeTexture(s.activeTexture)
  }

  /** Offscreen pass state: no blend, depth, scissor or culling. */
  private _offscreen(): void {
    const gl = this.gl as WebGL2RenderingContext
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.CULL_FACE)
    gl.bindVertexArray(this.vao)
  }

  /** Bind `textures` to units 0.. as the program's samplers of those names. */
  private _bind(
    shader: Shader,
    textures: [string, number, WebGLTexture | null][],
  ): void {
    const gl = this.gl as WebGL2RenderingContext
    gl.useProgram(shader.program)
    textures.forEach(([name, target, tex], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(target, tex)
      gl.uniform1i(shader.uniforms[name] ?? null, unit)
    })
  }

  // One fullscreen triangle per layer of `level` of the 3D texture `out`.
  private _renderLayers(
    shader: Shader,
    out: WebGLTexture,
    size: readonly number[],
    level = 0,
  ): void {
    const gl = this.gl as WebGL2RenderingContext
    const layer = shader.uniforms.layer ?? null
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.prepFbo)
    gl.viewport(0, 0, size[0], size[1])
    for (let z = 0; z < size[2]; z++) {
      gl.framebufferTextureLayer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        out,
        level,
        z,
      )
      gl.uniform1i(layer, z)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
  }

  /**
   * Bring GPU resources up to date with the scene: intensity (R16F),
   * gradient, transfer function, labels, extinction; runs the prep passes.
   * False when there is nothing to draw.
   */
  prepare(
    vol: NVImage,
    labelVol: NVImage | null,
    options: CinematicOptions,
    overlayTex: WebGLTexture | null,
    overlayVersion: number,
  ): boolean {
    this.preparedThisFrame = true
    const gl = this.gl
    if (!gl || !this.isReady) return false
    if (
      overlayTex !== this.overlayTex ||
      (overlayTex && overlayVersion !== this.overlayVersion)
    ) {
      this.overlayTex = overlayTex
      this.overlayVersion = overlayVersion
      for (const tile of this.tiles.values()) {
        tile.key = ''
      }
    }
    const update = this.cpu.update(vol, labelVol, options)
    if (!update) return false
    if (update.intensity) {
      const { values, geometry } = update.intensity
      const dims = geometry.dims
      gl.deleteTexture(this.huTex)
      gl.deleteTexture(this.gradTex)
      this.huTex = this._texture3D(dims, gl.R16F, gl.LINEAR)
      this._upload3D(this.huTex, dims, gl.RED, gl.HALF_FLOAT, values)
      this.gradTex = this._texture3D(dims, gl.RGBA16F, gl.LINEAR)
      this.geometry = geometry
      this.needsGradient = true
      this.needsExtinction = true
    }
    if (update.tf) {
      this._uploadTF(update.tf)
      this.needsExtinction = true
    }
    if (update.labels) {
      const { ids, materials, info } = update.labels
      gl.deleteTexture(this.matIdTex)
      this.matIdTex =
        ids && this.geometry
          ? this._uploadMaterialIds(ids, this.geometry.dims)
          : this._uploadMaterialIds(new Uint8Array(1), [1, 1, 1])
      gl.bindTexture(gl.TEXTURE_2D, this.matTable)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        MATERIAL_TEXELS,
        1,
        gl.RGBA,
        gl.FLOAT,
        materials,
      )
      gl.bindTexture(gl.TEXTURE_2D, null)
      this.labelInfo = info
      this.needsExtinction = true
    }
    if (!this.huTex || !this.gradTex || !this.tf || !this.geometry) return false
    this.options = options
    this.optionsKey = `${update.version}|${JSON.stringify(options)}`
    if (this.needsGradient || this.needsExtinction) {
      const state = this._saveState()
      this._offscreen()
      if (this.needsGradient) this._encodeGradient()
      if (this.needsExtinction) this._encodeExtinction()
      this._restoreState(state)
    }
    return true
  }

  // 3D Sobel of the intensities, once per intensity upload.
  private _encodeGradient(): void {
    const gl = this.gl
    if (!gl || !this.gradientShader || !this.huTex || !this.gradTex) return
    if (!this.geometry) return
    this._bind(this.gradientShader, [['huTex', gl.TEXTURE_3D, this.huTex]])
    this._renderLayers(this.gradientShader, this.gradTex, this.geometry.dims)
    this.needsGradient = false
  }

  // Half-resolution extinction (per mm) with a full mip chain; rebuilt when
  // the intensities, transfer function or labels change, not the camera.
  private _encodeExtinction(): void {
    const gl = this.gl
    const geo = this.geometry
    const tf = this.tf
    if (!gl || !geo || !tf || !this.extinctionShader) return
    if (!this.downsampleShader || !this.extParams) return
    if (!this.huTex || !this.gradTex || !this.tfColor) return
    if (!this.matIdTex || !this.matTable) return
    const size = geo.dims.map((n) => Math.ceil(n / 2))
    const mips = Math.floor(Math.log2(Math.max(...size))) + 1
    gl.deleteTexture(this.extTex)
    // WebGPU's sampler picks the nearest mip (default mipmapFilter).
    const extTex = this._texture3D(
      size,
      gl.R16F,
      gl.LINEAR_MIPMAP_NEAREST,
      mips,
    )
    this.extTex = extTex
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.extParams)
    gl.bufferSubData(
      gl.UNIFORM_BUFFER,
      0,
      packExtinctionParams(geo, tf, this.labelInfo),
    )
    gl.bindBufferBase(gl.UNIFORM_BUFFER, EXT_BLOCK, this.extParams)
    this._bind(this.extinctionShader, [
      ['huTex', gl.TEXTURE_3D, this.huTex],
      ['gradTex', gl.TEXTURE_3D, this.gradTex],
      ['tfColor', gl.TEXTURE_2D, this.tfColor],
      ['matTex', gl.TEXTURE_3D, this.matIdTex],
      ['matTable', gl.TEXTURE_2D, this.matTable],
    ])
    this._renderLayers(this.extinctionShader, extTex, size)
    this._bind(this.downsampleShader, [['src', gl.TEXTURE_3D, extTex]])
    for (let l = 1; l < mips; l++) {
      // Sample only level l - 1 while rendering level l (no feedback loop).
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_BASE_LEVEL, l - 1)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAX_LEVEL, l - 1)
      this._renderLayers(
        this.downsampleShader,
        extTex,
        size.map((n) => Math.max(1, n >> l)),
        l,
      )
    }
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_BASE_LEVEL, 0)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAX_LEVEL, mips - 1)
    gl.bindTexture(gl.TEXTURE_3D, null)
    this.needsExtinction = false
  }

  // Accumulation and first-hit depth of one tile, sized to it.
  private _tile(index: number, width: number, height: number): TileState {
    const gl = this.gl
    if (!gl) throw new Error('cinematic: not ready')
    const old = this.tiles.get(index)
    if (old && old.width === width && old.height === height) return old
    if (old) this._freeTile(old)
    const accum = this._texture2D(
      gl.RGBA16F,
      width,
      height,
      gl.RGBA,
      gl.HALF_FLOAT,
      null,
      gl.NEAREST,
    )
    const depth = this._texture2D(
      gl.R32F,
      width,
      height,
      gl.RED,
      gl.FLOAT,
      null,
      gl.NEAREST,
    )
    const fbo = (attachments: WebGLTexture[]): WebGLFramebuffer => {
      const f = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, f)
      attachments.forEach((tex, i) => {
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0 + i,
          gl.TEXTURE_2D,
          tex,
          0,
        )
      })
      gl.drawBuffers(attachments.map((_, i) => gl.COLOR_ATTACHMENT0 + i))
      return f
    }
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    const tile: TileState = {
      width,
      height,
      accum,
      depth,
      firstFbo: fbo([accum, depth]),
      accumFbo: fbo([accum]),
      frame: 0,
      key: '',
      maxFrames: 1,
      usedThisFrame: false,
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
    this.tiles.set(index, tile)
    return tile
  }

  private _freeTile(tile: TileState): void {
    const gl = this.gl
    if (!gl) return
    gl.deleteTexture(tile.accum)
    gl.deleteTexture(tile.depth)
    gl.deleteFramebuffer(tile.firstFbo)
    gl.deleteFramebuffer(tile.accumFbo)
  }

  /**
   * One render tile: march one more frame into its accumulation (unless
   * converged), then resolve it into the current framebuffer at the tile's
   * viewport, writing depth.
   */
  draw(t: CinematicTileInput): void {
    const gl = this.gl
    const options = this.options
    if (!gl || !options || !this.geometry || !this.tf) return
    if (!this.marchShader || !this.displayShader || !this.extTex) return
    const width = Math.max(1, Math.round(t.rect[2]))
    const height = Math.max(1, Math.round(t.rect[3]))
    const tile = this._tile(t.index, width, height)
    tile.usedThisFrame = true
    const key = tileKey(this.optionsKey, t)
    if (key !== tile.key) {
      tile.key = key
      tile.frame = 0
    }
    tile.maxFrames = Math.max(1, Math.round(options.maxFrames))
    const state = this._saveState()
    if (tile.frame < tile.maxFrames) {
      const params = tileMarchParams(
        t,
        tile.frame,
        this.geometry,
        this.tf,
        options,
        this.labelInfo,
        !!this.overlayTex,
      )
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.marchParams)
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, params)
      gl.bindBufferBase(gl.UNIFORM_BUFFER, MARCH_BLOCK, this.marchParams)
      this._offscreen()
      this._bind(this.marchShader, [
        ['huTex', gl.TEXTURE_3D, this.huTex],
        ['gradTex', gl.TEXTURE_3D, this.gradTex],
        ['tfColor', gl.TEXTURE_2D, this.tfColor],
        ['tfMat', gl.TEXTURE_2D, this.tfMat],
        ['tfMaxA', gl.TEXTURE_2D, this.tfMaxA],
        ['extTex', gl.TEXTURE_3D, this.extTex],
        ['matTex', gl.TEXTURE_3D, this.matIdTex],
        ['matTable', gl.TEXTURE_2D, this.matTable],
        ['overlayTex', gl.TEXTURE_3D, this.overlayTex ?? this.huTex],
      ])
      if (tile.frame === 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, tile.firstFbo)
      } else {
        // Running mean: new * 1/(n+1) + mean * n/(n+1).
        gl.bindFramebuffer(gl.FRAMEBUFFER, tile.accumFbo)
        gl.enable(gl.BLEND)
        gl.blendColor(0, 0, 0, 1 / (tile.frame + 1))
        gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA)
      }
      gl.viewport(0, 0, width, height)
      if (tile.frame === 0) this.timer.restart()
      const ext =
        this.pendingTimings.length < MAX_PENDING_TIMINGS ? this.timerExt : null
      const query = ext ? gl.createQuery() : null
      if (ext && query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (ext && query) {
        gl.endQuery(ext.TIME_ELAPSED_EXT)
        this.frameQueries.push(query)
      }
      tile.frame++
    }
    if (tile.frame > 0) {
      this._restoreState(state)
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.displayParams)
      gl.bufferSubData(
        gl.UNIFORM_BUFFER,
        0,
        packDisplayParams(
          [t.rect[0], t.rect[1], width, height],
          1,
          options.exposure,
          t.background,
        ),
      )
      gl.bindBufferBase(gl.UNIFORM_BUFFER, DISPLAY_BLOCK, this.displayParams)
      // Replaces colour (the background is composited in the shader) and
      // writes depth, so later layers depth-test against the volume.
      gl.bindVertexArray(this.vao)
      gl.disable(gl.BLEND)
      gl.disable(gl.CULL_FACE)
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.ALWAYS)
      gl.depthMask(true)
      this._bind(this.displayShader, [
        ['accum', gl.TEXTURE_2D, tile.accum],
        ['depthIn', gl.TEXTURE_2D, tile.depth],
      ])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    this._restoreState(state)
  }

  /** Before the tile loop. */
  beginFrame(): void {
    this._readTimings()
    this.preparedThisFrame = false
    for (const tile of this.tiles.values()) tile.usedThisFrame = false
  }

  /**
   * After the tile loop: frees tiles not drawn this frame (and every volume
   * resource when none was, e.g. after leaving CINEMATIC) and reports whether
   * a drawn tile still refines, so the view schedules another frame.
   */
  endFrame(): boolean {
    let refining = false
    for (const [index, tile] of this.tiles) {
      if (!tile.usedThisFrame) {
        this._freeTile(tile)
        this.tiles.delete(index)
      } else if (tile.frame < tile.maxFrames) {
        refining = true
      }
    }
    // Keep the scene's textures while cinematic stays active even with no 3D
    // tile on screen (2D-only layout, hidden background); free them when the
    // view stops calling prepare.
    if (this.tiles.size === 0 && !this.preparedThisFrame && this.huTex)
      this._freeVolume()
    this.isRefining = refining
    if (this.frameQueries.length > 0) {
      this.pendingTimings.push({
        queries: this.frameQueries,
        generation: this.timer.generation,
      })
      this.frameQueries = []
    }
    return refining
  }

  // Oldest first; a disjoint (timer reset) frame is dropped.
  private _readTimings(): void {
    const gl = this.gl
    const ext = this.timerExt
    if (!gl || !ext) return
    while (this.pendingTimings.length > 0) {
      const { queries, generation } = this.pendingTimings[0]
      const last = queries[queries.length - 1]
      if (!gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) return
      this.pendingTimings.shift()
      const isDisjoint = gl.getParameter(ext.GPU_DISJOINT_EXT)
      let ns = 0
      for (const q of queries) {
        ns += gl.getQueryParameter(q, gl.QUERY_RESULT)
        gl.deleteQuery(q)
      }
      if (!isDisjoint) this.timer.add(ns / 1e6, generation)
    }
  }

  // The scene's GPU copies (intensity, gradient, extinction, labels, TF).
  private _freeVolume(): void {
    const gl = this.gl
    if (!gl) return
    for (const t of [
      this.huTex,
      this.gradTex,
      this.extTex,
      this.tfColor,
      this.tfMat,
      this.tfMaxA,
    ])
      gl.deleteTexture(t)
    this.huTex = this.gradTex = this.extTex = null
    this.tfColor = this.tfMat = this.tfMaxA = null
    this.geometry = null
    this.overlayTex = null
    this.overlayVersion = -1
    this.tf = null
    this.cpu = new CinematicCpuCache()
    // Full-volume size; the fresh cache re-emits labels on re-entry.
    gl.deleteTexture(this.matIdTex)
    this.matIdTex = this._uploadMaterialIds(new Uint8Array(1), [1, 1, 1])
    this.labelInfo = [0, 1, 0, 0]
  }

  destroy(): void {
    const gl = this.gl
    if (!gl) return
    for (const tile of this.tiles.values()) this._freeTile(tile)
    this.tiles.clear()
    this._freeVolume()
    for (const q of [
      ...this.frameQueries,
      ...this.pendingTimings.flatMap((p) => p.queries),
    ])
      gl.deleteQuery(q)
    this.frameQueries = []
    this.pendingTimings = []
    gl.deleteTexture(this.matIdTex)
    gl.deleteTexture(this.matTable)
    for (const b of [this.marchParams, this.extParams, this.displayParams])
      gl.deleteBuffer(b)
    for (const s of [
      this.marchShader,
      this.extinctionShader,
      this.downsampleShader,
      this.gradientShader,
      this.displayShader,
    ])
      if (s) gl.deleteProgram(s.program)
    gl.deleteVertexArray(this.vao)
    gl.deleteFramebuffer(this.prepFbo)
    this.matIdTex = this.matTable = null
    this.marchParams = this.extParams = this.displayParams = null
    this.marchShader = this.extinctionShader = this.downsampleShader = null
    this.gradientShader = this.displayShader = null
    this.vao = null
    this.prepFbo = null
    this.gl = null
    this.isReady = false
  }
}
