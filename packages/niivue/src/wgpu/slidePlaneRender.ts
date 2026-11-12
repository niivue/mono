import { colorLutWgsl } from '@/slide/colorLutShader'
import type { NVSlide, NVSlideCachedTile } from '@/slide/NVSlide'
import { isFuseTile, tileTextureBudget } from '@/slide/slideFuse'
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

/** The plane shader, with or without the slide's colour table (bind group 2). */
const shaderCode = (lut: boolean): string => /* wgsl */ `
struct U {
  mvp: mat4x4f,
  opacity: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(1) @binding(0) var tileTex: texture_2d<f32>;
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
  let c = textureSample(tileTex, samp, in.uv);
  return vec4f(applyColorLut(c.rgb), c.a * u.opacity.x);
}
`

// One per plane draw in a render pass: queue writes land before the pass
// submits, so two RENDER tiles sharing a uniform or vertex buffer would both
// draw with the last tile's camera and tiles.
interface DrawSlot {
  uniform: GPUBuffer
  group: GPUBindGroup
  vertex: GPUBuffer | null
  entries: PlaneVertexEntry[]
  builtTiles: readonly SlidePlaneTile[] | null
}

interface PlaneVertexEntry {
  tile: SlidePlaneTile
  firstVertex: number
  /** Interior size the quad's UVs were inset for. */
  uv: { width: number; height: number }
}

export class SlidePlaneRendererGPU extends NVRenderer {
  private _pipeline: GPURenderPipeline | null = null
  private _lutPipeline: GPURenderPipeline | null = null
  private _uniformBGL: GPUBindGroupLayout | null = null
  private _textureBGL: GPUBindGroupLayout | null = null
  private _sampler: GPUSampler | null = null
  private _slots: DrawSlot[] = []
  private _slotsUsed = 0
  private _pass: GPURenderPassEncoder | null = null
  // Buffers replaced during a pass, destroyed once it has been submitted.
  private _retired: GPUBuffer[] = []
  // One texture + bind group per resident tile, keyed by NVSlide tile key.
  // Byte-budgeted: tiles that leave the working set are evicted each frame
  // (evict runs before beginFrame, so nothing referenced by the in-flight
  // command encoder is ever destroyed).
  private readonly _textures = new TileTextureCache<
    TileTextureGPU & { group?: GPUBindGroup }
  >(DEFAULT_TILE_TEXTURE_BYTES, (entry) => entry.texture.destroy())
  private readonly _gutter = new TileGutterGPU()
  private readonly _fuser = new TileFuserGPU()
  private readonly _scratch = new Float32Array(20) // mat4 (16) + opacity vec4 (4)
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
    this._uniformBGL = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    this._textureBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    const lutLayout = colorLutLayout(device)
    this._luts = new ColorLutTexturesGPU(device, lutLayout, this._sampler)
    // The plain variant for identity tables and annotations; the other applies a colour table.
    const pipelineFor = (lut: boolean): GPURenderPipeline =>
      device.createRenderPipeline(
        alphaPipelineDesc(device, {
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
        }),
      )
    this._pipeline = pipelineFor(false)
    this._lutPipeline = pipelineFor(true)
    this.isReady = true
  }

  // The next draw slot of `pass`. A new pass means the last one was submitted:
  // its retired buffers can go, and textures are evicted once per pass (before
  // beginFrame), never between two draws that bind them.
  private _nextSlot(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    mvpMatrix: Float32Array,
    opacity: number,
  ): DrawSlot | null {
    if (!this._uniformBGL || !this._sampler) return null
    if (pass !== this._pass) {
      this._pass = pass
      this._slotsUsed = 0
      for (const buffer of this._retired) buffer.destroy()
      this._retired = []
      this._textures.evictToBudget(tileTextureBudget(this._fuser.poolBytes))
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
          ],
        }),
        vertex: null,
        entries: [],
        builtTiles: null,
      }
      this._slots.push(slot)
    }
    this._slotsUsed++
    this._scratch.set(mvpMatrix, 0)
    this._scratch[16] = opacity
    device.queue.writeBuffer(slot.uniform, 0, this._scratch)
    return slot
  }

  // Build one vertex buffer holding every visible plane quad (4 verts each).
  // Rebuilt whenever the tile set changes (e.g. a camera-LOD level switch).
  private _buildVertices(
    device: GPUDevice,
    slot: DrawSlot,
    tiles: readonly SlidePlaneTile[],
  ): void {
    const data = new Float32Array(tiles.length * 4 * 5)
    slot.entries = []
    let o = 0
    tiles.forEach((tile, i) => {
      data.set(cornerQuad(tile.corners, tile), o)
      o += 20
      slot.entries.push({ tile, firstVertex: i * 4, uv: tile })
    })
    // An earlier draw of this pass may have bound it.
    if (slot.vertex) this._retired.push(slot.vertex)
    slot.vertex = device.createBuffer({
      size: Math.max(20, data.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(slot.vertex, 0, data)
    slot.builtTiles = tiles
  }

  private _textureFor(
    device: GPUDevice,
    slide: NVSlide,
    tile: SlidePlaneTile,
    cached: NVSlideCachedTile,
  ): (TileTextureGPU & { group: GPUBindGroup }) | null {
    if (!this._textureBGL) return null
    const at = { ...tile, slide, key: slideTileKey(slide, tile.key) }
    let entry: (TileTextureGPU & { group?: GPUBindGroup }) | null = null
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
    if (entry.group) return entry as TileTextureGPU & { group: GPUBindGroup }
    const group = device.createBindGroup({
      layout: this._textureBGL,
      entries: [{ binding: 0, resource: entry.texture.createView() }],
    })
    return Object.assign(entry, { group })
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    mvpMatrix: Float32Array,
    tiles: readonly SlidePlaneTile[],
    slide: NVSlide,
    opacity = 1,
  ): void {
    if (!this.isReady || !this._pipeline) return
    const slot = this._nextSlot(device, pass, mvpMatrix, opacity)
    if (!slot) return
    if (slot.builtTiles !== tiles || !slot.vertex)
      this._buildVertices(device, slot, tiles)
    const vertex = slot.vertex
    if (!vertex || slot.entries.length === 0) return
    const lut = slide.displayColorLut
    if (lut && this._luts && this._lutPipeline) {
      pass.setPipeline(this._lutPipeline)
      pass.setBindGroup(2, this._luts.group(lut))
    } else pass.setPipeline(this._pipeline)
    pass.setBindGroup(0, slot.group)
    pass.setVertexBuffer(0, vertex)
    for (const entry of slot.entries) {
      const cached = slide.cachedTile(entry.tile.key)
      if (!cached) continue
      const tex = this._textureFor(device, slide, entry.tile, cached)
      if (!tex) continue
      // A decoded or fitted tile can differ from its manifest size: inset the
      // UVs by the texture actually uploaded (lands before this frame submits).
      if (tex.width !== entry.uv.width || tex.height !== entry.uv.height) {
        entry.uv = tex
        device.queue.writeBuffer(
          vertex,
          entry.firstVertex * 20,
          cornerQuad(entry.tile.corners, tex),
        )
      }
      pass.setBindGroup(1, tex.group)
      pass.draw(4, 1, entry.firstVertex)
    }
    // Submitted now, ahead of the frame's pass that draws the tiles.
    this._fuser.flush(device, this._gutter, this._textures, true)
  }

  /** Draw the slide-space annotation raster as one quad over the whole slide. */
  drawAnnotation(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    mvpMatrix: Float32Array,
    ann: SlidePlaneAnnotation,
    opacity = 1,
  ): void {
    if (!this.isReady || !this._pipeline || !this._textureBGL) return
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
      this._annGroup = device.createBindGroup({
        layout: this._textureBGL,
        entries: [{ binding: 0, resource: this._annTexture.createView() }],
      })
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
    const slot = this._nextSlot(device, pass, mvpMatrix, opacity)
    if (!slot) return
    pass.setPipeline(this._pipeline)
    pass.setBindGroup(0, slot.group)
    pass.setBindGroup(1, this._annGroup)
    pass.setVertexBuffer(0, this._annVertexBuffer)
    pass.draw(4)
  }

  destroy(): void {
    this._textures.clear()
    this._fuser.destroy()
    this._gutter.destroy()
    this._luts?.clear()
    this._luts = null
    for (const slot of this._slots) {
      slot.uniform.destroy()
      slot.vertex?.destroy()
    }
    for (const buffer of this._retired) buffer.destroy()
    if (this._annTexture) this._annTexture.destroy()
    if (this._annVertexBuffer) this._annVertexBuffer.destroy()
    this._annTexture = null
    this._annVertexBuffer = null
    this._annGroup = null
    this._slots = []
    this._retired = []
    this._slotsUsed = 0
    this._pass = null
    this._pipeline = null
    this._lutPipeline = null
    this._uniformBGL = null
    this._textureBGL = null
    this._sampler = null
    this.isReady = false
  }
}
