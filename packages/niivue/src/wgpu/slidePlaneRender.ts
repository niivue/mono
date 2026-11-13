import { colorLutWgsl } from '@/slide/colorLutShader'
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
import { ColorLutTexturesGPU, colorLutLayout } from './colorLut'
import { alphaPipelineDesc, linearSampler, uniformBuffer } from './pipeline'
import { TileFuserGPU } from './tileFuse'
import { TileGutterGPU, type TileTextureGPU } from './tileGutter'

// WebGPU mirror of gl/slidePlaneRender.ts. Draws an NVSlide as a textured plane
// in the 3D render tile: each level tile is a world-mm quad (from
// `slidePlaneTiles`), drawn with the render tile's MVP (world mm -> clip, [0,1]
// depth) so the slide composites with the volume in its own space. All plane
// quads share one vertex buffer (positions known up front); tile bitmaps stream
// in via NVSlide's cache and upload to per-tile GPU textures on demand.

/**
 * The plane shader, with or without the slide's colour table (bind group 2);
 * the `nearest` pipelines sample nearest with the 2D shaders' edge clamp, the
 * `labelBlend` ones add a mixed tile's label texture.
 */
const shaderCode = (lut: boolean): string => /* wgsl */ `
override nearest = false;
// A mixed fused tile's label channels (slideFuse.ts fuseTarget), combined
// nearest with the intensity: 0 none, 1 max, 2 saturating sum.
override labelBlend = 0u;
struct U {
  mvp: mat4x4f,
  opacity: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var nearestSamp: sampler;
@group(1) @binding(0) var tileTex: texture_2d<f32>;
@group(1) @binding(1) var labelTex: texture_2d<f32>;
${colorLutWgsl(2, lut)}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertex_main(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.position = u.mvp * vec4f(pos, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  var c: vec4f;
  if (nearest) {
    // Clamp to the interior's edge texels so the gutter never shows.
    let size = vec2f(textureDimensions(tileTex));
    c = textureSample(tileTex, nearestSamp, clamp(in.uv * size, vec2f(1.5), size - 1.5) / size);
  } else {
    c = textureSample(tileTex, samp, in.uv);
  }
  if (labelBlend != 0u) {
    let size = vec2i(textureDimensions(tileTex));
    let l = textureLoad(labelTex, clamp(vec2i(in.uv * vec2f(size)), vec2i(1), size - 2), 0).rgb;
    c = vec4f(select(max(c.rgb, l), min(c.rgb + l, vec3f(1.0)), labelBlend == 2u), c.a);
  }
  return vec4f(applyColorLut(c.rgb), c.a * u.opacity.x);
}
`

// One per plane draw in a render pass: queue writes land before the pass
// submits, so two RENDER tiles sharing a uniform or vertex buffer would both
// draw with the last tile's camera and tiles.
interface DrawSlot {
  uniform: GPUBuffer
  group: GPUBindGroup
  // The absent-colour quad (vertices 0-3), then one quad per tile.
  vertex: GPUBuffer | null
  vertexBytes: number
  builtTiles: readonly SlidePlaneTile[]
  builtFor: { slide: NVSlide; pixelToWorld?: readonly number[] } | null
  /** Interior size each tile quad's UVs were inset for. */
  insets: { width: number; height: number }[]
  // Per slot, so two slides drawn in one pass keep their own absent colour.
  bg: { texture: GPUTexture; group: GPUBindGroup; source: Float64Array } | null
  // The uniform with the annotation's sampler, made on first annotation draw.
  annGroup?: GPUBindGroup
}

type PlaneTexture = TileTextureGPU & { group?: GPUBindGroup }

export class SlidePlaneRendererGPU extends NVRenderer {
  /** Sample tiles nearest-neighbour instead of linear (the views set it). */
  isNearestInterpolation = false
  // By lut, nearest and labelBlend, made on first use; the plain variant
  // serves identity tables, the absent colour and annotations.
  private readonly _pipelines = new Map<number, GPURenderPipeline>()
  private _pipelineFor:
    | ((
        lut: boolean,
        nearest: boolean,
        labelBlend: number,
      ) => GPURenderPipeline)
    | null = null
  private _uniformBGL: GPUBindGroupLayout | null = null
  private _textureBGL: GPUBindGroupLayout | null = null
  private _sampler: GPUSampler | null = null
  private _nearestSampler: GPUSampler | null = null
  private _slots: DrawSlot[] = []
  private _slotsUsed = 0
  private _pass: GPURenderPassEncoder | null = null
  // Buffers replaced during a pass, destroyed once it has been submitted.
  private _retired: GPUBuffer[] = []
  // One texture + bind group per resident tile, keyed by NVSlide tile key.
  // Byte-budgeted: tiles that leave the working set are evicted each frame
  // (evict runs before beginFrame, so nothing referenced by the in-flight
  // command encoder is ever destroyed).
  private readonly _textures = new TileTextureCache<PlaneTexture>(
    DEFAULT_TILE_TEXTURE_BYTES,
    (entry) => {
      entry.texture.destroy()
      entry.labels?.destroy()
    },
  )
  private readonly _gutter = new TileGutterGPU()
  private readonly _fuser = new TileFuserGPU()
  private readonly _budget = new SlideBudgetRegistration(
    this,
    DEFAULT_RAW_POOL_BYTES,
  )
  private readonly _scratch = new Float32Array(20) // mat4 (16) + opacity vec4 (4)
  private readonly _cached: (NVSlideCachedTile | null)[] = []
  private readonly _ats: GutterAt[] = []
  private readonly _drawn: ((PlaneTexture & { group: GPUBindGroup }) | null)[] =
    []
  private readonly _at = new WeakMap<SlidePlaneTile, GutterAt>()
  private readonly _bgColor = new Uint8ClampedArray(4)
  // Annotation overlay (slide-space drawing).
  private _annTexture: GPUTexture | null = null
  private _annGroup: GPUBindGroup | null = null
  private _annVertexBuffer: GPUBuffer | null = null
  private _annVersion = -1
  private _luts: ColorLutTexturesGPU | null = null
  private _annW = 0
  private _annH = 0

  init(device: GPUDevice, format: GPUTextureFormat, msaaCount: number): void {
    if (this.isReady) return
    this._sampler = linearSampler(device)
    this._nearestSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    })
    this._uniformBGL = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    this._textureBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    const lutLayout = colorLutLayout(device)
    this._luts = new ColorLutTexturesGPU(device, lutLayout, this._sampler)
    this._pipelineFor = (lut, nearest, labelBlend) => {
      const desc = alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: shaderCode(lut) }),
        bindGroupLayouts: [
          this._uniformBGL as GPUBindGroupLayout,
          this._textureBGL as GPUBindGroupLayout,
          ...(lut ? [lutLayout] : []),
        ],
        format,
        msaaCount,
        // Respect volume depth (front geometry occludes the plane) but don't
        // write depth — the plane is a thin overlay layer.
        depthStencil: {
          depthWriteEnabled: false,
          depthCompare: 'less',
          format: 'depth24plus',
        },
        buffers: [
          {
            arrayStride: 20, // pos.xyz (12) + uv.xy (8)
            attributes: [
              { format: 'float32x3', offset: 0, shaderLocation: 0 },
              { format: 'float32x2', offset: 12, shaderLocation: 1 },
            ],
          },
        ],
      })
      if (desc.fragment)
        desc.fragment.constants = { nearest: nearest ? 1 : 0, labelBlend }
      return device.createRenderPipeline(desc)
    }
    this.isReady = true
  }

  private _pipeline(
    lut: boolean,
    nearest: boolean,
    labelBlend: number,
  ): GPURenderPipeline | null {
    const key = (lut ? 6 : 0) + (nearest ? 3 : 0) + labelBlend
    let pipeline = this._pipelines.get(key)
    if (!pipeline && this._pipelineFor) {
      pipeline = this._pipelineFor(lut, nearest, labelBlend)
      this._pipelines.set(key, pipeline)
    }
    return pipeline ?? null
  }

  // The next draw slot of `pass`. A new pass means the last one was submitted:
  // its retired buffers can go, and textures are evicted once per pass (before
  // beginFrame), never between two draws that bind them.
  private _nextSlot(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    mvpMatrix: Float32Array,
    opacity: number,
    fuses: boolean,
  ): DrawSlot | null {
    if (!this._uniformBGL || !this._sampler || !this._nearestSampler)
      return null
    if (pass !== this._pass) {
      this._pass = pass
      this._slotsUsed = 0
      for (const buffer of this._retired) buffer.destroy()
      this._retired = []
      this._textures.evictToBudget(
        frameTextureBudget(
          fuses,
          this._fuser.poolBytes,
          DEFAULT_RAW_POOL_BYTES,
        ),
      )
      this._textures.beginFrame()
    }
    let slot = this._slots[this._slotsUsed]
    if (!slot) {
      // mat4 (64) + opacity vec4 (16)
      const uniform = uniformBuffer(device, 80)
      slot = {
        uniform,
        group: device.createBindGroup({
          layout: this._uniformBGL,
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: this._sampler },
            { binding: 2, resource: this._nearestSampler },
          ],
        }),
        vertex: null,
        vertexBytes: 0,
        builtTiles: [],
        builtFor: null,
        insets: [],
        bg: null,
      }
      this._slots.push(slot)
    }
    this._slotsUsed++
    this._scratch.set(mvpMatrix, 0)
    this._scratch[16] = opacity
    device.queue.writeBuffer(slot.uniform, 0, this._scratch)
    return slot
  }

  // One vertex buffer for the slot's tile set: the extent quad, then every
  // tile. Rebuilt when the tile set changes (a LOD switch, fallback tiles
  // arriving or leaving), reusing the buffer while it fits.
  private _buildVertices(
    device: GPUDevice,
    slot: DrawSlot,
    tiles: readonly SlidePlaneTile[],
    slide: NVSlide,
    pixelToWorld?: readonly number[],
  ): void {
    const data = new Float32Array((tiles.length + 1) * 20)
    if (pixelToWorld) {
      const { width, height } = slide.manifest
      data.set(cornerQuad(slideExtentCorners(pixelToWorld, width, height)))
    }
    slot.insets.length = 0
    tiles.forEach((tile, i) => {
      data.set(planeQuad(tile, tile), (i + 1) * 20)
      slot.insets.push(tile)
    })
    if (!slot.vertex || slot.vertexBytes < data.byteLength) {
      // An earlier pass may still be in flight with it.
      if (slot.vertex) this._retired.push(slot.vertex)
      slot.vertexBytes = data.byteLength * 2
      slot.vertex = device.createBuffer({
        size: slot.vertexBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    device.queue.writeBuffer(slot.vertex, 0, data)
    slot.builtTiles = tiles
    slot.builtFor = { slide, pixelToWorld }
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
    device: GPUDevice,
    slide: NVSlide,
    at: GutterAt,
    cached: NVSlideCachedTile,
  ): (PlaneTexture & { group: GPUBindGroup }) | null {
    if (!this._textureBGL) return null
    let entry: PlaneTexture | null = null
    if (isFuseTile(cached))
      entry = this._fuser.textureFor(
        device,
        this._gutter,
        this._textures,
        at,
        slide,
        cached,
      )
    else if (cached.bitmap)
      entry =
        this._textures.get(at.key, cached.bitmap) ??
        this._gutter.upload(device, cached.bitmap, at, this._textures)
    if (!entry) return null
    if (entry.group) return entry as PlaneTexture & { group: GPUBindGroup }
    return Object.assign(entry, {
      group: this._group(device, entry.texture, entry.labels),
    })
  }

  // A texture's group 1: itself and its label texture (itself when none).
  private _group(
    device: GPUDevice,
    texture: GPUTexture,
    labels?: GPUTexture,
  ): GPUBindGroup {
    const view = texture.createView()
    return device.createBindGroup({
      layout: this._textureBGL as GPUBindGroupLayout,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: labels ? labels.createView() : view },
      ],
    })
  }

  // The bind group of `slot`'s 1x1 texture of the slide's absent colour.
  private _absentGroup(
    device: GPUDevice,
    slot: DrawSlot,
    slide: NVSlide,
  ): GPUBindGroup | null {
    if (!this._textureBGL) return null
    const color = slide.backgroundColor
    if (slot.bg && color.every((c, i) => c === slot.bg?.source[i]))
      return slot.bg.group
    if (!slot.bg) {
      const texture = device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      slot.bg = {
        texture,
        group: this._group(device, texture),
        source: new Float64Array(4),
      }
    }
    slot.bg.source.set(color)
    this._bgColor.set(color.map((c) => c * 255))
    device.queue.writeTexture(
      { texture: slot.bg.texture },
      this._bgColor,
      { bytesPerRow: 4 },
      [1, 1],
    )
    return slot.bg.group
  }

  /**
   * Draw `tiles` (coarser fallback tiles first, then the target level) with
   * `mvpMatrix`. With `pixelToWorld` and a slide whose manifest states its
   * absent colour (DICOM (0048,0015)), the slide extent is filled with
   * `slide.backgroundColor` under the tiles; otherwise holes stay transparent.
   */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    mvpMatrix: Float32Array,
    tiles: readonly SlidePlaneTile[],
    slide: NVSlide,
    opacity = 1,
    pixelToWorld?: readonly number[],
  ): void {
    const plain = this._pipeline(false, false, 0)
    if (!this.isReady || !plain) return
    this._budget.sync([slide])
    this._fuser.retainLabelTables([slide])
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
    const slot = this._nextSlot(device, pass, mvpMatrix, opacity, fuses)
    if (!slot) return
    // Upload and fuse every tile before drawing any.
    const drawn = this._drawn
    planTextures(
      this._textures,
      ats,
      cached,
      (i) =>
        this._textureFor(
          device,
          slide,
          ats[i] as GutterAt,
          cached[i] as NVSlideCachedTile,
        ),
      drawn,
    )
    // Submitted now, ahead of the frame's pass that draws the tiles.
    this._fuser.flush(device, this._gutter, this._textures, true)
    const built = slot.builtFor
    if (
      !slot.vertex ||
      !sameTiles(tiles, slot.builtTiles) ||
      built?.slide !== slide ||
      built.pixelToWorld !== pixelToWorld
    )
      this._buildVertices(device, slot, tiles, slide, pixelToWorld)
    const vertex = slot.vertex
    if (!vertex) return
    pass.setBindGroup(0, slot.group)
    pass.setVertexBuffer(0, vertex)
    const absent =
      pixelToWorld && slide.manifest.backgroundColor
        ? this._absentGroup(device, slot, slide)
        : null
    if (absent) {
      pass.setPipeline(plain)
      pass.setBindGroup(1, absent)
      pass.draw(4)
    }
    const lut = Boolean(slide.displayColorLut && this._luts)
    if (lut && this._luts && slide.displayColorLut)
      pass.setBindGroup(2, this._luts.group(slide.displayColorLut))
    const sum = slide.channelBlend === 'additive' ? 2 : 1
    let current: GPURenderPipeline | null = null
    for (let i = 0; i < tiles.length; i++) {
      const tex = drawn[i]
      if (!tex) continue
      const tile = tiles[i] as SlidePlaneTile
      // A decoded or fitted tile can differ from its manifest size: inset the
      // UVs by the texture actually uploaded (lands before this frame submits).
      const inset = slot.insets[i] as { width: number; height: number }
      if (tex.width !== inset.width || tex.height !== inset.height) {
        slot.insets[i] = tex
        device.queue.writeBuffer(vertex, (i + 1) * 80, planeQuad(tile, tex))
      }
      // A fused tile of label channels samples nearest whatever the mode.
      const pipeline = this._pipeline(
        lut,
        this.isNearestInterpolation || tex.nearest === true,
        tex.labels ? sum : 0,
      )
      if (pipeline !== current && pipeline) {
        current = pipeline
        pass.setPipeline(pipeline)
      }
      pass.setBindGroup(1, tex.group)
      pass.draw(4, 1, (i + 1) * 4)
    }
  }

  /** Draw the slide-space annotation raster as one quad over the whole slide. */
  drawAnnotation(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    mvpMatrix: Float32Array,
    ann: SlidePlaneAnnotation,
    opacity = 1,
  ): void {
    const pipeline = this._pipeline(false, false, 0)
    if (!this.isReady || !pipeline || !this._textureBGL) return
    // (Re)create the annotation texture when its size changes.
    if (
      !this._annTexture ||
      this._annW !== ann.width ||
      this._annH !== ann.height
    ) {
      if (this._annTexture) this._annTexture.destroy()
      this._annTexture = device.createTexture({
        size: [ann.width, ann.height, 1],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      })
      this._annW = ann.width
      this._annH = ann.height
      this._annGroup = this._group(device, this._annTexture)
      this._annVersion = -1
    }
    if (this._annVersion !== ann.version) {
      device.queue.writeTexture(
        { texture: this._annTexture },
        ann.rgba as Uint8Array<ArrayBuffer>,
        { bytesPerRow: ann.width * 4, rowsPerImage: ann.height },
        { width: ann.width, height: ann.height },
      )
      this._annVersion = ann.version
    }
    if (!this._annGroup) return
    // One quad over the slide extent (rebuilt each call; just 4 verts).
    const data = cornerQuad(ann.corners)
    if (!this._annVertexBuffer) {
      this._annVertexBuffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    device.queue.writeBuffer(this._annVertexBuffer, 0, data)
    const slot = this._nextSlot(device, pass, mvpMatrix, opacity, false)
    if (!slot) return
    // Magnify nearest, as WebGL2 does, so label edges stay crisp when zoomed.
    slot.annGroup ??= device.createBindGroup({
      layout: this._uniformBGL as GPUBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: slot.uniform } },
        {
          binding: 1,
          resource: device.createSampler({
            magFilter: 'nearest',
            minFilter: 'linear',
          }),
        },
        { binding: 2, resource: this._nearestSampler as GPUSampler },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, slot.annGroup)
    pass.setBindGroup(1, this._annGroup)
    pass.setVertexBuffer(0, this._annVertexBuffer)
    pass.draw(4)
  }

  /** Unregister from the slide last drawn; the next draw registers again. */
  clearBudget(): void {
    this._budget.clear()
    // The replaced slide's label tables go too; a new slide re-makes its own.
    this._fuser.retainLabelTables([])
  }

  destroy(): void {
    this._budget.clear()
    this._textures.clear()
    this._fuser.destroy()
    this._gutter.destroy()
    this._luts?.clear()
    this._luts = null
    for (const slot of this._slots) {
      slot.uniform.destroy()
      slot.vertex?.destroy()
      slot.bg?.texture.destroy()
    }
    for (const buffer of this._retired) buffer.destroy()
    this._annTexture?.destroy()
    this._annVertexBuffer?.destroy()
    this._annTexture = null
    this._annVertexBuffer = null
    this._annGroup = null
    this._slots = []
    this._retired = []
    this._slotsUsed = 0
    this._pass = null
    this._pipelines.clear()
    this._pipelineFor = null
    this._uniformBGL = null
    this._textureBGL = null
    this._sampler = null
    this._nearestSampler = null
    this.isReady = false
  }
}
