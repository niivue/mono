import type { NVSlide } from '@/slide/NVSlide'
import type { SlidePlaneAnnotation, SlidePlaneTile } from '@/slide/slidePlane'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  TileTextureCache,
} from '@/slide/tileTextureCache'
import { NVRenderer } from '@/view/NVRenderer'

// WebGPU mirror of gl/slidePlaneRender.ts. Draws an NVSlide as a textured plane
// in the 3D render tile: each level tile is a world-mm quad (from
// `slidePlaneTiles`), drawn with the render tile's MVP (world mm -> clip, [0,1]
// depth) so the slide composites with the volume in its own space. All plane
// quads share one vertex buffer (positions known up front); tile bitmaps stream
// in via NVSlide's cache and upload to per-tile GPU textures on demand.

const shaderCode = /* wgsl */ `
struct U {
  mvp: mat4x4f,
  opacity: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(1) @binding(0) var tileTex: texture_2d<f32>;

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
  return vec4f(c.rgb, c.a * u.opacity.x);
}
`

interface PlaneVertexEntry {
  key: string
  firstVertex: number
}

export class SlidePlaneRendererGPU extends NVRenderer {
  private _pipeline: GPURenderPipeline | null = null
  private _uniformBGL: GPUBindGroupLayout | null = null
  private _textureBGL: GPUBindGroupLayout | null = null
  private _sampler: GPUSampler | null = null
  private _uniformBuffer: GPUBuffer | null = null
  private _uniformGroup: GPUBindGroup | null = null
  private _vertexBuffer: GPUBuffer | null = null
  private _entries: PlaneVertexEntry[] = []
  private _builtTiles: readonly SlidePlaneTile[] | null = null
  // One texture + bind group per resident tile, keyed by NVSlide tile key.
  // Byte-budgeted: tiles that leave the working set are evicted each frame
  // (evict runs before beginFrame, so nothing referenced by the in-flight
  // command encoder is ever destroyed).
  private readonly _textures = new TileTextureCache<{
    texture: GPUTexture
    group: GPUBindGroup
  }>(DEFAULT_TILE_TEXTURE_BYTES, (entry) => entry.texture.destroy())
  private readonly _scratch = new Float32Array(20) // mat4 (16) + opacity vec4 (4)
  // Annotation overlay (slide-space drawing).
  private _annTexture: GPUTexture | null = null
  private _annGroup: GPUBindGroup | null = null
  private _annVertexBuffer: GPUBuffer | null = null
  private _annVersion = -1
  private _annW = 0
  private _annH = 0

  init(device: GPUDevice, format: GPUTextureFormat, msaaCount: number): void {
    if (this.isReady) return
    this._sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
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
    const module = device.createShaderModule({ code: shaderCode })
    this._pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._uniformBGL, this._textureBGL],
      }),
      multisample: { count: msaaCount },
      vertex: {
        module,
        entryPoint: 'vertex_main',
        buffers: [
          {
            arrayStride: 20, // pos.xyz (12) + uv.xy (8)
            attributes: [
              { format: 'float32x3', offset: 0, shaderLocation: 0 },
              { format: 'float32x2', offset: 12, shaderLocation: 1 },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fragment_main',
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
              },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      // Respect volume depth (front geometry occludes the plane) but don't
      // write depth — the plane is a thin overlay layer.
      depthStencil: {
        depthWriteEnabled: false,
        depthCompare: 'less',
        format: 'depth24plus',
      },
      primitive: { topology: 'triangle-strip' },
    })
    this._uniformBuffer = device.createBuffer({
      size: 80, // mat4 (64) + opacity vec4 (16)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this._uniformGroup = device.createBindGroup({
      layout: this._uniformBGL,
      entries: [
        { binding: 0, resource: { buffer: this._uniformBuffer } },
        { binding: 1, resource: this._sampler },
      ],
    })
    this.isReady = true
  }

  // Build one vertex buffer holding every visible plane quad (4 verts each).
  // Rebuilt whenever the tile set changes (e.g. a camera-LOD level switch).
  private _buildVertices(
    device: GPUDevice,
    tiles: readonly SlidePlaneTile[],
  ): void {
    const data = new Float32Array(tiles.length * 4 * 5)
    this._entries = []
    let o = 0
    tiles.forEach((tile, i) => {
      const [tl, tr, bl, br] = tile.corners
      // TRIANGLE_STRIP order TL, TR, BL, BR; UV origin top-left.
      data.set([tl[0], tl[1], tl[2], 0, 0], o)
      data.set([tr[0], tr[1], tr[2], 1, 0], o + 5)
      data.set([bl[0], bl[1], bl[2], 0, 1], o + 10)
      data.set([br[0], br[1], br[2], 1, 1], o + 15)
      o += 20
      this._entries.push({ key: tile.key, firstVertex: i * 4 })
    })
    if (this._vertexBuffer) this._vertexBuffer.destroy()
    this._vertexBuffer = device.createBuffer({
      size: Math.max(20, data.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(this._vertexBuffer, 0, data)
    this._builtTiles = tiles
  }

  private _textureFor(
    device: GPUDevice,
    key: string,
    bitmap: ImageBitmap,
  ): GPUBindGroup | null {
    const existing = this._textures.get(key)
    if (existing) return existing.group
    if (!this._textureBGL) return null
    const texture = device.createTexture({
      size: [bitmap.width, bitmap.height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [
      bitmap.width,
      bitmap.height,
    ])
    const group = device.createBindGroup({
      layout: this._textureBGL,
      entries: [{ binding: 0, resource: texture.createView() }],
    })
    this._textures.set(
      key,
      { texture, group },
      bitmap.width * bitmap.height * 4,
    )
    return group
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    mvpMatrix: Float32Array,
    tiles: readonly SlidePlaneTile[],
    slide: NVSlide,
    opacity = 1,
  ): void {
    if (
      !this.isReady ||
      !this._pipeline ||
      !this._uniformBuffer ||
      !this._uniformGroup
    )
      return
    if (this._builtTiles !== tiles || !this._vertexBuffer) {
      this._buildVertices(device, tiles)
    }
    if (!this._vertexBuffer || this._entries.length === 0) return
    // Evict BEFORE beginFrame: the previous frame's working set (and anything
    // drawn earlier this frame) keeps its frame stamp and is never destroyed
    // while a command encoder that references it is still in flight.
    this._textures.evictToBudget()
    this._textures.beginFrame()
    this._scratch.set(mvpMatrix, 0)
    this._scratch[16] = opacity
    device.queue.writeBuffer(this._uniformBuffer, 0, this._scratch)
    pass.setPipeline(this._pipeline)
    pass.setBindGroup(0, this._uniformGroup)
    pass.setVertexBuffer(0, this._vertexBuffer)
    for (const entry of this._entries) {
      const bitmap = slide.cachedTileBitmap(entry.key)
      if (!bitmap) continue
      const group = this._textureFor(device, entry.key, bitmap)
      if (!group) continue
      pass.setBindGroup(1, group)
      pass.draw(4, 1, entry.firstVertex)
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
    if (
      !this.isReady ||
      !this._pipeline ||
      !this._uniformBuffer ||
      !this._uniformGroup ||
      !this._textureBGL
    )
      return
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
    const [tl, tr, bl, br] = ann.corners
    const data = new Float32Array([
      tl[0],
      tl[1],
      tl[2],
      0,
      0,
      tr[0],
      tr[1],
      tr[2],
      1,
      0,
      bl[0],
      bl[1],
      bl[2],
      0,
      1,
      br[0],
      br[1],
      br[2],
      1,
      1,
    ])
    if (!this._annVertexBuffer) {
      this._annVertexBuffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    device.queue.writeBuffer(this._annVertexBuffer, 0, data)
    this._scratch.set(mvpMatrix, 0)
    this._scratch[16] = opacity
    device.queue.writeBuffer(this._uniformBuffer, 0, this._scratch)
    pass.setPipeline(this._pipeline)
    pass.setBindGroup(0, this._uniformGroup)
    pass.setBindGroup(1, this._annGroup)
    pass.setVertexBuffer(0, this._annVertexBuffer)
    pass.draw(4)
  }

  destroy(): void {
    this._textures.clear()
    if (this._vertexBuffer) this._vertexBuffer.destroy()
    if (this._uniformBuffer) this._uniformBuffer.destroy()
    if (this._annTexture) this._annTexture.destroy()
    if (this._annVertexBuffer) this._annVertexBuffer.destroy()
    this._annTexture = null
    this._annVertexBuffer = null
    this._annGroup = null
    this._vertexBuffer = null
    this._uniformBuffer = null
    this._uniformGroup = null
    this._pipeline = null
    this._uniformBGL = null
    this._textureBGL = null
    this._sampler = null
    this._builtTiles = null
    this._entries = []
    this.isReady = false
  }
}
