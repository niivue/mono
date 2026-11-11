import { ubuntu } from '@/assets/fonts'
import { colorLutWgsl } from '@/slide/colorLutShader'
import type {
  NVSlide,
  NVSlideColor,
  NVSlideScreen,
  NVSlideScreenRect,
  NVSlideVisibleTile,
} from '@/slide/NVSlide'
import {
  buildSlideOverlay,
  SLIDE_OVERLAY_MAX_GLYPHS,
  SLIDE_OVERLAY_MAX_LINES,
  type SlideOverlayContent,
} from '@/slide/slideOverlay'
import { forEachSlideTile, slideRectNdc } from '@/slide/slideTiles'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  slideTileKey,
  TileTextureCache,
} from '@/slide/tileTextureCache'
import { buildLine } from '@/view/NVLine'
import type { UIKitOverlayFrame } from '@/view/NVOverlayHook'
import { timeChunkPhase } from '@/volume/chunkTiming'
import { ColorLutTexturesGPU, colorLutLayout } from './colorLut'
import { FontRenderer } from './font'
import { LineRenderer } from './line'
import { alphaPipelineDesc, linearSampler, texturedLayout } from './pipeline'
import { TileGutterGPU, type TileTextureGPU } from './tileGutter'

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
  isNearest: f32,
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
    // Tile textures carry a 1-texel gutter (slide/tileGutter.ts): sample the interior.
    let size = vec2f(textureDimensions(slideTex));
    var texel = in.uv * (size - 2.0) + 1.0;
    // Nearest skips the gutter copies, yet an edge sample (uv at 0 or 1, or
    // past it under MSAA) would read the gutter: clamp to the edge texels.
    if (u.isNearest == 1.0) {
      texel = clamp(texel, vec2f(1.5), size - 1.5);
    }
    base = textureSample(slideTex, slideSampler, texel / size);
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
  private readonly _sampleCount: number
  // The multisampled colour target `antialias` draws into, resolved to the
  // canvas each frame; recreated when the canvas size changes.
  private _msaaTexture: GPUTexture | null = null
  // Byte-budgeted: tile textures for scrolled-away regions are evicted each
  // frame instead of accumulating for the life of the renderer. Eviction runs
  // before beginFrame (see render), so a texture referenced by the frame just
  // submitted is never destroyed while its commands are in flight.
  private readonly _textures = new TileTextureCache<TileTextureGPU>(
    DEFAULT_TILE_TEXTURE_BYTES,
    (entry) => entry.texture.destroy(),
  )
  private readonly _gutter = new TileGutterGPU()
  private readonly _uniformPool: GPUBuffer[] = []
  private _uniformCursor = 0
  /**
   * UIKit overlay hook: invoked at the end of every frame (appended to the open
   * pass, before pass.end()) so a widget can draw over the slide. The slide pass
   * has no depth attachment, so the frame's handle omits depthFormat; it reports
   * the pass's sampleCount (4 with `antialias`, else 1). See view/NVOverlayHook.ts.
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
    sampleCount: number,
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
    this._sampleCount = sampleCount
  }

  /**
   * `antialias` draws into a 4x multisample target resolved to the canvas. It
   * smooths geometry edges (a rotated slide's border, rulers, annotations),
   * not the tile image, which is already filtered.
   */
  static async create(
    canvas: HTMLCanvasElement,
    options: { antialias?: boolean } = {},
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
    const msaaCount = options.antialias ? 4 : 1
    const pipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: shaderCode(false) }),
        bindGroupLayouts: [bindLayout],
        format,
        msaaCount,
      }),
    )
    const lutPipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: shaderCode(true) }),
        bindGroupLayouts: [bindLayout, lutLayout],
        format,
        msaaCount,
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
      msaaCount,
    )
    await renderer._initOverlay()
    return renderer
  }

  // The slide pass has no depth attachment; overlays match its sample count.
  private async _initOverlay(): Promise<void> {
    const device = this._device
    await this._lines.init(device, this._format, this._sampleCount, null)
    await this._font.init(device, this._format, this._sampleCount, ubuntu, null)
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
    const placeholder = this._placeholderTexture
    if (!placeholder) return
    const dpr = screen.devicePixelRatio ?? 1
    const width = Math.max(1, Math.floor(screen.widthCss * dpr))
    const height = Math.max(1, Math.floor(screen.heightCss * dpr))
    if (this._canvas.width !== width) this._canvas.width = width
    if (this._canvas.height !== height) this._canvas.height = height

    this._uniformCursor = 0
    this._textures.evictToBudget()
    this._textures.beginFrame()
    if (!this.isNearestInterpolation)
      this._gutter.resync(this._device, this._textures)
    const encoder = this._device.createCommandEncoder()
    const canvasView = this._context.getCurrentTexture().createView()
    const msaa = this._msaaView(width, height)
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          // With antialias, draw into the multisample target and resolve it
          // to the canvas; the samples themselves need not be kept.
          view: msaa ?? canvasView,
          resolveTarget: msaa ? canvasView : undefined,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: msaa ? 'discard' : 'store',
        },
      ],
    })
    for (const slide of slides) {
      if (!slide.visible || slide.opacity <= 0) continue
      // The plain pipeline unless the slide has a colour table to apply.
      const lut = slide.displayColorLut
      if (lut) {
        pass.setPipeline(this._lutPipeline)
        pass.setBindGroup(1, this._luts.group(lut))
      } else pass.setPipeline(this._pipeline)
      const bounds = slide.screenRectForSlide(screen)
      this.drawQuad(pass, width, height, bounds, placeholder, {
        uvTop: 0,
        uvBottom: 1,
        opacity: slide.opacity,
        isPlaceholder: true,
        showGrid: false,
        placeholderColor: slide.backgroundColor,
        gridColor: slide.gridColor,
      })

      forEachSlideTile(slide, screen, (item, bitmap, rect, isFallback) => {
        const texture = bitmap ? this.textureForBitmap(item, bitmap) : null
        if (isFallback && !texture) return
        this.drawQuad(
          pass,
          width,
          height,
          rect,
          texture?.texture ?? placeholder,
          {
            uvTop: item.flipY ? 1 : 0,
            uvBottom: item.flipY ? 0 : 1,
            opacity: slide.opacity,
            isPlaceholder: !texture,
            showGrid: !isFallback && slide.showTileGrid,
            placeholderColor: slide.placeholderColor,
            gridColor: slide.gridColor,
          },
        )
      })
    }

    this._drawOverlay(pass, width, height, dpr)

    // UIKit overlay hook: append the widget's draws to the open pass. The slide
    // pass has no depth attachment (depthFormat omitted).
    if (this.overlayDraw) {
      this.overlayDraw({
        handle: {
          backend: 'webgpu',
          device: this._device,
          pass,
          colorFormat: this._format,
          sampleCount: this._sampleCount,
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
  // SlideRenderer.clearTextures (GL): frees a swapped-out slide's tiles now
  // rather than when the byte budget evicts them.
  clearTextures(): void {
    this._textures.clear()
    this._luts.clear()
  }

  private _msaaView(width: number, height: number): GPUTextureView | null {
    if (this._sampleCount === 1) return null
    let t = this._msaaTexture
    if (!t || t.width !== width || t.height !== height) {
      t?.destroy()
      t = this._msaaTexture = this._device.createTexture({
        size: [width, height],
        format: this._format,
        sampleCount: this._sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
    }
    return t.createView()
  }

  destroy(): void {
    this._msaaTexture?.destroy()
    this._msaaTexture = null
    this._textures.clear()
    this._gutter.destroy()
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
    item: NVSlideVisibleTile,
    bitmap: ImageBitmap,
  ): TileTextureGPU | null {
    // Keyed by the bitmap too: a re-windowed tile is a new bitmap (set() replaces).
    const key = slideTileKey(item.slide, item.key)
    const existing = this._textures.get(key, bitmap)
    if (existing) return existing
    // Timed as `upload` alongside the volume path's brick uploads: a slide tile
    // and a volume brick are two consumers of the same streamed source, and
    // both pay their texture cost on this thread.
    return timeChunkPhase(
      'upload',
      () =>
        this._gutter.upload(
          this._device,
          bitmap,
          {
            slide: item.slide,
            key,
            level: item.level.index,
            col: item.tile.x,
            row: item.tile.y,
          },
          this._textures,
          // Nearest needs no gutter (the shader clamps); resync fills it.
          !this.isNearestInterpolation,
        ),
      bitmap.width * bitmap.height * 4,
    )
  }

  private drawQuad(
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    rect: NVSlideScreenRect,
    texture: GPUTexture,
    options: QuadOptions,
  ): void {
    const ndc = slideRectNdc(rect, width, height)
    if (!ndc) return
    const [x0, y0, x1, y1] = ndc

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
    // opacity, isPlaceholder, showGrid, isNearest
    data[16] = options.opacity
    data[17] = options.isPlaceholder ? 1 : 0
    data[18] = options.showGrid ? 1 : 0
    data[19] = this.isNearestInterpolation ? 1 : 0
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
