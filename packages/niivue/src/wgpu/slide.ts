import { ubuntu } from '@/assets/fonts'
import { colorLutWgsl } from '@/slide/colorLutShader'
import type {
  NVSlide,
  NVSlideCachedTile,
  NVSlideScreen,
  NVSlideVisibleTile,
} from '@/slide/NVSlide'
import {
  isFuseTile,
  rawPoolBytes,
  SlideBudgetRegistration,
  type SlideRendererOptions,
} from '@/slide/slideFuse'
import {
  buildSlideOverlay,
  SLIDE_OVERLAY_MAX_GLYPHS,
  SLIDE_OVERLAY_MAX_LINES,
  type SlideOverlayContent,
} from '@/slide/slideOverlay'
import {
  frameTextureBudget,
  planTextures,
  SlideFramePlan,
  writeRectNdc,
  writeTileUv,
} from '@/slide/slideTiles'
import type { GutterAt } from '@/slide/tileGutter'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  TileTextureCache,
} from '@/slide/tileTextureCache'
import { buildLine } from '@/view/NVLine'
import type { UIKitOverlayFrame } from '@/view/NVOverlayHook'
import { timeChunkPhase } from '@/volume/chunkTiming'
import { ColorLutTexturesGPU, colorLutLayout } from './colorLut'
import { FontRenderer } from './font'
import { LineRenderer } from './line'
import { alphaPipelineDesc, linearSampler } from './pipeline'
import { TileFuserGPU } from './tileFuse'
import { TileGutterGPU, type TileTextureGPU } from './tileGutter'

/** The slide shader, with or without the colour table lookup (bind group 2). */
const shaderCode = (lut: boolean): string => /* wgsl */ `
struct SlideUniforms {
  rect: vec4f, // clip-space x0, y0, x1, y1
  uvRect: vec4f, // u0, v0 (top), u1, v1 (bottom)
  opacity: f32,
  isPlaceholder: f32,
  showGrid: f32,
  isNearest: f32,
  placeholderColor: vec4f,
  gridColor: vec4f,
  // A mixed fused tile's label channels (slideFuse.ts fuseTarget), combined
  // nearest with the intensity: 0 none, 1 max, 2 saturating sum.
  labelBlend: vec4f,
};

@group(0) @binding(0) var<uniform> u: SlideUniforms;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var nearestSampler: sampler;
@group(1) @binding(0) var slideTex: texture_2d<f32>;
@group(1) @binding(1) var labelTex: texture_2d<f32>;
${colorLutWgsl(2, lut)}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) local: vec2f,
};

@vertex
fn vertex_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
  // The unit quad corner, triangle-strip order TL, TR, BL, BR; select picks
  // the CPU's corners exactly.
  let c = vec2<bool>((vIdx & 1u) == 1u, vIdx >= 2u);
  var out: VertexOutput;
  out.position = vec4f(select(u.rect.xy, u.rect.zw, c), 0.0, 1.0);
  out.uv = select(u.uvRect.xy, u.uvRect.zw, c);
  out.local = select(vec2f(0.0), vec2f(1.0), c);
  return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  var base = u.placeholderColor;
  if (u.isPlaceholder != 1.0) {
    // Tile textures carry a 1-texel gutter (slide/tileGutter.ts): sample the interior.
    let size = vec2f(textureDimensions(slideTex));
    let texel = in.uv * (size - 2.0) + 1.0;
    if (u.isNearest == 1.0) {
      // Nearest skips the gutter copies, yet an edge sample (uv at 0 or 1, or
      // past it under MSAA) would read the gutter: clamp to the edge texels.
      base = textureSample(slideTex, nearestSampler, clamp(texel, vec2f(1.5), size - 1.5) / size);
    } else {
      base = textureSample(slideTex, linearSampler, texel / size);
    }
    if (u.labelBlend.x != 0.0) {
      let l = textureLoad(labelTex, clamp(vec2i(texel), vec2i(1), vec2i(size) - 2), 0).rgb;
      base = vec4f(select(max(base.rgb, l), min(base.rgb + l, vec3f(1.0)), u.labelBlend.x == 2.0), base.a);
    }
    base = vec4f(applyColorLut(base.rgb), base.a);
  }
  base.a = base.a * u.opacity;
  if (u.showGrid == 1.0) {
    // Quad-local: a cropped or flipped tile's grid still runs along its edges.
    let edge = min(min(in.local.x, 1.0 - in.local.x), min(in.local.y, 1.0 - in.local.y));
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

// 6 vec4: rect, uvRect, (opacity, isPlaceholder, showGrid, isNearest), colours, labelBlend.
const UNIFORM_BYTES = 96
// Quads the uniform buffer holds at first; it doubles when a frame needs more.
const INITIAL_QUADS = 64

const UNIT_UV = [0, 0, 1, 1]

// The (opacity, isPlaceholder, showGrid, isNearest) lane of a uniform slot.
function writeQuadParams(
  data: Float32Array,
  o: number,
  opacity: number,
  isPlaceholder: boolean,
  showGrid: boolean,
  isNearest: boolean,
): void {
  data[o + 8] = opacity
  data[o + 9] = isPlaceholder ? 1 : 0
  data[o + 10] = showGrid ? 1 : 0
  data[o + 11] = isNearest ? 1 : 0
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
  private readonly _uniformLayout: GPUBindGroupLayout
  private readonly _textureLayout: GPUBindGroupLayout
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
  private readonly _textures: TileTextureCache<TileTextureGPU>
  private readonly _gutter = new TileGutterGPU()
  private readonly _fuser: TileFuserGPU
  private readonly _budget: SlideBudgetRegistration
  private readonly _maxPoolBytes: number
  private readonly _plan = new SlideFramePlan()
  private readonly _planTextures: (TileTextureGPU | null)[] = []
  // Every quad's uniforms, one aligned slot each (dynamic offset), written
  // with one writeBuffer per frame; grown (with its bind group) on demand.
  private readonly _uniformStride: number
  private _uniformBuffer: GPUBuffer | null = null
  private _uniformData = new Float32Array(0)
  private _uniformGroup: GPUBindGroup | null = null
  // One bind group per texture, made the first time it is drawn.
  private readonly _textureGroups = new WeakMap<GPUTexture, GPUBindGroup>()
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
    uniformLayout: GPUBindGroupLayout,
    textureLayout: GPUBindGroupLayout,
    lutLayout: GPUBindGroupLayout,
    sampler: GPUSampler,
    placeholderTexture: GPUTexture,
    format: GPUTextureFormat,
    sampleCount: number,
    maxRawPoolBytes: number,
  ) {
    this._maxPoolBytes = maxRawPoolBytes
    this._fuser = new TileFuserGPU(maxRawPoolBytes)
    this._budget = new SlideBudgetRegistration(this, maxRawPoolBytes)
    this._textures = new TileTextureCache<TileTextureGPU>(
      DEFAULT_TILE_TEXTURE_BYTES,
      (entry) => {
        entry.texture.destroy()
        entry.labels?.destroy()
      },
    )
    this._luts = new ColorLutTexturesGPU(device, lutLayout, sampler)
    this._canvas = canvas
    this._device = device
    this._context = context
    this._pipeline = pipeline
    this._lutPipeline = lutPipeline
    this._uniformLayout = uniformLayout
    this._textureLayout = textureLayout
    const align = device.limits.minUniformBufferOffsetAlignment
    this._uniformStride = Math.ceil(UNIFORM_BYTES / align) * align
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
    this._ensureQuads(INITIAL_QUADS)
  }

  /**
   * `antialias` draws into a 4x multisample target resolved to the canvas. It
   * smooths geometry edges (a rotated slide's border, rulers, annotations),
   * not the tile image, which is already filtered.
   */
  static async create(
    canvas: HTMLCanvasElement,
    options: { antialias?: boolean } & SlideRendererOptions = {},
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
    const fragment = GPUShaderStage.FRAGMENT
    const uniformLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | fragment,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: UNIFORM_BYTES,
          },
        },
        { binding: 1, visibility: fragment, sampler: {} },
        { binding: 2, visibility: fragment, sampler: {} },
      ],
    })
    const textureLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragment, texture: {} },
        { binding: 1, visibility: fragment, texture: {} },
      ],
    })
    const lutLayout = colorLutLayout(device)
    const msaaCount = options.antialias ? 4 : 1
    const pipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: shaderCode(false) }),
        bindGroupLayouts: [uniformLayout, textureLayout],
        format,
        msaaCount,
      }),
    )
    const lutPipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: shaderCode(true) }),
        bindGroupLayouts: [uniformLayout, textureLayout, lutLayout],
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
      uniformLayout,
      textureLayout,
      lutLayout,
      sampler,
      placeholderTexture,
      format,
      msaaCount,
      rawPoolBytes(options.maxRawPoolBytes),
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

  /**
   * Draw `slides`: per slide its background, fallback tiles, then target tiles
   * (SlideFramePlan). Uploads and fuses are queued before the frame's pass is
   * encoded, and the quads' uniforms land in one writeBuffer before submit.
   */
  render(slides: readonly NVSlide[], screen: NVSlideScreen): void {
    this._budget.sync(slides)
    this._fuser.retainLabelTables(slides)
    const placeholder = this._placeholderTexture
    if (!placeholder) return
    const dpr = screen.devicePixelRatio ?? 1
    const width = Math.max(1, Math.floor(screen.widthCss * dpr))
    const height = Math.max(1, Math.floor(screen.heightCss * dpr))
    if (this._canvas.width !== width) this._canvas.width = width
    if (this._canvas.height !== height) this._canvas.height = height
    const nearest = this.isNearestInterpolation
    const plan = this._plan
    plan.build(slides, screen)

    // Evict before beginFrame (see TileTextureCache).
    this._textures.evictToBudget(
      frameTextureBudget(plan.fuses, this._fuser.poolBytes, this._maxPoolBytes),
    )
    this._textures.beginFrame()
    if (!nearest) this._gutter.resync(this._device, this._textures)
    const textures = this._planTextures
    planTextures(
      this._textures,
      plan.uploadAt,
      plan.uploadCached,
      (i) =>
        this.textureFor(
          plan.uploadAt[i] as GutterAt,
          plan.uploads[i] as NVSlideVisibleTile,
          plan.uploadCached[i] as NVSlideCachedTile,
        ),
      textures,
    )
    // Submitted now, ahead of the frame; nearest needs no gutter (resync fills it).
    this._fuser.flush(this._device, this._gutter, this._textures, !nearest)

    // A background per slide plus at most every quad.
    this._ensureQuads(plan.slides.length + plan.quads.length)
    const data = this._uniformData
    const slot = this._uniformStride / 4
    const offsets = [0]
    let quads = 0
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
    const draw = (texture: GPUTexture, labels?: GPUTexture): void => {
      offsets[0] = quads * this._uniformStride
      pass.setBindGroup(0, this._uniformGroup, offsets)
      pass.setBindGroup(1, this._textureGroup(texture, labels))
      pass.draw(4)
      quads++
    }
    for (let s = 0; s < plan.slides.length; s++) {
      const slide = plan.slides[s] as NVSlide
      // The plain pipeline unless the slide has a colour table to apply.
      const lut = slide.displayColorLut
      if (lut) {
        pass.setPipeline(this._lutPipeline)
        pass.setBindGroup(2, this._luts.group(lut))
      } else pass.setPipeline(this._pipeline)
      const b = slide.screenRectForSlide(screen)
      let o = quads * slot
      if (writeRectNdc(b.x, b.y, b.width, b.height, width, height, data, o)) {
        data.set(UNIT_UV, o + 4)
        writeQuadParams(data, o, slide.opacity, true, false, false)
        data.set(slide.backgroundColor, o + 12)
        data[o + 20] = 0
        draw(placeholder)
      }
      const sum = slide.channelBlend === 'additive' ? 2 : 1
      for (
        let q = plan.slideStart[s] as number;
        q < (plan.slideEnd[s] as number);
        q++
      ) {
        const upload = plan.quadUpload[q] as number
        const texture = upload < 0 ? null : textures[upload]
        const isFallback = plan.quadFallback[q] as boolean
        // A deferred (or failed) upload draws nothing, so its fallback shows.
        if (!texture && (isFallback || upload >= 0)) continue
        const tile = plan.quads[q] as NVSlideVisibleTile
        o = quads * slot
        if (
          !writeRectNdc(
            tile.screenX,
            tile.screenY,
            tile.screenWidth,
            tile.screenHeight,
            width,
            height,
            data,
            o,
          )
        )
          continue
        writeTileUv(tile, data, o + 4)
        writeQuadParams(
          data,
          o,
          slide.opacity,
          !texture,
          !isFallback && slide.showTileGrid,
          // A fused tile of label channels samples nearest whatever the mode.
          nearest || texture?.nearest === true,
        )
        data.set(slide.placeholderColor, o + 12)
        data.set(slide.gridColor, o + 16)
        data[o + 20] = texture?.labels ? sum : 0
        if (texture) draw(texture.texture, texture.labels)
        else draw(placeholder)
      }
    }
    if (quads > 0 && this._uniformBuffer)
      this._device.queue.writeBuffer(
        this._uniformBuffer,
        0,
        data,
        0,
        quads * slot,
      )

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
    this._fuser.clear()
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
    this._budget.clear()
    this._msaaTexture?.destroy()
    this._msaaTexture = null
    this._textures.clear()
    this._fuser.destroy()
    this._gutter.destroy()
    this._luts.clear()
    this._lines.destroy()
    this._font.destroy()
    this._lineStorage?.destroy()
    this._glyphStorage?.destroy()
    this._uniformBuffer?.destroy()
    this._uniformBuffer = null
    if (this._placeholderTexture) {
      this._placeholderTexture.destroy()
      this._placeholderTexture = null
    }
    // create() requested this device, so free it: leaked devices pile up and
    // stall later GPU readbacks (mapAsync) on the page.
    this._device.destroy()
  }

  // Room for `quads` uniform slots; a new buffer means a new bind group.
  private _ensureQuads(quads: number): void {
    const have = this._uniformData.length / (this._uniformStride / 4)
    if (quads <= have && this._uniformBuffer) return
    const n = Math.max(quads, have * 2)
    // Destroyed after the submits that used it complete (WebGPU defers it).
    this._uniformBuffer?.destroy()
    this._uniformBuffer = this._device.createBuffer({
      size: n * this._uniformStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this._uniformData = new Float32Array((n * this._uniformStride) / 4)
    this._uniformGroup = this._device.createBindGroup({
      layout: this._uniformLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this._uniformBuffer, size: UNIFORM_BYTES },
        },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: this._nearestSampler },
      ],
    })
  }

  // `labels` is fixed for a texture's life (fuseTarget remakes the entry).
  private _textureGroup(
    texture: GPUTexture,
    labels?: GPUTexture,
  ): GPUBindGroup {
    let group = this._textureGroups.get(texture)
    if (!group) {
      const view = texture.createView()
      group = this._device.createBindGroup({
        layout: this._textureLayout,
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: labels ? labels.createView() : view },
        ],
      })
      this._textureGroups.set(texture, group)
    }
    return group
  }

  private textureFor(
    at: GutterAt,
    item: NVSlideVisibleTile,
    cached: NVSlideCachedTile,
  ): TileTextureGPU | null {
    if (isFuseTile(cached))
      return this._fuser.textureFor(
        this._device,
        this._gutter,
        this._textures,
        at,
        item.slide,
        cached,
      )
    return cached.bitmap ? this.textureForBitmap(at, cached.bitmap) : null
  }

  private textureForBitmap(
    at: GutterAt,
    bitmap: ImageBitmap,
  ): TileTextureGPU | null {
    // Keyed by the bitmap too: a refetched tile is a new bitmap (set() replaces).
    const existing = this._textures.get(at.key, bitmap)
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
          at,
          this._textures,
          // Nearest needs no gutter (the shader clamps); resync fills it.
          !this.isNearestInterpolation,
        ),
      bitmap.width * bitmap.height * 4,
    )
  }
}
