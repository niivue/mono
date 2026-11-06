import { ubuntu } from '@/assets/fonts'
import { colorLutWgsl } from '@/slide/colorLutShader'
import {
  IDENTITY_COLOR_LUT,
  type NVSlide,
  type NVSlideColor,
  type NVSlideScreen,
  type NVSlideScreenRect,
} from '@/slide/NVSlide'
import {
  buildSlideOverlay,
  SLIDE_OVERLAY_MAX_GLYPHS,
  SLIDE_OVERLAY_MAX_LINES,
  type SlideOverlayContent,
} from '@/slide/slideOverlay'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  TileTextureCache,
} from '@/slide/tileTextureCache'
import { buildLine } from '@/view/NVLine'
import type { UIKitOverlayFrame } from '@/view/NVOverlayHook'
import { timeChunkPhase } from '@/volume/chunkTiming'
import { FontRenderer } from './font'
import { LineRenderer } from './line'
import {
  alphaPipelineDesc,
  ColorLutTexturesGPU,
  colorLutLayout,
  linearSampler,
  texturedLayout,
} from './pipeline'

/** The slide shader, with or without the colour table lookup (bind group 1). */
const shaderCode = (lut: boolean): string => /* wgsl */ `
struct SlideUniforms {
  // Four NDC corners packed as (x, y) pairs in triangle-strip order.
  corners: array<vec4f, 2>,
  // uv for the four corners (matches corner order).
  uvs: array<vec4f, 2>,
  opacity: f32,
  isPlaceholder: f32,
  showGrid: f32,
  pad: f32,
  placeholderColor: vec4f,
  gridColor: vec4f,
};

@group(0) @binding(0) var<uniform> u: SlideUniforms;
@group(0) @binding(1) var slideTex: texture_2d<f32>;
@group(0) @binding(2) var slideSampler: sampler;
${colorLutWgsl(1, lut)}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertex_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
  var ndc = vec2f(0.0);
  var uv = vec2f(0.0);
  if (vIdx == 0u) {
    ndc = u.corners[0].xy;
    uv = u.uvs[0].xy;
  } else if (vIdx == 1u) {
    ndc = u.corners[0].zw;
    uv = u.uvs[0].zw;
  } else if (vIdx == 2u) {
    ndc = u.corners[1].xy;
    uv = u.uvs[1].xy;
  } else {
    ndc = u.corners[1].zw;
    uv = u.uvs[1].zw;
  }
  var out: VertexOutput;
  out.position = vec4f(ndc.x, ndc.y, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  var base = vec4f(0.0);
  if (u.isPlaceholder == 1.0) {
    base = u.placeholderColor;
  } else {
    base = textureSample(slideTex, slideSampler, in.uv);
    base = vec4f(applyColorLut(base.rgb), base.a);
  }
  base.a = base.a * u.opacity;
  if (u.showGrid == 1.0) {
    let edge = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
    let border = 1.0 - smoothstep(0.0, 0.018, edge);
    base = mix(
      base,
      vec4f(u.gridColor.rgb, max(base.a, u.gridColor.a)),
      border * u.gridColor.a,
    );
  }
  return base;
}
`

// 2 vec4 corners + 2 vec4 uvs + 4 scalar floats + 2 vec4 colors = 16 vec4 lanes.
const UNIFORM_FLOAT_COUNT = 16 * 4
const UNIFORM_BYTE_SIZE = UNIFORM_FLOAT_COUNT * 4

type SlideTexture = {
  texture: GPUTexture
  width: number
  height: number
}

type QuadOptions = {
  uvTop: number
  uvBottom: number
  opacity: number
  isPlaceholder: boolean
  showGrid: boolean
  placeholderColor: NVSlideColor
  gridColor: NVSlideColor
}

export class SlideRendererGPU {
  /**
   * Sample tiles with nearest-neighbour filtering instead of linear, so each
   * source pixel shows as a crisp square when zoomed in.
   */
  isNearestInterpolation = false
  private readonly _canvas: HTMLCanvasElement
  private readonly _device: GPUDevice
  private readonly _context: GPUCanvasContext
  private readonly _pipeline: GPURenderPipeline
  private readonly _lutPipeline: GPURenderPipeline
  private readonly _bindLayout: GPUBindGroupLayout
  private readonly _luts: ColorLutTexturesGPU
  private readonly _sampler: GPUSampler
  private readonly _nearestSampler: GPUSampler
  private _placeholderTexture: GPUTexture | null
  private readonly _format: GPUTextureFormat
  // Byte-budgeted: tile textures for scrolled-away regions are evicted each
  // frame instead of accumulating for the life of the renderer. Eviction runs
  // before beginFrame (see render), so a texture referenced by the frame just
  // submitted is never destroyed while its commands are in flight.
  private readonly _textures = new TileTextureCache<SlideTexture>(
    DEFAULT_TILE_TEXTURE_BYTES,
    (entry) => entry.texture.destroy(),
  )
  private readonly _uniformPool: GPUBuffer[] = []
  private _uniformCursor = 0
  /**
   * UIKit overlay hook: invoked at the end of every frame (appended to the open
   * pass, before pass.end()) so a widget can draw over the slide. The slide pass
   * has no depth attachment and no MSAA, so the frame's handle omits depthFormat
   * and reports sampleCount 1. See view/NVOverlayHook.ts.
   */
  overlayDraw: ((frame: UIKitOverlayFrame) => void) | null = null
  /**
   * Rulers and selection drawn over the tiles with NiiVue's own line and font
   * renderers, before `overlayDraw` (see `slideOverlayContent`).
   */
  overlay: SlideOverlayContent | null = null
  private readonly _lines = new LineRenderer()
  private readonly _font = new FontRenderer()
  private _lineStorage: GPUBuffer | null = null
  private _glyphStorage: GPUBuffer | null = null
  private _lineBindGroup: GPUBindGroup | null = null
  private _fontBindGroup: GPUBindGroup | null = null

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    lutPipeline: GPURenderPipeline,
    bindLayout: GPUBindGroupLayout,
    lutLayout: GPUBindGroupLayout,
    sampler: GPUSampler,
    placeholderTexture: GPUTexture,
    format: GPUTextureFormat,
  ) {
    this._luts = new ColorLutTexturesGPU(device, lutLayout, sampler)
    this._canvas = canvas
    this._device = device
    this._context = context
    this._pipeline = pipeline
    this._lutPipeline = lutPipeline
    this._bindLayout = bindLayout
    this._sampler = sampler
    this._nearestSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    this._placeholderTexture = placeholderTexture
    this._format = format
  }

  static async create(
    canvas: HTMLCanvasElement,
  ): Promise<SlideRendererGPU | null> {
    if (!navigator.gpu) return null
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return null
    const device = await adapter.requestDevice()
    if (!device) return null

    const context = canvas.getContext('webgpu')
    if (!context) return null
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })

    const sampler = linearSampler(device)
    const bindLayout = texturedLayout(
      device,
      GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    )
    const lutLayout = colorLutLayout(device)
    // No depth attachment, single-sample canvas.
    const pipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: shaderCode(false) }),
        bindGroupLayouts: [bindLayout],
        format,
      }),
    )
    const lutPipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: shaderCode(true) }),
        bindGroupLayouts: [bindLayout, lutLayout],
        format,
      }),
    )

    const placeholderTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.writeTexture(
      { texture: placeholderTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    )

    const renderer = new SlideRendererGPU(
      canvas,
      device,
      context,
      pipeline,
      lutPipeline,
      bindLayout,
      lutLayout,
      sampler,
      placeholderTexture,
      format,
    )
    await renderer._initOverlay()
    return renderer
  }

  // The slide pass has no depth attachment and no MSAA.
  private async _initOverlay(): Promise<void> {
    const device = this._device
    await this._lines.init(device, this._format, 1, null)
    await this._font.init(device, this._format, 1, ubuntu, null)
    this._lineStorage = device.createBuffer({
      // 48 B a line and 64 B a glyph, as NVViewGPU's.
      size: SLIDE_OVERLAY_MAX_LINES * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this._glyphStorage = device.createBuffer({
      size: SLIDE_OVERLAY_MAX_GLYPHS * 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this._lineBindGroup = this._lines.createBindGroup(device, this._lineStorage)
    this._fontBindGroup = this._font.createBindGroup(
      device,
      this._glyphStorage,
      this._sampler,
    )
  }

  private _drawOverlay(
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    dpr: number,
  ): void {
    if (!this.overlay || !this._lineStorage || !this._glyphStorage) return
    const device = this._device
    this._lines.resize(device, width, height)
    this._font.resize(device, width, height, dpr)
    const { lines, labels } = buildSlideOverlay(
      this.overlay,
      (...a) => this._font.buildText(...a),
      buildLine,
      this._font.fontPx * 0.5,
    )
    this._lines.draw(
      device,
      pass,
      this._lineBindGroup,
      this._lineStorage,
      lines,
      SLIDE_OVERLAY_MAX_LINES,
    )
    this._font.draw(
      device,
      pass,
      this._fontBindGroup,
      this._glyphStorage,
      labels,
      SLIDE_OVERLAY_MAX_GLYPHS,
    )
  }

  render(slides: readonly NVSlide[], screen: NVSlideScreen): void {
    if (!this._placeholderTexture) return
    const dpr = screen.devicePixelRatio ?? 1
    const width = Math.max(1, Math.floor(screen.widthCss * dpr))
    const height = Math.max(1, Math.floor(screen.heightCss * dpr))
    if (this._canvas.width !== width) this._canvas.width = width
    if (this._canvas.height !== height) this._canvas.height = height

    this._uniformCursor = 0
    this._textures.evictToBudget()
    this._textures.beginFrame()
    const encoder = this._device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this._context.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        },
      ],
    })
    for (const slide of slides) {
      if (!slide.visible || slide.opacity <= 0) continue
      // The plain pipeline unless the slide has a colour table to apply.
      const lut = slide.displayColorLut
      if (lut === IDENTITY_COLOR_LUT) pass.setPipeline(this._pipeline)
      else {
        pass.setPipeline(this._lutPipeline)
        pass.setBindGroup(1, this._luts.group(lut))
      }
      const bounds = slide.screenRectForSlide(screen)
      this.drawQuad(pass, width, height, bounds, this._placeholderTexture, {
        uvTop: 0,
        uvBottom: 1,
        opacity: slide.opacity,
        isPlaceholder: true,
        showGrid: false,
        placeholderColor: slide.backgroundColor,
        gridColor: slide.gridColor,
      })

      const visible = slide.requestVisibleTiles(screen)
      // Coarser levels first, painted UNDER the target level. Non-empty only
      // while target tiles are still arriving, so the previous resolution stays
      // on screen and is overpainted tile by tile as the finer data lands.
      // No tile grid here: the grid describes the target level.
      for (const item of visible.fallback) {
        const bitmap = slide.cachedTileBitmap(item.key)
        if (!bitmap) continue
        const texture = this.textureForBitmap(item.key, bitmap)
        if (!texture) continue
        this.drawQuad(
          pass,
          width,
          height,
          {
            x: item.screenX,
            y: item.screenY,
            width: item.screenWidth,
            height: item.screenHeight,
          },
          texture.texture,
          {
            uvTop: item.flipY ? 1 : 0,
            uvBottom: item.flipY ? 0 : 1,
            opacity: slide.opacity,
            isPlaceholder: false,
            showGrid: false,
            placeholderColor: slide.placeholderColor,
            gridColor: slide.gridColor,
          },
        )
      }
      for (const item of visible.tiles) {
        const bitmap = slide.cachedTileBitmap(item.key)
        // A missing tile draws a flat placeholder ONLY when nothing coarser is
        // behind it; otherwise the placeholder would hide the very fallback
        // layer that is standing in for it.
        if (!bitmap && visible.fallback.length > 0) continue
        const texture = bitmap ? this.textureForBitmap(item.key, bitmap) : null
        const rect: NVSlideScreenRect = {
          x: item.screenX,
          y: item.screenY,
          width: item.screenWidth,
          height: item.screenHeight,
        }
        this.drawQuad(
          pass,
          width,
          height,
          rect,
          texture?.texture ?? this._placeholderTexture,
          {
            uvTop: item.flipY ? 1 : 0,
            uvBottom: item.flipY ? 0 : 1,
            opacity: slide.opacity,
            isPlaceholder: !texture,
            showGrid: slide.showTileGrid,
            placeholderColor: slide.placeholderColor,
            gridColor: slide.gridColor,
          },
        )
      }
    }

    this._drawOverlay(pass, width, height, dpr)

    // UIKit overlay hook: append the widget's draws to the open pass. The slide
    // pass has no depth attachment (depthFormat omitted) and no MSAA.
    if (this.overlayDraw) {
      this.overlayDraw({
        handle: {
          backend: 'webgpu',
          device: this._device,
          pass,
          colorFormat: this._format,
          sampleCount: 1,
        },
        bounds: { x: 0, y: 0, width, height },
        dpr,
        settled: true,
      })
    }

    pass.end()
    this._device.queue.submit([encoder.finish()])
  }

  // Drop every cached tile texture without tearing down the renderer. Mirrors
  // SlideRenderer.clearTextures (GL): tile textures are keyed by tile key, a
  // namespace shared across slides, so a consumer swapping the slide must clear
  // first to avoid inheriting the previous slide's tiles (ghost tiles).
  clearTextures(): void {
    this._textures.clear()
    this._luts.clear()
  }

  destroy(): void {
    this._textures.clear()
    this._luts.clear()
    this._lines.destroy()
    this._font.destroy()
    this._lineStorage?.destroy()
    this._glyphStorage?.destroy()
    for (const buffer of this._uniformPool) {
      buffer.destroy()
    }
    this._uniformPool.length = 0
    if (this._placeholderTexture) {
      this._placeholderTexture.destroy()
      this._placeholderTexture = null
    }
  }

  private acquireUniformBuffer(): GPUBuffer {
    const existing = this._uniformPool[this._uniformCursor]
    if (existing) {
      this._uniformCursor++
      return existing
    }
    const buffer = this._device.createBuffer({
      size: UNIFORM_BYTE_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this._uniformPool.push(buffer)
    this._uniformCursor++
    return buffer
  }

  private textureForBitmap(
    key: string,
    bitmap: ImageBitmap,
  ): SlideTexture | null {
    // Keyed by the bitmap too: a re-windowed tile is a new bitmap (set() replaces).
    const existing = this._textures.get(key, bitmap)
    if (existing) return existing
    const texture = this._device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    // Timed as `upload` alongside the volume path's brick uploads: a slide tile
    // and a volume brick are two consumers of the same streamed source, and
    // both pay their texture cost on this thread.
    timeChunkPhase(
      'upload',
      () =>
        this._device.queue.copyExternalImageToTexture(
          { source: bitmap },
          { texture },
          [bitmap.width, bitmap.height],
        ),
      bitmap.width * bitmap.height * 4,
    )
    const entry: SlideTexture = {
      texture,
      width: bitmap.width,
      height: bitmap.height,
    }
    this._textures.set(key, entry, bitmap.width * bitmap.height * 4, bitmap)
    return entry
  }

  private drawQuad(
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    rect: NVSlideScreenRect,
    texture: GPUTexture,
    options: QuadOptions,
  ): void {
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x + rect.width < 0 ||
      rect.y + rect.height < 0 ||
      rect.x > width ||
      rect.y > height
    ) {
      return
    }

    const x0 = (rect.x / width) * 2 - 1
    const x1 = ((rect.x + rect.width) / width) * 2 - 1
    const y0 = 1 - (rect.y / height) * 2
    const y1 = 1 - ((rect.y + rect.height) / height) * 2

    const data = new Float32Array(UNIFORM_FLOAT_COUNT)
    // corners[0] = (v0.xy, v1.xy), corners[1] = (v2.xy, v3.xy)
    data[0] = x0
    data[1] = y0
    data[2] = x1
    data[3] = y0
    data[4] = x0
    data[5] = y1
    data[6] = x1
    data[7] = y1
    // uvs[0] = (v0.uv, v1.uv), uvs[1] = (v2.uv, v3.uv)
    data[8] = 0
    data[9] = options.uvTop
    data[10] = 1
    data[11] = options.uvTop
    data[12] = 0
    data[13] = options.uvBottom
    data[14] = 1
    data[15] = options.uvBottom
    // opacity, isPlaceholder, showGrid, pad
    data[16] = options.opacity
    data[17] = options.isPlaceholder ? 1 : 0
    data[18] = options.showGrid ? 1 : 0
    data[19] = 0
    // placeholderColor
    data[20] = options.placeholderColor[0]
    data[21] = options.placeholderColor[1]
    data[22] = options.placeholderColor[2]
    data[23] = options.placeholderColor[3]
    // gridColor
    data[24] = options.gridColor[0]
    data[25] = options.gridColor[1]
    data[26] = options.gridColor[2]
    data[27] = options.gridColor[3]

    const buffer = this.acquireUniformBuffer()
    this._device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>)
    const bindGroup = this._device.createBindGroup({
      layout: this._bindLayout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: texture.createView() },
        {
          binding: 2,
          resource: this.isNearestInterpolation
            ? this._nearestSampler
            : this._sampler,
        },
      ],
    })
    pass.setBindGroup(0, bindGroup)
    pass.draw(4)
  }
}
