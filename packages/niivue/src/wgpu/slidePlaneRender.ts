import type { SlidePlaneState } from '@/slide/slidePlane'
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
  private _builtState: SlidePlaneState | null = null
  private _textures = new Map<string, GPUTexture>()
  private _bindGroups = new Map<string, GPUBindGroup>()
  private readonly _scratch = new Float32Array(20) // mat4 (16) + opacity vec4 (4)

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

  // Build one vertex buffer holding every plane quad (4 verts each). Positions
  // are fixed once the plane is registered; only textures stream in.
  private _buildVertices(device: GPUDevice, state: SlidePlaneState): void {
    const data = new Float32Array(state.tiles.length * 4 * 5)
    this._entries = []
    let o = 0
    state.tiles.forEach((tile, i) => {
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
    this._builtState = state
  }

  private _textureFor(
    device: GPUDevice,
    key: string,
    bitmap: ImageBitmap,
  ): GPUBindGroup | null {
    const existing = this._bindGroups.get(key)
    if (existing) return existing
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
    this._textures.set(key, texture)
    this._bindGroups.set(key, group)
    return group
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    mvpMatrix: Float32Array,
    state: SlidePlaneState,
    opacity = 1,
  ): void {
    if (
      !this.isReady ||
      !this._pipeline ||
      !this._uniformBuffer ||
      !this._uniformGroup
    )
      return
    if (this._builtState !== state || !this._vertexBuffer) {
      this._buildVertices(device, state)
    }
    if (!this._vertexBuffer) return
    this._scratch.set(mvpMatrix, 0)
    this._scratch[16] = opacity
    device.queue.writeBuffer(this._uniformBuffer, 0, this._scratch)
    pass.setPipeline(this._pipeline)
    pass.setBindGroup(0, this._uniformGroup)
    pass.setVertexBuffer(0, this._vertexBuffer)
    for (const entry of this._entries) {
      const bitmap = state.slide.cachedTileBitmap(entry.key)
      if (!bitmap) continue
      const group = this._textureFor(device, entry.key, bitmap)
      if (!group) continue
      pass.setBindGroup(1, group)
      pass.draw(4, 1, entry.firstVertex)
    }
  }

  destroy(): void {
    for (const tex of this._textures.values()) tex.destroy()
    this._textures.clear()
    this._bindGroups.clear()
    if (this._vertexBuffer) this._vertexBuffer.destroy()
    if (this._uniformBuffer) this._uniformBuffer.destroy()
    this._vertexBuffer = null
    this._uniformBuffer = null
    this._uniformGroup = null
    this._pipeline = null
    this._uniformBGL = null
    this._textureBGL = null
    this._sampler = null
    this._builtState = null
    this._entries = []
    this.isReady = false
  }
}
