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
import type { TileGutterGPU, TileTextureGPU } from './tileGutter'

// WebGPU mirror of gl/tileFuse.ts: renders each scalar tile's visible channels
// into its RGBA8 tile texture, one triangle per channel, blended with MAX or a
// clamped sum. Each tile is its own submit, so a raw layer evicted after it is
// never referenced by unsubmitted commands.

type RawGPU = { texture: GPUTexture; group: GPUBindGroup; format: RawFormat }
type Kind = 'uint' | 'sint' | 'float'

const KIND: Record<RawFormat, Kind> = {
  u8: 'uint',
  u16: 'uint',
  i16: 'sint',
  f32: 'float',
}

const FORMATS: Record<RawFormat, [GPUTextureFormat, number]> = {
  u8: ['r8uint', 1],
  u16: ['r16uint', 2],
  i16: ['r16sint', 2],
  f32: ['r32float', 4],
}

const shaderCode = (kind: Kind): string => /* wgsl */ `
struct Params {
  // fuseUniforms, halved: calMin head, width / 512, LUT row, invert
  window: vec4f,
  calMinRest: f32,
};
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var lut: texture_2d<f32>;
@group(1) @binding(0) var raw: texture_2d<${kind === 'uint' ? 'u32' : kind === 'sint' ? 'i32' : 'f32'}>;

@vertex
fn vertex_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // One triangle over the viewport.
  return vec4f(f32((i & 1u) << 2u) - 1.0, f32((i & 2u) << 1u) - 1.0, 0.0, 1.0);
}

@fragment
fn fragment_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let v = f32(textureLoad(raw, vec2i(pos.xy) - 1, 0).r);
  // max() keeps the compiler from folding the two uniforms into one float32 calMin.
  // Halved, as the uniforms (fuseUniforms): v - calMin cannot overflow.
  let d = max(v * 0.5 - p.window.x, -3.4e38) - p.calMinRest;
  // n / w is the level; d * 255 / 256 cannot overflow either.
  let n = d * 0.99609375;
  let w = p.window.y;
  // Math.round(n / w): floor(x + 0.5), then undo a division rounded across a tie.
  var g = floor(n / w + 0.5);
  if ((g - 0.5) * w > n) {
    g -= 1.0;
  } else if ((g + 0.5) * w <= n) {
    g += 1.0;
  }
  // NaN fails the test: level 0, as fuseSamples (clamp(NaN) is undefined).
  g = select(0.0, min(g, 255.0), n > 0.0);
  if (p.window.w > 0.5) {
    g = 255.0 - g;
  }
  return vec4f(textureLoad(lut, vec2i(i32(g), i32(p.window.z)), 0).rgb, 1.0);
}
`

export class TileFuserGPU {
  private readonly _pool: TileTextureCache<RawGPU>
  private readonly _luts = new FuseLutRows()
  private _lutTexture: GPUTexture | null = null
  private _lutVersion = -1
  private _layout: GPUBindGroupLayout | null = null
  private readonly _rawLayouts = new Map<Kind, GPUBindGroupLayout>()
  private readonly _pipelines = new Map<string, GPURenderPipeline>()
  private _uniform: GPUBuffer | null = null
  private _group: GPUBindGroup | null = null
  private _jobs: FuseJob<TileTextureGPU>[] = []

  constructor(maxRawPoolBytes = DEFAULT_RAW_POOL_BYTES) {
    this._pool = new TileTextureCache<RawGPU>(maxRawPoolBytes, (raw) =>
      raw.texture.destroy(),
    )
  }

  /** GPU bytes of pooled raw layers. */
  get poolBytes(): number {
    return this._pool.bytes
  }

  /** The tile texture of scalar `tile`, queued for `flush` (see `fuseTarget`). */
  textureFor(
    device: GPUDevice,
    gutter: TileGutterGPU,
    cache: TileTextureCache<TileTextureGPU>,
    at: GutterAt,
    slide: NVSlide,
    tile: FuseTile,
  ): TileTextureGPU | null {
    return fuseTarget(
      this._jobs,
      cache,
      at,
      slide,
      tile,
      device.limits.maxTextureDimension2D,
      (width, height) => gutter.create(device, width, height, at),
    )
  }

  /**
   * Fuse the queued tiles, then refresh their gutters (`sync` false: defer).
   * Submitted now, so it lands before the frame that draws them.
   */
  flush(
    device: GPUDevice,
    gutter: TileGutterGPU,
    cache: TileTextureCache<TileTextureGPU>,
    sync: boolean,
  ): void {
    const jobs = this._jobs
    if (jobs.length === 0) return
    this._jobs = []
    let most = 1
    for (const job of jobs) {
      most = Math.max(most, job.plan.layers.length)
      for (const l of job.plan.layers) this._luts.row(l.colormap)
    }
    const stride = device.limits.minUniformBufferOffsetAlignment
    const [group, uniform] = this._syncBindings(device, most * stride)
    const lanes = stride / 4
    fuseTiles(
      jobs,
      this._pool,
      (s, plane) => this._upload(device, s, plane),
      ({ target, plan }, layers) => {
        // One uniform slot per channel: a queue write lands before the submit
        // that reads it, and the next tile's write after.
        const params = new Float32Array(Math.max(1, layers.length) * lanes)
        layers.forEach(([l], k) => {
          params.set(
            fuseUniforms(l, this._luts.row(l.colormap), plan.invert),
            k * lanes,
          )
        })
        device.queue.writeBuffer(uniform, 0, params)
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: target.texture.createView(),
              loadOp: 'clear',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              storeOp: 'store',
            },
          ],
        })
        pass.setViewport(1, 1, target.width, target.height, 0, 1)
        layers.forEach(([, raw], k) => {
          pass.setPipeline(
            this._pipeline(device, KIND[raw.format], plan.additive),
          )
          pass.setBindGroup(0, group, [k * stride])
          pass.setBindGroup(1, raw.group)
          pass.draw(3)
        })
        pass.end()
        device.queue.submit([encoder.finish()])
      },
    )
    gutter.sync(
      device,
      jobs.map((j) => j.target),
      cache,
      sync,
    )
  }

  // The LUT texture and a uniform buffer of at least `size` bytes, bound together.
  private _syncBindings(
    device: GPUDevice,
    size: number,
  ): [GPUBindGroup, GPUBuffer] {
    let lut = this._lutTexture
    if (!lut || this._lutVersion !== this._luts.version) {
      lut?.destroy()
      lut = device.createTexture({
        size: [256, Math.max(1, this._luts.rows)],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      this._lutTexture = lut
      if (this._luts.rows)
        device.queue.writeTexture(
          { texture: lut },
          this._luts.data as Uint8Array<ArrayBuffer>,
          { bytesPerRow: 1024 },
          [256, this._luts.rows],
        )
      this._lutVersion = this._luts.version
      this._group = null
    }
    let uniform = this._uniform
    if (!uniform || uniform.size < size) {
      uniform?.destroy()
      uniform = device.createBuffer({
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this._uniform = uniform
      this._group = null
    }
    this._group ??= device.createBindGroup({
      layout: this._groupLayout(device),
      entries: [
        { binding: 0, resource: { buffer: uniform, size: 32 } },
        { binding: 1, resource: lut.createView() },
      ],
    })
    return [this._group, uniform]
  }

  // Group 0: the per-channel window (dynamic offset) and the LUT texture.
  private _groupLayout(device: GPUDevice): GPUBindGroupLayout {
    this._layout ??= device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: 32,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    })
    return this._layout
  }

  private _rawLayout(device: GPUDevice, kind: Kind): GPUBindGroupLayout {
    let layout = this._rawLayouts.get(kind)
    if (!layout) {
      layout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {
              sampleType: kind === 'float' ? 'unfilterable-float' : kind,
            },
          },
        ],
      })
      this._rawLayouts.set(kind, layout)
    }
    return layout
  }

  private _pipeline(
    device: GPUDevice,
    kind: Kind,
    additive: boolean,
  ): GPURenderPipeline {
    const key = `${kind}${additive}`
    let pipeline = this._pipelines.get(key)
    if (!pipeline) {
      const module = device.createShaderModule({ code: shaderCode(kind) })
      // 'max' requires both factors 'one'; the sum clamps in the unorm target.
      const op: GPUBlendComponent = {
        operation: additive ? 'add' : 'max',
        srcFactor: 'one',
        dstFactor: 'one',
      }
      pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [
            this._groupLayout(device),
            this._rawLayout(device, kind),
          ],
        }),
        vertex: { module, entryPoint: 'vertex_main' },
        fragment: {
          module,
          entryPoint: 'fragment_main',
          targets: [{ format: 'rgba8unorm', blend: { color: op, alpha: op } }],
        },
        primitive: { topology: 'triangle-list' },
      })
      this._pipelines.set(key, pipeline)
    }
    return pipeline
  }

  private _upload(
    device: GPUDevice,
    s: NVSlideTileSamples,
    plane: number,
  ): RawGPU {
    const format = rawFormat(s.samples)
    const [textureFormat, bytes] = FORMATS[format]
    const n = s.width * s.height
    const texture = device.createTexture({
      size: [s.width, s.height],
      format: textureFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture },
      s.samples.subarray(plane * n, (plane + 1) * n) as Uint8Array<ArrayBuffer>,
      { bytesPerRow: s.width * bytes },
      [s.width, s.height],
    )
    const group = device.createBindGroup({
      layout: this._rawLayout(device, KIND[format]),
      entries: [{ binding: 0, resource: texture.createView() }],
    })
    return { texture, group, format }
  }

  /** Drop the pooled raw layers (tile textures belong to the caller's cache). */
  clear(): void {
    this._pool.clear()
    this._jobs = []
  }

  destroy(): void {
    this.clear()
    this._lutTexture?.destroy()
    this._uniform?.destroy()
    this._lutTexture = null
    this._uniform = null
    this._group = null
    this._lutVersion = -1
    // Device objects: a later device builds its own.
    this._layout = null
    this._rawLayouts.clear()
    this._pipelines.clear()
  }
}
