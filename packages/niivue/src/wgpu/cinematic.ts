/**
 * WebGPU renderer of VOLUME_RENDER_MODE.CINEMATIC, owned by NVViewGPU.
 *
 * Per frame the view calls `beginFrame`, then (when a tile is cinematic)
 * `prepare` once (CPU cache update, uploads, prep passes) and `draw` for every
 * cinematic render tile, then `endFrame`. Compute work (prep passes, one march dispatch per tile) goes
 * into a separate command encoder that the view submits before its main
 * render pass; inside that pass `drawTile` draws a triangle in the tile's
 * viewport that resolves the tile's mean colour and writes its first-hit
 * depth (so `draw` takes both the compute encoder and the render pass). gl/cinematic.ts mirrors this method for method.
 */
import { mat4 } from 'gl-matrix'
import type { CinematicOptions, NVImage } from '@/NVTypes'
import {
  type BakedTransferFunction,
  CinematicCpuCache,
  type CinematicGeometry,
  clipParams,
  MARCH_PARAM_FLOATS,
  MATERIAL_TEXELS,
  packDisplayParams,
  packExtinctionParams,
  packMarchParams,
  TF_H,
  TF_W,
} from '@/view/NVCinematic'
import { NVRenderer } from '@/view/NVRenderer'
import marchWGSL from './cinematic.wgsl?raw'
import commonWGSL from './cinematicCommon.wgsl?raw'
import displayWGSL from './cinematicDisplay.wgsl?raw'
import downsampleWGSL from './cinematicDownsample.wgsl?raw'
import extinctionWGSL from './cinematicExtinction.wgsl?raw'
import gradientWGSL from './cinematicGradient.wgsl?raw'

/** Per-tile accumulation, keyed by tile index. */
type TileState = {
  width: number
  height: number
  accum: GPUBuffer
  depth: GPUBuffer
  params: GPUBuffer
  display: GPUBuffer
  marchBindGroup: GPUBindGroup | null
  displayBindGroup: GPUBindGroup
  /** Frames accumulated since the last reset. */
  frame: number
  /** Everything that resets the accumulation (camera, size, scene, options). */
  key: string
  maxFrames: number
  usedThisFrame: boolean
}

/** Per-tile inputs from the view's tile loop. */
export type CinematicTileInput = {
  index: number
  /** Tile viewport in device px (`tile.leftTopWidthHeight`). */
  ltwh: readonly number[]
  mvp: ArrayLike<number>
  /** Model (rotation) matrix of the same camera, for the light. */
  model: ArrayLike<number>
  clipPlanes: ArrayLike<number>
  isClipCutaway: boolean
  background: ArrayLike<number>
}

export class CinematicRenderer extends NVRenderer {
  private device: GPUDevice | null = null
  private sampleCount = 1
  private colorFormat: GPUTextureFormat = 'bgra8unorm'
  private cpu = new CinematicCpuCache()
  private sampler: GPUSampler | null = null
  private marchPipeline: GPUComputePipeline | null = null
  private extinctionPipeline: GPUComputePipeline | null = null
  private downsamplePipeline: GPUComputePipeline | null = null
  private gradientPipeline: GPUComputePipeline | null = null
  private displayPipeline: GPURenderPipeline | null = null
  private extParams: GPUBuffer | null = null
  private huTex: GPUTexture | null = null
  private gradTex: GPUTexture | null = null
  private extTex: GPUTexture | null = null
  private matIdTex: GPUTexture | null = null
  private matTable: GPUTexture | null = null
  private tfColor: GPUTexture | null = null
  private tfMat: GPUTexture | null = null
  private tfMaxA: GPUTexture | null = null
  private geometry: CinematicGeometry | null = null
  private tf: BakedTransferFunction | null = null
  private labelInfo: [number, number, number, number] = [0, 1, 0, 0]
  private needsGradient = false
  private needsExtinction = false
  private tiles = new Map<number, TileState>()
  private options: CinematicOptions | null = null
  private optionsKey = ''

  /** Label problem reported by the CPU cache (e.g. values above 254). */
  get labelProblem(): string {
    return this.cpu.labelProblem
  }

  init(
    device: GPUDevice,
    sampleCount: number,
    colorFormat: GPUTextureFormat,
  ): void {
    this.device = device
    this.sampleCount = sampleCount
    this.colorFormat = colorFormat
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
    const compute = (code: string): GPUComputePipeline =>
      device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code }),
          entryPoint: 'main',
        },
      })
    this.marchPipeline = compute(commonWGSL + marchWGSL)
    this.extinctionPipeline = compute(commonWGSL + extinctionWGSL)
    this.downsamplePipeline = compute(downsampleWGSL)
    this.gradientPipeline = compute(gradientWGSL)
    const displayModule = device.createShaderModule({ code: displayWGSL })
    // Replaces colour (the background is composited in the shader) and
    // writes depth, so later layers depth-test against the volume.
    this.displayPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: displayModule, entryPoint: 'vs' },
      fragment: {
        module: displayModule,
        entryPoint: 'fs',
        targets: [{ format: colorFormat }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'always',
      },
      multisample: { count: sampleCount },
    })
    this.extParams = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.matIdTex = this._uploadMaterialIds(new Uint8Array(1), [1, 1, 1])
    this.matTable = device.createTexture({
      size: [MATERIAL_TEXELS, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.isReady = true
  }

  /** Whether the pipelines were built for this sample count and format. */
  matches(sampleCount: number, colorFormat: GPUTextureFormat): boolean {
    return this.sampleCount === sampleCount && this.colorFormat === colorFormat
  }

  private _texture3D(
    dims: readonly number[],
    format: GPUTextureFormat,
    usage: number,
    mipLevelCount = 1,
  ): GPUTexture {
    if (!this.device) throw new Error('cinematic: not initialized')
    return this.device.createTexture({
      size: [dims[0], dims[1], dims[2]],
      dimension: '3d',
      format,
      usage,
      mipLevelCount,
    })
  }

  private _uploadMaterialIds(
    ids: Uint8Array,
    dims: readonly number[],
  ): GPUTexture {
    const tex = this._texture3D(
      dims,
      'r8uint',
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    )
    this.device?.queue.writeTexture(
      { texture: tex },
      ids as Uint8Array<ArrayBuffer>,
      { bytesPerRow: dims[0], rowsPerImage: dims[1] },
      [dims[0], dims[1], dims[2]],
    )
    return tex
  }

  private _uploadTF(tf: BakedTransferFunction): void {
    const device = this.device
    if (!device) return
    const make = (
      data: Uint8Array,
      format: GPUTextureFormat,
      channels: number,
      h: number,
    ): GPUTexture => {
      const tex = device.createTexture({
        size: [TF_W, h],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      device.queue.writeTexture(
        { texture: tex },
        data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: TF_W * channels },
        [TF_W, h],
      )
      return tex
    }
    for (const t of [this.tfColor, this.tfMat, this.tfMaxA]) t?.destroy()
    this.tfColor = make(tf.color, 'rgba8unorm', 4, TF_H)
    this.tfMat = make(tf.material, 'rg8unorm', 2, TF_H)
    this.tfMaxA = make(tf.maxAlpha, 'r8unorm', 1, 1)
    this.tf = tf
  }

  /**
   * Bring GPU resources up to date with the scene: intensity (r16float),
   * gradient, transfer function, labels, extinction. Prep passes are
   * recorded into `encoder`. False when there is nothing to draw.
   */
  prepare(
    encoder: GPUCommandEncoder,
    vol: NVImage,
    labelVol: NVImage | null,
    options: CinematicOptions,
  ): boolean {
    const device = this.device
    if (!device || !this.isReady) return false
    const update = this.cpu.update(vol, labelVol, options)
    if (!update) return false
    if (update.intensity) {
      const { values, geometry } = update.intensity
      const dims = geometry.dims
      this.huTex?.destroy()
      this.gradTex?.destroy()
      this.huTex = this._texture3D(
        dims,
        'r16float',
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      )
      device.queue.writeTexture(
        { texture: this.huTex },
        values as Float16Array<ArrayBuffer>,
        { bytesPerRow: dims[0] * 2, rowsPerImage: dims[1] },
        [dims[0], dims[1], dims[2]],
      )
      this.gradTex = this._texture3D(
        dims,
        'rgba16float',
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      )
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
      this.matIdTex?.destroy()
      this.matIdTex =
        ids && this.geometry
          ? this._uploadMaterialIds(ids, this.geometry.dims)
          : this._uploadMaterialIds(new Uint8Array(1), [1, 1, 1])
      if (this.matTable) {
        device.queue.writeTexture(
          { texture: this.matTable },
          materials as Float32Array<ArrayBuffer>,
          { bytesPerRow: MATERIAL_TEXELS * 16 },
          [MATERIAL_TEXELS, 1],
        )
      }
      this.labelInfo = info
      this.needsExtinction = true
    }
    if (update.intensity || update.tf || update.labels) {
      for (const tile of this.tiles.values()) tile.marchBindGroup = null
    }
    if (!this.huTex || !this.gradTex || !this.tf || !this.geometry) return false
    this.options = options
    this.optionsKey = `${update.version}|${JSON.stringify(options)}`
    if (this.needsGradient) this._encodeGradient(encoder)
    if (this.needsExtinction) this._encodeExtinction(encoder)
    return true
  }

  // Run 3D compute passes in one compute pass; each is [pipeline, entries, size].
  private _dispatch3D(
    encoder: GPUCommandEncoder,
    passes: [GPUComputePipeline, GPUBindGroupEntry[], number[]][],
  ): void {
    const device = this.device
    if (!device) return
    const pass = encoder.beginComputePass()
    for (const [pipeline, entries, size] of passes) {
      pass.setPipeline(pipeline)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries,
        }),
      )
      pass.dispatchWorkgroups(
        Math.ceil(size[0] / 4),
        Math.ceil(size[1] / 4),
        Math.ceil(size[2] / 4),
      )
    }
    pass.end()
  }

  // 3D Sobel of the intensities, once per intensity upload.
  private _encodeGradient(encoder: GPUCommandEncoder): void {
    if (!this.gradientPipeline || !this.huTex || !this.gradTex) return
    if (!this.geometry) return
    this._dispatch3D(encoder, [
      [
        this.gradientPipeline,
        [
          { binding: 0, resource: this.huTex.createView() },
          { binding: 1, resource: this.gradTex.createView() },
        ],
        this.geometry.dims,
      ],
    ])
    this.needsGradient = false
  }

  // Half-resolution extinction (per mm) with a full mip chain; rebuilt when
  // the intensities, transfer function or labels change, not the camera.
  private _encodeExtinction(encoder: GPUCommandEncoder): void {
    const device = this.device
    const geo = this.geometry
    const tf = this.tf
    if (!device || !geo || !tf || !this.extinctionPipeline) return
    if (!this.downsamplePipeline || !this.extParams || !this.sampler) return
    if (!this.huTex || !this.gradTex || !this.tfColor) return
    if (!this.matIdTex || !this.matTable) return
    const size = geo.dims.map((n) => Math.ceil(n / 2))
    const mips = Math.floor(Math.log2(Math.max(...size))) + 1
    this.extTex?.destroy()
    const extTex = this._texture3D(
      size,
      'rgba16float',
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      mips,
    )
    this.extTex = extTex
    const level = (l: number): GPUTextureView =>
      extTex.createView({ baseMipLevel: l, mipLevelCount: 1 })
    device.queue.writeBuffer(
      this.extParams,
      0,
      packExtinctionParams(
        geo,
        tf,
        this.labelInfo,
      ) as Float32Array<ArrayBuffer>,
    )
    const passes: [GPUComputePipeline, GPUBindGroupEntry[], number[]][] = [
      [
        this.extinctionPipeline,
        [
          { binding: 0, resource: this.huTex.createView() },
          { binding: 1, resource: this.gradTex.createView() },
          { binding: 2, resource: this.tfColor.createView() },
          { binding: 3, resource: this.sampler },
          { binding: 4, resource: { buffer: this.extParams } },
          { binding: 5, resource: level(0) },
          { binding: 6, resource: this.matIdTex.createView() },
          { binding: 7, resource: this.matTable.createView() },
        ],
        size,
      ],
    ]
    for (let l = 1; l < mips; l++) {
      passes.push([
        this.downsamplePipeline,
        [
          { binding: 0, resource: level(l - 1) },
          { binding: 1, resource: level(l) },
        ],
        size.map((n) => Math.max(1, n >> l)),
      ])
    }
    this._dispatch3D(encoder, passes)
    this.needsExtinction = false
    for (const tile of this.tiles.values()) tile.marchBindGroup = null
  }

  // Accumulation, first-hit depth and uniforms of one tile, sized to it.
  private _tile(index: number, width: number, height: number): TileState {
    const device = this.device
    if (!device || !this.displayPipeline)
      throw new Error('cinematic: not ready')
    const old = this.tiles.get(index)
    if (old && old.width === width && old.height === height) return old
    if (old) this._freeTile(old)
    const storage = (bytesPerPixel: number): GPUBuffer =>
      device.createBuffer({
        size: width * height * bytesPerPixel,
        usage: GPUBufferUsage.STORAGE,
      })
    const uniform = (size: number): GPUBuffer =>
      device.createBuffer({
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
    const accum = storage(16)
    const depth = storage(4)
    const display = uniform(64)
    const tile: TileState = {
      width,
      height,
      accum,
      depth,
      params: uniform(MARCH_PARAM_FLOATS * 4),
      display,
      marchBindGroup: null,
      displayBindGroup: device.createBindGroup({
        layout: this.displayPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: accum } },
          { binding: 1, resource: { buffer: display } },
          { binding: 2, resource: { buffer: depth } },
        ],
      }),
      frame: 0,
      key: '',
      maxFrames: 1,
      usedThisFrame: false,
    }
    this.tiles.set(index, tile)
    return tile
  }

  private _freeTile(tile: TileState): void {
    tile.accum.destroy()
    tile.depth.destroy()
    tile.params.destroy()
    tile.display.destroy()
  }

  private _marchBindGroup(tile: TileState): GPUBindGroup | null {
    if (tile.marchBindGroup) return tile.marchBindGroup
    const device = this.device
    if (!device || !this.marchPipeline || !this.sampler) return null
    if (!this.huTex || !this.gradTex || !this.extTex || !this.matIdTex)
      return null
    if (!this.tfColor || !this.tfMat || !this.tfMaxA || !this.matTable)
      return null
    tile.marchBindGroup = device.createBindGroup({
      layout: this.marchPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.huTex.createView() },
        { binding: 1, resource: this.gradTex.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.tfColor.createView() },
        { binding: 4, resource: this.tfMat.createView() },
        { binding: 5, resource: this.tfMaxA.createView() },
        { binding: 6, resource: { buffer: tile.params } },
        { binding: 7, resource: { buffer: tile.accum } },
        { binding: 8, resource: this.extTex.createView() },
        { binding: 9, resource: this.matIdTex.createView() },
        { binding: 10, resource: this.matTable.createView() },
        { binding: 11, resource: { buffer: tile.depth } },
      ],
    })
    return tile.marchBindGroup
  }

  /**
   * One render tile: march one more frame into its accumulation (into
   * `encoder`, unless converged), then resolve it into `pass`, whose viewport
   * the caller has set to the tile.
   */
  draw(
    encoder: GPUCommandEncoder,
    pass: GPURenderPassEncoder,
    t: CinematicTileInput,
  ): void {
    const device = this.device
    const options = this.options
    if (!device || !options || !this.geometry || !this.tf) return
    if (!this.marchPipeline || !this.displayPipeline) return
    const width = Math.max(1, Math.round(t.ltwh[2]))
    const height = Math.max(1, Math.round(t.ltwh[3]))
    const tile = this._tile(t.index, width, height)
    tile.usedThisFrame = true
    const key = [
      this.optionsKey,
      Array.from(t.ltwh).join(),
      Array.from(t.mvp).join(),
      Array.from(t.clipPlanes).join(),
      t.isClipCutaway,
      Array.from(t.background).join(),
    ].join('|')
    if (key !== tile.key) {
      tile.key = key
      tile.frame = 0
    }
    tile.maxFrames = Math.max(1, Math.round(options.maxFrames))
    const bindGroup = this._marchBindGroup(tile)
    if (tile.frame < tile.maxFrames && bindGroup) {
      const invMVP = mat4.invert(mat4.create(), t.mvp as mat4) ?? mat4.create()
      const params = packMarchParams({
        geometry: this.geometry,
        invMVP,
        model: t.model,
        width,
        height,
        frame: tile.frame,
        options,
        tf: this.tf,
        clip: clipParams(t.clipPlanes, t.isClipCutaway, this.geometry.mm2frac),
        labelInfo: this.labelInfo,
      })
      device.queue.writeBuffer(
        tile.params,
        0,
        params as Float32Array<ArrayBuffer>,
      )
      const cp = encoder.beginComputePass()
      cp.setPipeline(this.marchPipeline)
      cp.setBindGroup(0, bindGroup)
      cp.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8))
      cp.end()
      tile.frame++
    }
    if (tile.frame === 0) return // nothing accumulated yet
    device.queue.writeBuffer(
      tile.display,
      0,
      packDisplayParams(
        [Math.floor(t.ltwh[0]), Math.floor(t.ltwh[1]), width, height],
        tile.frame,
        options.exposure,
        t.background,
      ) as Float32Array<ArrayBuffer>,
    )
    pass.setPipeline(this.displayPipeline)
    pass.setBindGroup(0, tile.displayBindGroup)
    pass.draw(3)
  }

  /** Before the tile loop. */
  beginFrame(): void {
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
    if (this.tiles.size === 0 && this.huTex) this._freeVolume()
    return refining
  }

  // The scene's GPU copies (intensity, gradient, extinction, labels, TF).
  private _freeVolume(): void {
    for (const t of [
      this.huTex,
      this.gradTex,
      this.extTex,
      this.tfColor,
      this.tfMat,
      this.tfMaxA,
    ])
      t?.destroy()
    this.huTex = this.gradTex = this.extTex = null
    this.tfColor = this.tfMat = this.tfMaxA = null
    this.geometry = null
    this.tf = null
    this.cpu = new CinematicCpuCache()
  }

  destroy(): void {
    for (const tile of this.tiles.values()) this._freeTile(tile)
    this.tiles.clear()
    this._freeVolume()
    this.matIdTex?.destroy()
    this.matTable?.destroy()
    this.extParams?.destroy()
    this.matIdTex = this.matTable = null
    this.extParams = null
    this.device = null
    this.isReady = false
  }
}
