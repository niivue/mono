import { ByteLru } from '@/byteLru'
import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVShapes from '@/mesh/NVShapes'
import {
  invGamma,
  isPaqd,
  lodGammaExponent,
  lodOpacityScale,
  OVERLAY_ALPHA_BLEND,
  OVERLAY_COLOR_BLEND,
  SCENE_DEFAULTS,
  VOLUME_DEFAULTS,
  VOLUME_RENDER_MODE,
} from '@/NVConstants'
import type { NVImage } from '@/NVTypes'
import {
  ChunkStackFuse,
  chunkRegions,
  stackGeneration,
  stackInputs,
  stackModes,
  stackWeights,
} from '@/view/chunkStackFuse'
import { loadMatcapOrDefault } from '@/view/matcapFallback'
import {
  renderVariantConstants,
  renderVariantKey,
} from '@/view/NVRenderVariant'
import {
  isRgbaDatatype,
  preparePaqdOverlayData,
} from '@/view/NVRenderVolumeData'
import { isVolumeDrawn } from '@/view/NVVolumeVisibility'
import type { RgbaGrid } from '@/view/planeVisibility'
import { chunkExplodedMatRAS } from '@/volume/ChunkExplode'
import {
  ChunkResidencyManager,
  type RetiringChunk,
} from '@/volume/ChunkResidency'
import {
  ChunkStreamRenderer,
  DEFAULT_CHUNK_RESIDENCY_BYTES,
  MAX_CHUNK_UPLOADS_PER_FRAME,
  MAX_CHUNKS_PER_TILE,
  type StreamEntry,
} from '@/volume/ChunkStreamRenderer'
import { chunkDrawOrder } from '@/volume/ChunkVisibility'
import {
  bytesPerSourceVoxel,
  residentBytesForChunkDesc,
} from '@/volume/chunkBudget'
import {
  type ChunkPlan,
  chunkVolume,
  dimsDownsample,
  needsChunking,
  planSupportsCubic,
  type Vec3i,
  warnIfCubicUnsafe,
} from '@/volume/chunking'
import { chunkPlanMessage } from '@/volume/chunkPlanMessage'
import { ChunkTravelPredictor } from '@/volume/chunkPrediction'
import {
  type ChunkUniforms,
  chunkOffsetFor,
  chunkUniformsFor,
} from '@/volume/chunkRender'
import { decodedTierBudgetBytes } from '@/volume/decodedChunkCache'
import {
  buildModulationParams,
  type ModulationTextureParams,
  modulationFitsTextureLimit,
} from '@/volume/modulation'
import {
  chunkedDisplayKey,
  chunkModulationParams,
  chunkOverlayMatrix,
  coarseFloorKey,
  extractChunkBytes,
  volumeCacheKey,
  volumeSourceKey,
  wholeVolumeTextureKey,
} from '@/volume/orientChunked'
import { blendOverlaysGPU } from './blendOverlays'
import { MAX_TILES, UNIFORM_ALIGNMENT } from './mesh'
import * as orient from './orient'
import {
  type ChunkUploaderGPU,
  createChunkUploaderGPU,
  destroyVolumeChunksGPU,
  type VolumeChunkGPU,
} from './orientChunked'
import renderFragment from './render.wgsl?raw'
import { volumeShaderPreamble } from './volumeShaderLib'
import * as wgpu from './wgpu'

/**
 * Maximum simultaneously-drawn tiles a single chunked volume may occupy. The
 * per-chunk uniform regions are sized MAX_CHUNK_TILES * MAX_CHUNKS_PER_TILE
 * (rather than MAX_TILES * MAX_CHUNKS_PER_TILE) — a chunked volume realistically
 * appears in the multiplanar ortho slices + render tile, not a large mosaic, so
 * a smaller tile factor keeps the buffer the same size while quadrupling the
 * chunk cap. A chunked draw at a tileIndex >= MAX_CHUNK_TILES is skipped (the
 * volume still streams in the tiles below the cap), mirroring the existing
 * tileIndex >= MAX_TILES skip for non-chunked draws.
 */
const MAX_CHUNK_TILES = 32

/** Single-texture volume: fits within maxTextureDimension3D on all axes. */
interface SingleTexEntry {
  kind: 'single'
  volumeTexture: GPUTexture
  /**
   * Null when the volume was uploaded with no gradient consumer switched on --
   * the gradient pass is skipped entirely in that case. `_ensureSingleGradients`
   * fills it in on the first frame after one turns on.
   */
  volumeGradientTexture: GPUTexture | null
  /** Categorical volume: never smooth its baked label colors (see _cubicVolumeSafe). */
  isLabel: boolean
  /**
   * wholeVolumeTextureKey the texture was baked with: voxels, window, frame,
   * colormaps (with their addColormap revision), label LUT and modulation. A
   * mismatch rebuilds the entry.
   */
  textureKey: string
}

/** Chunked (tiled) volume: one or more axes exceed maxTextureDimension3D. */
type ChunkedTexEntry = StreamEntry<VolumeChunkGPU, ChunkUploaderGPU> & {
  /** Per-chunk cached bind group; null until built or after invalidation. */
  bindGroups: (GPUBindGroup | null)[]
}

type TexCacheEntry = SingleTexEntry | ChunkedTexEntry

// 512 bytes of data = 128 floats:
//   16 mvp + 16 norm + 16 matRAS + 4 volScale + 4 rayDir + 4 (gradient/numVol/cutaway/pad)
//   + 4 clipPlaneColor + 24 clipPlanes + 4 paqd + 8 scalars (earlyTermination,
//     clipPlaneOverlay, fadeAlpha, renderMode, cubicFilter, invGamma,
//     lodOpacityScale, backOpacity). The last four replaced a 2-lane _pad0
//     plus the 2 lanes WGSL was already inserting implicitly to 16-align
//     volumeTexDimsFull, so the group is 8 lanes before and after.
//   + 4 volumeTexDimsFull + 4 chunkSubOrigin + 4 chunkSubSize
//   + 4 dataOriginTexFrac + 4 dataSizeTexFrac + 4 rayStepTexVox
//   + 4 trailing f32 (layerGradMode, gradientOpacity, silhouettePower,
//     overlayOpacityCorrection)
// The constant below is the size the BIND GROUP declares, which must be the
// size WGSL gives the struct, not the byte count we write into it: a trailing
// f32 leaves the struct 16-byte-aligned at 512, and declaring 508 makes every
// render pipeline fail validation -- silently, as a blank canvas on every
// example. 512 is exactly the old alignedRenderSize, so the params buffer does
// not grow and every *_PARAMS_BASE offset below is unchanged.
const renderParamsSize = 512
const alignedRenderSize =
  Math.ceil(renderParamsSize / UNIFORM_ALIGNMENT) * UNIFORM_ALIGNMENT
// Byte offset of the base chunk-params region (after the per-tile non-chunked
// slots) and of the independent-overlay chunk-params region (after the base
// chunk region). The non-chunked region keeps one slot per MAX_TILES tile; each
// chunk bank holds MAX_CHUNK_TILES * MAX_CHUNKS_PER_TILE slots. See paramsBuffer
// allocation for the full layout.
const CHUNK_PARAMS_BASE = MAX_TILES * alignedRenderSize
const CHUNK_BANK_SLOTS = MAX_CHUNK_TILES * MAX_CHUNKS_PER_TILE
const OVERLAY_CHUNK_PARAMS_BASE =
  CHUNK_PARAMS_BASE + CHUNK_BANK_SLOTS * alignedRenderSize
// Coarse-floor cube params live in their own bank so a chunk that is mid
// cross-fade can draw both its floor cube (this bank) and its fine cube (the
// base bank) in one frame without their dynamic-offset uniforms colliding.
const FLOOR_CHUNK_PARAMS_BASE =
  CHUNK_PARAMS_BASE + 2 * CHUNK_BANK_SLOTS * alignedRenderSize
// Chunk plans already explained in the log (see chunkPlanMessage): the same
// plan is re-bound on every update.
const loggedChunkPlans = new WeakSet<ChunkPlan>()

export class VolumeRenderer extends ChunkStreamRenderer<
  GPUDevice,
  GPUTexture,
  VolumeChunkGPU,
  ChunkUploaderGPU,
  ChunkedTexEntry,
  SingleTexEntry
> {
  // WebGPU clip space has z in [0, w]; chunksInFrustum culls against that
  // near plane.
  protected readonly clipSpaceZeroToOne = true
  pipeline: GPURenderPipeline | null
  /**
   * Chunked-volume variant of `pipeline` — identical except `depthCompare`
   * is `'always'`. A chunked volume issues N cube draws into one pass; with
   * `'less'` the chunks depth-test against each other and a chunk whose
   * first-hit lands behind an already-drawn chunk is rejected, dropping its
   * OVER contribution. Transparent layers composited back-to-front must not
   * depth-test against each other. Safe because meshes draw after the volume.
   */
  pipelineChunked: GPURenderPipeline | null
  /**
   * MIP variant of `pipelineChunked` — identical except the framebuffer blend
   * is a component-wise `max`. Each chunked MIP cube draw emits its ray
   * segment's premultiplied maximum (the shader's per-layer MIP rule is also
   * `max`, see depthAwareMix), so maxing across the chunk draws reconstructs
   * the full-ray MIP regardless of chunk order — OVER blending would let a
   * high-alpha near chunk occlude a brighter voxel in a farther chunk.
   * Limitation: the max also applies against the pre-existing framebuffer, so
   * a chunked MIP assumes the tile behind the cube is black (the classic
   * MAX-blend MIP convention); non-chunked MIP still composites OVER.
   */
  pipelineChunkedMip: GPURenderPipeline | null
  bindLayout: GPUBindGroupLayout | null
  bindGroup: GPUBindGroup | null
  matcapTexture: GPUTexture | null
  volumeTexture: GPUTexture | null
  volumeGradientTexture: GPUTexture | null
  overlayTexture: GPUTexture | null
  // Per-chunk overlay textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the overlay layer is chunked; the
  // single-texture overlayTexture stays null in that case (and vice versa).
  overlayChunks: GPUTexture[] | null
  paqdTexture: GPUTexture | null
  // Per-chunk raw PAQD textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the PAQD layer is chunked; the
  // single-texture paqdTexture stays null in that case (and vice versa).
  paqdChunks: GPUTexture[] | null
  paqdLutTexture: GPUTexture | null
  // The resliced PAQD voxels the paqd texture(s) were uploaded from, kept for
  // the chunked volume's CPU plane pick (view/planeVisibility.ts), which has no
  // single texture to sample. Null when no PAQD layer is bound.
  paqdPickGrid: RgbaGrid | null
  drawingTexture: GPUTexture | null
  // Per-chunk drawing textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the drawing layer is chunked; the
  // single-texture drawingTexture stays null in that case (and vice versa).
  drawingChunks: GPUTexture[] | null
  placeholderOverlay: GPUTexture | null
  placeholderLut2D: GPUTexture | null
  sampler: GPUSampler | null
  samplerNearest: GPUSampler | null
  paramsBuffer: GPUBuffer | null
  vertexBuffer: GPUBuffer | null
  indexBuffer: GPUBuffer | null
  cube: { vertices: number[]; indices: number[] }
  maxTextureDimension3D: number
  depthFormat: GPUTextureFormat
  private _device: GPUDevice | null
  // Scene flag (set per-frame from md.scene): clip the overlay/PAQD/drawing passes
  // with the base volume instead of letting them ignore the clip plane.
  clipPlaneOverlay = false
  // Volume flag (set per-frame from md.volume.renderMode): 0 = composite (OVER),
  // 1 = maximum-intensity projection, 2 = orthogonal slices. See
  // VOLUME_RENDER_MODE.
  renderMode = 0
  // The three crosshair planes in the base volume's texture fraction (set
  // per-frame from model.getSliceTexFrac), read only in SLICES mode. 1 is
  // off-cube, so the default hits nothing.
  sliceFrac: number[] = [1, 1, 1]
  // Volume flag (set per-frame from md.volume.isAlphaClipDark): drop a voxel the
  // colormap made fully transparent instead of painting it. Read only in SLICES
  // mode, where it is what makes a plane a cutout rather than a solid slab; the
  // ray-march samples that alpha directly and needs no flag.
  isAlphaClipDark = false
  // Multi-overlay blend modes (set from md.volume before updateOverlays).
  // See OVERLAY_ALPHA_BLEND / OVERLAY_COLOR_BLEND.
  overlayAlphaBlend = OVERLAY_ALPHA_BLEND.MAX
  overlayColorBlend = OVERLAY_COLOR_BLEND.ADDITIVE
  // Stacked channels (isChannelStack) keep their colormap's alpha ramp in the
  // overlay bake; other overlays are made fully opaque above their threshold.
  overlayKeepsColormapAlpha = false
  // Which stencil the overlay/drawing passes estimate their own gradient with
  // (from md.volume.layerGradientMode). The background volume reads a
  // precomputed gradient texture and is unaffected. See LAYER_GRADIENT_MODE.
  layerGradientMode = VOLUME_DEFAULTS.layerGradientMode
  // Step-size opacity correction for the overlay pass.
  isOverlayOpacityCorrected = VOLUME_DEFAULTS.isOverlayOpacityCorrected
  // Background-volume gradient opacity and silhouette (Fresnel rim), set by the
  // view each frame from md.volume. Both read the precomputed gradient
  // texture's magnitude/direction, so a non-zero value also means the gradient
  // pass must run even when the volume is unlit (see _needsGradient).
  gradientOpacity = VOLUME_DEFAULTS.gradientOpacity
  silhouette = VOLUME_DEFAULTS.silhouette
  // Scene display gamma (set per-frame from md.scene.gamma). Applied to the
  // classified RGB of every volume sample, never to alpha, so brightening does
  // not change how much a ray occludes. 1.0 is a strict no-op.
  gamma = SCENE_DEFAULTS.gamma
  // Coefficient for the per-level coarse-brick brightness compensation (from
  // md.volume.lodBrightnessCompensation). 0 disables it. Multiplies into the
  // same shader exponent as `gamma`, per chunk.
  lodBrightnessCompensation = VOLUME_DEFAULTS.lodBrightnessCompensation
  // Coefficient for the per-level coarse-brick OPACITY compensation (from
  // md.volume.lodOpacityCompensation). 0 disables it, which is the default:
  // it measures worse than the brightness compensation on dense structure.
  // Scales the step-size opacity exponent, per chunk.
  lodOpacityCompensation = VOLUME_DEFAULTS.lodOpacityCompensation
  // Samples per voxel along the ray in the 3D fine march (from md.volume.sampleRate).
  // Converges the ray integral at a proportional fragment cost. It does NOT remove
  // concentric banding on smooth structures (measured ring contrast is flat from 1
  // to 4) -- that banding is in the integrand, not in how densely it is sampled.
  sampleRate = VOLUME_DEFAULTS.sampleRate
  private _matcapUrl: string | null = null
  /** The instance's default matcap, drawn when the requested one fails to load. */
  private readonly _defaultMatcap: string
  private _bindTexVol: GPUTexture | null = null
  private _bindTexGrad: GPUTexture | null = null
  private _bindTexMatcap: GPUTexture | null = null
  // Specialized single-volume pipelines by variant key (view/NVRenderVariant),
  // null while compiling; the generic `pipeline` draws until one is ready.
  private _variantPipelines = new Map<number, GPURenderPipeline | null>()
  private _pipelineDesc:
    | ((constants: Record<string, number>) => GPURenderPipelineDescriptor)
    | null = null
  private _bindTexOverlay: GPUTexture | null = null
  private _bindTexPaqd: GPUTexture | null = null
  private _bindTexDraw: GPUTexture | null = null
  private _bindTexLut: GPUTexture | null = null
  private overlayOrientCache: orient.OrientTextureCache | null = null
  // Current volume gradient/illumination amount, set by the view each frame
  // BEFORE chunk work (request/pump). Chunk uploaders read this to skip the
  // gradient compute pass when the volume is unlit (== 0). Mirrors the GL backend.
  gradientAmount = 0
  // Per-volume cached bind groups so multi-volume tile loops can swap
  // textures without rebuilding the bind group every frame. Keyed by the
  // same cacheKey as _texCache. Invalidated whenever any non-volume
  // texture (overlay/paqd/draw/matcap/lut) changes. Single-texture entries
  // only — chunked entries cache per-chunk bind groups on the entry itself.
  private _bindGroupCache: Map<string, GPUBindGroup> = new Map()
  private _activeVolKey: string | null = null
  // False when the active volume is categorical (colormapLabel): the ray march
  // samples an RGBA texture whose colors are already baked, so a smooth
  // reconstruction would blend two unrelated labels into a third label's colour.
  // Cubic is forced off for such a volume regardless of the global setting.
  private _cubicVolumeSafe = true
  // Coarse whole-volume "floor" texture for the active base. On 2D slices it is
  // drawn as one full-coverage quad behind the resident fine chunks, so a deep-
  // zoom slice never blanks while finer chunks stream — coarse detail shows
  // immediately and sharpens as chunks arrive. Oriented once from a coarse
  // pyramid level the app supplies (niivue stays LOD-agnostic). Null when unset.
  coarseFloorTexture: GPUTexture | null = null
  /** Voxel dims of `coarseFloorTexture` (drives the floor cubes' step count). */
  coarseFloorDims: [number, number, number] | null = null
  // Gradient for the coarse floor, used by the 3D ray-march floor cubes for
  // matcap lighting consistent with the resident fine chunks. Null when unset.
  coarseFloorGradientTexture: GPUTexture | null = null
  // Cached bind group for the 3D floor cubes (coarse texture + gradient +
  // placeholders). Reused for every missing chunk; reset when the floor or
  // matcap changes. Per-cube geometry differs only via the uniform offset.
  private _floorBindGroup: GPUBindGroup | null = null
  // Bind groups for retiring bricks, keyed by brick so they die with it;
  // replaced with the other caches when a shared binding (the matcap) changes.
  private _retiringBindGroups = new WeakMap<VolumeChunkGPU, GPUBindGroup>()
  private _coarseFloorKey: string | null = null
  private _bindGroupSharedKey: {
    matcap: GPUTexture | null
    overlay: GPUTexture | null
    paqd: GPUTexture | null
    draw: GPUTexture | null
    lut: GPUTexture | null
  } = { matcap: null, overlay: null, paqd: null, draw: null, lut: null }
  private volumeOrientCache: orient.OrientTextureCache | null = null
  // RGB/RGBA volumes skip the orient pass, so their textures are kept here
  // instead, and new voxels are written into them in place.
  private overlayRgbaCache: orient.RGBATextureCache | null = null
  private volumeRgbaCache: orient.RGBATextureCache | null = null

  constructor(defaultMatcap = '') {
    super()
    this._defaultMatcap = defaultMatcap
    this.pipeline = null
    this.pipelineChunked = null
    this.pipelineChunkedMip = null
    this.bindLayout = null
    this.bindGroup = null
    this.matcapTexture = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.overlayTexture = null
    this.overlayChunks = null
    this.paqdTexture = null
    this.paqdChunks = null
    this.paqdLutTexture = null
    this.paqdPickGrid = null
    this.drawingTexture = null
    this.drawingChunks = null
    this.placeholderOverlay = null
    this.placeholderLut2D = null
    this.sampler = null
    this.samplerNearest = null
    this.paramsBuffer = null
    this.vertexBuffer = null
    this.indexBuffer = null
    this.cube = NVShapes.getCubeMesh()
    this.maxTextureDimension3D = 0
    this.depthFormat = 'depth24plus'
    this._device = null
  }

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
    maxTextureDimension3D: number,
    chunkResidencyBytes: number = DEFAULT_CHUNK_RESIDENCY_BYTES,
    depthFormat: GPUTextureFormat = 'depth24plus',
  ): Promise<void> {
    this._device = device
    this.depthFormat = depthFormat
    if (this.isReady) return

    this.maxTextureDimension3D = maxTextureDimension3D
    this._chunkResidencyBytes = chunkResidencyBytes

    // Create samplers
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
    this.samplerNearest = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    })

    // Create vertex buffer for cube
    this.vertexBuffer = device.createBuffer({
      size: this.cube.vertices.length * 4,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    })
    new Float32Array(this.vertexBuffer.getMappedRange()).set(this.cube.vertices)
    this.vertexBuffer.unmap()

    // Create index buffer for cube
    this.indexBuffer = device.createBuffer({
      size: this.cube.indices.length * 2,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    })
    new Uint16Array(this.indexBuffer.getMappedRange()).set(this.cube.indices)
    this.indexBuffer.unmap()

    // Create uniform buffer. Layout (each region alignedRenderSize per slot):
    //   [0, MAX_TILES)                          — one non-chunked draw per tile
    //   base chunk region: CHUNK_BANK_SLOTS slots (base cubes)
    //   overlay chunk region: CHUNK_BANK_SLOTS slots (independent hi-res overlay
    //     cubes — its own region so overlay cube uniforms never collide with
    //     base cube uniforms within a frame).
    //   floor chunk region: CHUNK_BANK_SLOTS slots (coarse-floor cubes — its own
    //     region so a mid-fade chunk can draw its floor cube and its fine cube in
    //     the same frame without uniform collision).
    // where CHUNK_BANK_SLOTS = MAX_CHUNK_TILES * MAX_CHUNKS_PER_TILE.
    // base tile i, chunk j  uses CHUNK_PARAMS_BASE   + (i*MAX_CHUNKS_PER_TILE+j)
    // overlay tile i, chunk j uses OVERLAY_CHUNK_PARAMS_BASE + (i*MAX_...+j)
    // floor tile i, chunk j uses FLOOR_CHUNK_PARAMS_BASE + (i*MAX_...+j)
    this.paramsBuffer = device.createBuffer({
      size: alignedRenderSize * (MAX_TILES + 3 * CHUNK_BANK_SLOTS),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Create placeholder 2x2x2 RGBA overlay texture (all zeros - transparent black)
    this.placeholderOverlay = device.createTexture({
      size: [2, 2, 2],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: '3d',
    })

    // Create placeholder 1x1 2D texture for PAQD LUT (transparent)
    this.placeholderLut2D = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })

    this.matcapTexture = null

    // Create bind group layout
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: renderParamsSize,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 7,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 8,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'non-filtering' },
        },
        {
          binding: 9,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '2d' },
        },
      ],
    })

    // Create render pipeline
    const shaderModule = device.createShaderModule({
      code: volumeShaderPreamble + renderFragment,
    })
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindLayout],
    })
    this._pipelineDesc = (constants) => ({
      layout,
      multisample: { count: msaaCount },
      vertex: {
        module: shaderModule,
        entryPoint: 'vertex_main',
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragment_main',
        constants,
        targets: [
          {
            format: format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: this.depthFormat,
      },
      primitive: {
        topology: 'triangle-strip',
        stripIndexFormat: 'uint16',
        cullMode: 'back',
      },
    })
    this._variantPipelines = new Map()
    // Shader defaults are the generic variant.
    this.pipeline = device.createRenderPipeline(this._pipelineDesc({}))

    const chunkedBindLayout = this.bindLayout
    const chunkedPipeline = (blend: GPUBlendState): GPURenderPipeline =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [chunkedBindLayout],
        }),
        multisample: { count: msaaCount },
        vertex: {
          module: shaderModule,
          entryPoint: 'vertex_main',
          buffers: [
            {
              arrayStride: 12,
              attributes: [
                { format: 'float32x3', offset: 0, shaderLocation: 0 },
              ],
            },
          ],
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fragment_main',
          targets: [{ format: format, blend }],
        },
        // depthCompare 'always' (vs 'less' above): the per-chunk cube draws
        // composite back-to-front with OVER blending and must not depth-test
        // against each other, or a chunk behind an already-drawn chunk is
        // rejected and its contribution is lost.
        depthStencil: {
          depthWriteEnabled: true,
          depthCompare: 'always',
          format: this.depthFormat,
        },
        primitive: {
          topology: 'triangle-strip',
          stripIndexFormat: 'uint16',
          cullMode: 'back',
        },
      })
    this.pipelineChunked = chunkedPipeline({
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    })
    // MIP chunk draws merge by component-wise max (see the pipelineChunkedMip
    // field doc). WebGPU requires 'one' blend factors with the max operation.
    this.pipelineChunkedMip = chunkedPipeline({
      color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
      alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
    })

    this.isReady = true
  }

  async updateVolume(
    device: GPUDevice,
    vol: NVImage,
    matcap: string = '',
    allVolumes: NVImage[] = [vol],
    perVolumeCache = false,
  ): Promise<void> {
    if (!this.isReady) return

    // Check both source and target (RAS) dims against the device limit.
    // Source dims drive scalar texture upload; RAS dims drive the RGBA
    // output texture. Either can exceed the cap on real-world OME-Zarr
    // L0 levels or microscopy / WSI data.
    const srcDims: Vec3i = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
    const rasDims: Vec3i = vol.dimsRAS
      ? [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
      : srcDims
    const limit = this.maxTextureDimension3D
    const forcedPlan = vol.chunkPlan
    const oversized =
      needsChunking(srcDims, limit) || needsChunking(rasDims, limit)

    const cacheKey = volumeCacheKey(vol)

    if (forcedPlan || oversized) {
      // Same modulation the whole-volume path below resolves; the uploader
      // bakes it into every brick.
      const chunkedEntry = await this._ensureChunkedVolumeEntry(
        device,
        vol,
        this._chunkResidencyBytes,
        buildModulationParams(vol, vol, allVolumes),
      )
      this._activeChunked = chunkedEntry
      this._cubicVolumeSafe = !vol.colormapLabel
      this._activeVolKey = cacheKey || null
      // No whole-volume bind group: the depth pick must not bind the one a
      // previous single-texture volume left here.
      this.bindGroup = null
      this.volumeTexture =
        chunkedEntry.manager.getChunk(0)?.volumeTexture ?? null
      this.volumeGradientTexture =
        chunkedEntry.manager.getChunk(0)?.volumeGradientTexture ?? null
      await this._ensureMatcap(device, matcap)
      return
    }

    const mtx = NVTransforms.calculateOverlayTransformMatrix(vol, vol)
    const modParams = buildModulationParams(vol, vol, allVolumes)
    // Leaving a cached volume: the aliases name textures a `_texCache` entry
    // still owns (chunk 0's, or a per-volume single's), and the single-volume
    // path below destroys whatever they hold. Drop them first, as gl/render.ts
    // does for chunked.
    if (this._activeChunked || this._activeVolKey) {
      this.volumeTexture = null
      this.volumeGradientTexture = null
    }
    this._activeChunked = null
    this._cubicVolumeSafe = !vol.colormapLabel

    // This volume is not chunked any more: its plan was cleared, or the same
    // url was reloaded as a plain volume. Drop the chunked entry now, because
    // nothing downstream will. It would otherwise sit in `_texCache` for the
    // life of the renderer holding every brick texture, still driven by
    // `beginChunkFrame`, and still counted by `chunkStreamStats` -- which then
    // reports a brick stream for a single-texture volume. The `perVolumeCache`
    // branch below cleared it, but only multi-instance callers take that
    // branch, so the ordinary path leaked.
    const priorEntry = cacheKey ? this._texCache.get(cacheKey) : undefined
    if (priorEntry?.kind === 'chunked') {
      this._evictTexEntry(cacheKey, priorEntry)
    }

    if (perVolumeCache) {
      // Multi-instance / global3d: cache each volume's texture by key so the
      // render loop can switch the active texture per tile via
      // bindCachedVolume. (volumeOrientCache is a single slot and cannot serve
      // per-tile volume switching.)
      // The chunked case was evicted above, so anything still here is single.
      // Narrowing on `kind` rather than asserting keeps that an invariant the
      // compiler checks.
      const prior = cacheKey ? this._texCache.get(cacheKey) : undefined
      let entry = prior?.kind === 'single' ? prior : undefined
      // Anything the texture bakes in changed (voxels, window, frame,
      // colormap, label LUT, modulation): rebuild the entry.
      // Computed before the awaits below: an edit landing during them must
      // leave this entry stale (rebuilt next time), not marked current.
      const textureKey = wholeVolumeTextureKey(vol, mtx, modParams)
      if (entry && entry.textureKey !== textureKey) {
        this._evictTexEntry(cacheKey, entry)
        entry = undefined
      }
      if (!entry) {
        const volumeTexture = await orient.volume2Texture(
          device,
          vol,
          vol,
          mtx as Float32Array,
          0,
          undefined,
          modParams,
        )
        // Skipped outright when nothing reads it. The pass is a full-volume
        // compute dispatch and the texture it produces is the size of the
        // volume, so an unlit scene pays neither.
        const volumeGradientTexture = this._needsGradient()
          ? await wgpu.volume2TextureGradientRGBA(device, volumeTexture)
          : null
        entry = {
          kind: 'single',
          volumeTexture,
          volumeGradientTexture,
          isLabel: !!vol.colormapLabel,
          textureKey,
        }
        if (cacheKey) this._texCache.set(cacheKey, entry)
      }
      this.volumeTexture = entry.volumeTexture
      this.volumeGradientTexture = entry.volumeGradientTexture
      this._activeVolKey = cacheKey || null
    } else {
      // Normal single-volume path: orient-texture cache + modulation. Scalar
      // volumes go through the orient-texture cache so cal_min/max/colormap
      // tweaks only re-run the cheap orient compute pass.
      if (this.volumeGradientTexture) this.volumeGradientTexture.destroy()
      this.destroyNonCachedVolumeTexture()
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        // RGB/RGBA volumes bypass the orient pass: their voxels go straight
        // into a kept texture, and only when they changed.
        orient.destroyOrientTextureCache(this.volumeOrientCache)
        this.volumeOrientCache = null
        this.volumeRgbaCache = orient.prepareRGBATextureCache(
          device,
          vol,
          this.volumeRgbaCache,
        )
        this.volumeTexture = this.volumeRgbaCache.texture
      } else {
        orient.destroyRGBATextureCache(this.volumeRgbaCache)
        this.volumeRgbaCache = null
        this.volumeOrientCache = await orient.prepareOrientTextureCache(
          device,
          vol,
          vol,
          mtx as Float32Array,
          0,
          this.volumeOrientCache,
          modParams,
        )
        orient.dispatchOrient(device, this.volumeOrientCache)
        this.volumeTexture = this.volumeOrientCache.outputTexture
      }
      // See the cached branch: skipped when nothing reads it, and filled in
      // later by _ensureSingleGradients without a reupload.
      this.volumeGradientTexture = this._needsGradient()
        ? await wgpu.volume2TextureGradientRGBA(device, this.volumeTexture)
        : null
      this._activeVolKey = null
    }

    await this._ensureMatcap(device, matcap)
  }

  /**
   * Build (or reuse from the texture cache) the chunked GPU entry for an
   * oversized / forced-plan volume: compute the ChunkPlan against RAS dims,
   * log the budget, enforce MAX_CHUNKS_PER_TILE, create the uploader +
   * residency manager, and admit chunk 0 synchronously so the volume is
   * immediately present. The remaining chunks stream on demand once the view
   * computes a visibility-driven working set.
   *
   * Used for the base volume AND for an independently-streamed hi-res chunked
   * overlay — each gets its own cache entry + residency manager, keyed by its
   * own url/name, and the per-frame pump (pumpChunkUploads) drives them all.
   *
   * Halo is 3 (not the [1,1,1] default): each of the two gradient passes taps
   * +-0.7 voxel through a LINEAR sampler, so the Sobel reaches two voxels past
   * the chunk, and trilinear sampling at the data edge reaches one further --
   * 3 is the exact requirement, not a margin.
   */
  protected async _ensureChunkedVolumeEntry(
    device: GPUDevice,
    vol: NVImage,
    budgetBytes: number,
    modulation: ModulationTextureParams | null,
    onResidencyChange?: (chunkIndex: number) => void,
    basePlan?: ChunkPlan,
  ): Promise<ChunkedTexEntry> {
    const srcDims: Vec3i = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
    const rasDims: Vec3i = vol.dimsRAS
      ? [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
      : srcDims
    const limit = this.maxTextureDimension3D
    // A combined mirror streams on its base's grid (basePlan) without taking
    // it as its own: the overlay may later become the base or stream alone.
    let plan =
      basePlan ?? vol.chunkPlan ?? chunkVolume(rasDims, limit, [3, 3, 3])
    if (!basePlan) vol.chunkPlan = plan
    const bpv = bytesPerSourceVoxel(vol.hdr.datatypeCode) || 4
    if (!loggedChunkPlans.has(plan)) {
      loggedChunkPlans.add(plan)
      const message = chunkPlanMessage({
        name: vol.name,
        datatypeCode: vol.hdr.datatypeCode,
        rasDims,
        limit,
        limitName: 'maxTextureDimension3D',
        plan,
      })
      log[message.level](message.text)
    }
    if (plan.chunks.length > MAX_CHUNKS_PER_TILE) {
      throw new Error(
        `Volume ${vol.name} tiles into ${plan.chunks.length} chunks, ` +
          `exceeding the per-tile limit of ${MAX_CHUNKS_PER_TILE}. ` +
          `Use a coarser pyramid level or crop the volume.`,
      )
    }
    const cacheKey = volumeCacheKey(vol)
    const displayKey = chunkedDisplayKey(vol, modulation)
    const sourceKey = volumeSourceKey(vol)
    let existing = cacheKey ? this._texCache.get(cacheKey) : undefined
    // A swap to this very plan is in flight; let it land, then reuse it. A
    // later swap can supersede it before it runs: follow that one too, since
    // its plan is the one the volume streams on now.
    let waited = false
    while (
      existing?.kind === 'chunked' &&
      existing.plan !== plan &&
      existing.pendingSwap &&
      (waited || existing.pendingSwap.plan === plan)
    ) {
      plan = existing.pendingSwap.plan
      await existing.pendingSwap.done.catch(() => undefined)
      waited = true
      existing = cacheKey ? this._texCache.get(cacheKey) : undefined
    }
    // A cached entry built for a different plan object (the caller set a new
    // `vol.chunkPlan`, as setVolumeChunkGrid does) cannot be reused: its
    // uploader, manager and brick textures are laid out for the old grid.
    // Fall through to the eviction below and rebuild. In-place swaps via
    // swapChunkedVolumePlan keep `existing.plan` in step, so they still hit.
    if (
      existing &&
      existing.kind === 'chunked' &&
      existing.plan === plan &&
      existing.sourceKey === sourceKey
    ) {
      existing.volume = vol
      if (existing.displayKey !== displayKey) {
        // Colormap/window/frame changed after load. Resident chunk textures
        // bake the old state (the uploader's LUT + orient uniforms are fixed at
        // creation), so rebuild the uploader and re-stream: evict everything,
        // then admit chunk 0 with the new state so the volume stays present
        // while the working set refills — the same drop-and-refill mechanism as
        // _refreshUnlitChunksForLighting.
        existing.displayKey = displayKey
        existing.modulation = modulation
        // The decoded tier is deliberately kept: it holds SOURCE bytes, and a
        // colormap or window change re-orients the same source. The re-stream
        // below therefore costs uploads, not fetches.
        const newUploader = await createChunkUploaderGPU(
          device,
          vol,
          existing.plan,
          () => this._needsGradient(),
          existing.decoded,
          modulation,
        )
        existing.uploader.dispose()
        existing.uploader = newUploader
        existing.speculative.clear()
        existing.manager.remap(new Map(), existing.plan.chunks.length)
        existing.bindGroups = existing.plan.chunks.map(() => null)
        const chunk0 = await existing.uploader.uploadChunk(0)
        if (!chunk0.hasGradient) this._uploadedUnlit = true
        existing.manager.admit(0, chunk0)
      }
      return existing
    }
    if (existing) this._evictTexEntry(cacheKey, existing)
    const decoded = new ByteLru<number, Uint8Array>(
      decodedTierBudgetBytes(budgetBytes, bpv),
    )
    const uploader = await createChunkUploaderGPU(
      device,
      vol,
      plan,
      () => this._needsGradient(),
      decoded,
      modulation,
    )
    // The entry holds the live uploader + per-chunk bind groups so an in-place
    // plan swap (swapChunkedVolumePlan) can replace them; the manager hooks read
    // them off `entry` (not a creation-time closure) so they always act on the
    // current plan. onEvict nulls the slot of an evicted chunk — a re-admitted
    // chunk gets a fresh texture, so its old bind group would dangle.
    const entry: ChunkedTexEntry = {
      kind: 'chunked',
      volume: vol,
      manager: undefined as unknown as ChunkResidencyManager<VolumeChunkGPU>,
      uploader,
      plan,
      bindGroups: plan.chunks.map(() => null),
      displayKey,
      sourceKey,
      modulation,
      cubicSafe: planSupportsCubic(plan),
      predictor: new ChunkTravelPredictor(),
      requestedThisFrame: [],
      speculative: new Set(),
      predictedCount: 0,
      decoded,
      sourceBytesPerVoxel: bpv,
    }
    warnIfCubicUnsafe(vol.name, entry.cubicSafe, this.isCubicInterpolation)
    entry.manager = new ChunkResidencyManager<VolumeChunkGPU>(
      plan.chunks.length,
      budgetBytes,
      {
        bytesOf: (c) => residentBytesForChunkDesc(c.desc, c.hasGradient),
        destroy: (c) => destroyVolumeChunksGPU([c]),
        onEvict: (ci) => {
          entry.bindGroups[ci] = null
          onResidencyChange?.(ci)
        },
        prefetch: (ci) => entry.uploader.prefetchChunk(ci),
        cancel: (ci) => entry.uploader.cancelChunk(ci),
        onAdmit: onResidencyChange,
      },
    )
    const chunk0 = await entry.uploader.uploadChunk(0)
    if (!chunk0.hasGradient) this._uploadedUnlit = true
    entry.manager.admit(0, chunk0)
    if (cacheKey) this._texCache.set(cacheKey, entry)
    return entry
  }

  /** Queue a plan swap on `entry` behind any swap already queued on it. */
  /** A chunk uploader for `plan`, baking the volume's current display state. */
  protected _newChunkUploader(
    device: GPUDevice,
    vol: NVImage,
    plan: ChunkPlan,
    decoded: ByteLru<number, Uint8Array>,
    modulation: ModulationTextureParams | null,
  ): Promise<ChunkUploaderGPU> {
    return createChunkUploaderGPU(
      device,
      vol,
      plan,
      () => this._needsGradient(),
      decoded,
      modulation,
    )
  }

  /** Drop every per-chunk bind group: they name the old chunk textures. */
  protected _resetChunkBindings(entry: ChunkedTexEntry): void {
    entry.bindGroups = entry.plan.chunks.map(() => null)
  }

  /** A mirror chunk arrived or left: rebuild the base chunk's bind group. */
  protected _invalidateBaseChunkBinding(chunkIndex: number): void {
    const base = this._activeChunked
    if (base) base.bindGroups[chunkIndex] = null
  }

  /**
   * WebGPU builds chunk bind groups at draw time, from live residency. Only the
   * chunk-0 aliases need re-pointing: remap may have released the old chunk 0.
   */
  protected _onPlanSwapped(entry: ChunkedTexEntry): void {
    if (this._activeChunked !== entry) return
    const chunk0 = entry.manager.getChunk(0)
    this.volumeTexture = chunk0?.volumeTexture ?? null
    this.volumeGradientTexture = chunk0?.volumeGradientTexture ?? null
  }

  /**
   * Reload the matcap texture when the URL changes so that opts.matcap
   * updates take effect — otherwise the first loaded matcap sticks for the
   * lifetime of the renderer. Matcap is independent of the per-volume cache.
   */
  private async _ensureMatcap(
    device: GPUDevice,
    matcap: string,
  ): Promise<void> {
    if (this.matcapTexture == null || this._matcapUrl !== matcap) {
      const newTex = await loadMatcapOrDefault(
        matcap,
        this._defaultMatcap,
        (url) => wgpu.bitmap2textureOrFallback(device, url),
      )
      if (this.matcapTexture) this.matcapTexture.destroy()
      this.matcapTexture = newTex
      // The requested URL, even after a fallback, so a matcap that failed is
      // not fetched again on every update.
      this._matcapUrl = matcap
      this._invalidateBindGroupCache()
    }
  }

  /**
   * Switch the active volume/gradient textures to the cache entry for
   * `cacheKey` (from volumeCacheKey). Used per-tile by global3d rendering
   * to draw distinct volumes without re-uploading their data each frame.
   * Returns true if the cache hit.
   */
  bindCachedVolume(cacheKey: string | undefined): boolean {
    if (!cacheKey) return false
    const entry = this._texCache.get(cacheKey)
    if (!entry) return false
    this._activeVolKey = cacheKey
    if (entry.kind === 'chunked') {
      // Chunked draws build per-chunk bind groups in draw(); these legacy
      // single-texture pointers are best-effort aliases for callers that
      // inspect them, not the chunked volume's readiness signal.
      this._activeChunked = entry
      this._cubicVolumeSafe = !entry.volume.colormapLabel
      // As in updateVolume: the depth pick must not bind the previous single
      // volume's group.
      this.bindGroup = null
      this.volumeTexture = entry.manager.getChunk(0)?.volumeTexture ?? null
      this.volumeGradientTexture =
        entry.manager.getChunk(0)?.volumeGradientTexture ?? null
      return true
    }
    this._activeChunked = null
    this._cubicVolumeSafe = !entry.isLabel
    this.volumeTexture = entry.volumeTexture
    this.volumeGradientTexture = entry.volumeGradientTexture
    const cached = this._bindGroupCache.get(cacheKey)
    if (cached) {
      this.bindGroup = cached
      this._bindTexVol = entry.volumeTexture
      // Mirrors what updateBindGroup bound: the placeholder while the entry is
      // unlit, so the cache-hit test there stays honest.
      this._bindTexGrad = entry.volumeGradientTexture || this.placeholderOverlay
    }
    return true
  }

  /** 2D-slice working set for the independently-streamed hi-res overlay. */
  /**
   * Build any non-chunked gradient texture that the upload path deferred.
   *
   * The single-texture analogue of `_refreshUnlitChunksForLighting`: an unlit
   * volume skips the gradient pass at upload, so switching illumination,
   * gradient opacity or silhouette on has to fill it in. Called once per frame
   * before the tile loop; a no-op pointer test once the texture exists, and
   * the texture outlives the toggle so flipping the feature off and on again
   * does not rebuild it.
   *
   * Uses the await-free build: `beginChunkFrame` is synchronous, and the queue
   * already orders the compute write before this frame's sampling read.
   */
  protected _ensureSingleGradients(): void {
    const device = this._device
    if (!device || !this._needsGradient()) return
    for (const [key, entry] of this._texCache) {
      if (entry.kind !== 'single' || entry.volumeGradientTexture) continue
      entry.volumeGradientTexture = wgpu.volume2TextureGradientRGBASync(
        device,
        entry.volumeTexture,
      )
      // The cached bind group for this key holds the placeholder at binding 4.
      this._bindGroupCache.delete(key)
      // updateVolume / bindCachedVolume copied the then-null pointer into the
      // live slot, so re-point it at the texture just built.
      if (entry.volumeTexture === this.volumeTexture) {
        this.volumeGradientTexture = entry.volumeGradientTexture
      }
    }
    if (
      !this._activeChunked &&
      this.volumeTexture &&
      !this.volumeGradientTexture
    ) {
      this.volumeGradientTexture = wgpu.volume2TextureGradientRGBASync(
        device,
        this.volumeTexture,
      )
    }
  }

  /** The stack's channel entries, base first. */
  /** The stack's source generation (see ChunkStackFuse). */
  /**
   * Re-fuse stack chunks whose bricks or blend modes changed until `deadline`
   * (at least one per pump), with the overlay blend the whole-volume stack
   * uses (blendOverlaysGPU). Returns whether any chunk changed. Mirrors
   * gl/render.ts.
   */
  protected async _fuseStackChunks(deadline: number): Promise<boolean> {
    const fuse = this._stackFuse
    const device = this._device
    const base = this._activeChunked
    if (!fuse || !device || !base || this._stackRebuilding) return false
    const entries = this._stackEntries()
    const chunks = base.plan.chunks
    const alpha = this.overlayAlphaBlend
    const color = this.overlayColorBlend
    const weights = stackWeights(entries)
    return fuse.pump(
      chunkRegions(base.plan),
      stackGeneration(entries),
      stackModes(entries, alpha, color),
      (i) => stackInputs(entries, i),
      (inputs, i) => {
        const dims = chunks[i].texDims
        return blendOverlaysGPU(
          device,
          inputs,
          [dims[0], dims[1], dims[2]],
          alpha,
          color,
          weights,
        )
      },
      deadline,
      MAX_CHUNK_UPLOADS_PER_FRAME,
      () => this._stackFuse === fuse && !this._stackRebuilding,
    )
  }

  /** Release the GPU textures backing a single cache entry. */
  private _destroyTexEntry(entry: TexCacheEntry): void {
    if (entry.kind === 'chunked') {
      entry.manager.destroy()
      entry.uploader.dispose()
      entry.decoded.clear()
      if (this._activeChunked === entry) this._activeChunked = null
      if (this._activeOverlayChunked === entry)
        this._activeOverlayChunked = null
      const ci = this._combinedOverlayEntries.indexOf(entry)
      if (ci >= 0) this._combinedOverlayEntries.splice(ci, 1)
    } else {
      entry.volumeTexture.destroy()
      // Null when the volume was uploaded with no gradient consumer on.
      entry.volumeGradientTexture?.destroy()
    }
  }

  /**
   * Release an entry's GPU resources AND drop every cache that points at it.
   *
   * Destroying without deleting is the dangerous half: the entry stays in
   * `_texCache`, so every method that iterates the map -- `beginChunkFrame`,
   * `_ensureSingleGradients`, `_refreshUnlitChunksForLighting`,
   * `chunkStreamStats` -- can still reach a destroyed manager and a disposed
   * uploader. The replace-in-place call sites only re-`set` the key after an
   * await, so a frame landing in that window sees the dead entry. Always evict
   * through here rather than pairing the two calls by hand.
   */
  private _evictTexEntry(key: string | undefined, entry: TexCacheEntry): void {
    this._destroyTexEntry(entry)
    if (!key) return
    this._texCache.delete(key)
    // The cached bind group holds this entry's textures at bindings 1 and 4.
    this._bindGroupCache.delete(key)
  }

  /** Release any cached volume textures whose key is not in `keepKeys`. */
  pruneVolumeCache(keepKeys: Set<string>): void {
    for (const [key, entry] of this._texCache) {
      if (keepKeys.has(key)) continue
      this._evictTexEntry(key, entry)
    }
  }

  protected _invalidateBindGroupCache(): void {
    this._bindGroupCache.clear()
    this._floorBindGroup = null
    this._retiringBindGroups = new WeakMap()
    for (const entry of this._texCache.values()) {
      if (entry.kind === 'chunked') {
        for (let i = 0; i < entry.bindGroups.length; i++) {
          entry.bindGroups[i] = null
        }
      }
    }
  }

  async updateOverlays(
    device: GPUDevice,
    baseVol: NVImage,
    overlayVols: NVImage[],
    _paqdUniforms: readonly number[],
  ): Promise<void> {
    if (!this.isReady) return
    this.clearPaqd()

    if (!baseVol.dimsRAS) {
      this.clearOverlay()
      return
    }
    const dimsOut = [baseVol.dimsRAS[1], baseVol.dimsRAS[2], baseVol.dimsRAS[3]]

    // Drop hidden overlays (visible: false or zero opacity) before the bake:
    // an overlayOpacity of 0 means background semantics in the orient shader,
    // not transparency, so a hidden overlay must leave the list entirely.
    const visible = overlayVols.filter(isVolumeDrawn)
    if (visible.length === 0) {
      this.clearOverlay()
      return
    }

    // Separate PAQD from standard overlays
    const paqdVols = visible.filter((v) => isPaqd(v.hdr) && v.colormapLabel)
    const standardVols = visible.filter((v) => !isPaqd(v.hdr))

    // Upload first PAQD as raw data + LUT texture (GPU shaders do LUT lookup + easing)
    if (paqdVols.length > 0) {
      const vol = paqdVols[0]
      const prepared = preparePaqdOverlayData(baseVol, vol, dimsOut)
      if (prepared) {
        const { paqdData, lut256 } = prepared
        this.paqdPickGrid = { data: paqdData, dims: dimsOut }
        // Chunked (oversized) background: split the raw PAQD volume into one
        // 3D sub-texture per chunk, sharing the volume's ChunkPlan. The single
        // paqdTexture stays null in that case.
        if (baseVol.chunkPlan) {
          this._updatePaqdChunks(device, paqdData, dimsOut, baseVol.chunkPlan)
        } else {
          this.paqdTexture = device.createTexture({
            size: dimsOut,
            format: 'rgba8unorm',
            dimension: '3d',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          })
          device.queue.writeTexture(
            { texture: this.paqdTexture },
            paqdData.buffer as ArrayBuffer,
            { bytesPerRow: dimsOut[0] * 4, rowsPerImage: dimsOut[1] },
            dimsOut,
          )
        }
        // Upload 256-entry padded LUT as 2D texture
        this.paqdLutTexture = device.createTexture({
          size: [256, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        })
        device.queue.writeTexture(
          { texture: this.paqdLutTexture },
          lut256.buffer as ArrayBuffer,
          { bytesPerRow: 256 * 4, rowsPerImage: 1 },
          [256, 1],
        )
      }
    }

    // Independently-streamed hi-res overlays carry chunkOverlayOf: they have
    // their own ChunkPlan + residency and draw as their own chunk cubes over
    // the base, rather than being resliced onto the base grid. Split them out
    // from the base-grid-resliced overlays.
    const independentVols = standardVols.filter((v) => v.chunkOverlayOf)
    const reslicedVols = standardVols.filter((v) => !v.chunkOverlayOf)
    if (independentVols.length > 0) {
      await this._updateOverlayChunkedIndependent(device, independentVols[0], [
        baseVol,
        ...overlayVols,
      ])
      if (independentVols.length > 1) {
        log.warn(
          'only one independently-chunked overlay is supported; ' +
            'extra ones are ignored',
        )
      }
    } else {
      this.clearOverlayChunked()
    }

    // Chunked (oversized) background: build per-chunk overlay textures and
    // skip the single-texture path entirely.
    if (baseVol.chunkPlan) {
      // Strategy A: a resliced overlay carrying a chunkSource and co-registered
      // at the base grid streams as a base-aligned chunked entry and feeds the
      // base block's overlay slot, instead of being resliced whole in memory.
      // A channel stack lists the base among its overlays: the base's own
      // entry is a fuse input, never its own mirror.
      const stack = overlayVols[0] === baseVol
      const streamable = (v: NVImage): boolean =>
        !!v.chunkSource && this._dimsMatchBase(v, baseVol)
      const others = reslicedVols.filter((v) => v !== baseVol)
      const streamedCombined = others.filter(streamable)
      const wholeReslice = others.filter((v) => !streamable(v))
      await this._updateCombinedOverlayChunked(device, streamedCombined, [
        baseVol,
        ...overlayVols,
      ])
      if (stack)
        this._stackFuse ??= new ChunkStackFuse(
          (t) => t.destroy(),
          (i) => {
            const base = this._activeChunked
            if (base) base.bindGroups[i] = null
          },
        )
      else this._clearStackFuse()
      await this._updateOverlayChunks(
        device,
        baseVol,
        baseVol.chunkPlan,
        wholeReslice,
        overlayVols,
      )
      return
    }
    // Non-chunked: drop any per-chunk overlay textures from a prior volume.
    this._clearCombinedOverlayChunked()
    this._destroyOverlayChunks()

    // A streamed overlay (chunkSource, no in-memory `img`) can only render via
    // the chunked path above. It reaches here only transiently — e.g. an
    // overlay-option change fires loadVolumes() while a prior base load is still
    // in flight, so updateOverlays runs before the base's chunkPlan is set.
    // Reslicing it would call volume2Texture/prepareOrientTextureCache on a null
    // `img` and throw "missing image data"; skip it until the next update (once
    // the base is chunked) renders it through the combined path.
    const inMem = reslicedVols.filter((v) => v.img)
    if (inMem.length < reslicedVols.length) {
      log.warn(
        'updateOverlays: skipping streamed overlay(s) with no in-memory image ' +
          'until the base volume is chunked',
      )
    }

    // Upload standard overlays
    if (inMem.length === 0) {
      this.clearOverlay()
    } else if (inMem.length === 1) {
      const vol = inMem[0]
      const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
      this.destroyNonCachedOverlayTexture()
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        // Like the background: rewritten only when its voxels changed.
        // Masking writes a new texture, leaving this one intact.
        orient.destroyOrientTextureCache(this.overlayOrientCache)
        this.overlayOrientCache = null
        this.overlayRgbaCache = orient.prepareRGBATextureCache(
          device,
          vol,
          this.overlayRgbaCache,
        )
        this.overlayTexture = this.overlayRgbaCache.texture
        return
      }
      orient.destroyRGBATextureCache(this.overlayRgbaCache)
      this.overlayRgbaCache = null
      this.overlayOrientCache = await orient.prepareOrientTextureCache(
        device,
        vol,
        baseVol,
        mtx as Float32Array,
        vol.opacity ?? 1,
        this.overlayOrientCache,
        buildModulationParams(vol, baseVol, [baseVol, ...overlayVols]),
        this.overlayKeepsColormapAlpha,
      )
      orient.dispatchOrient(device, this.overlayOrientCache)
      this.overlayTexture = this.overlayOrientCache.outputTexture
    } else if (inMem.length > 1) {
      this.destroyNonCachedOverlayTexture()
      orient.destroyOrientTextureCache(this.overlayOrientCache)
      this.overlayOrientCache = null
      orient.destroyRGBATextureCache(this.overlayRgbaCache)
      this.overlayRgbaCache = null
      const overlayTextures: GPUTexture[] = []
      for (const vol of inMem) {
        const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
        overlayTextures.push(
          await orient.volume2Texture(
            device,
            vol,
            baseVol,
            mtx as Float32Array,
            vol.opacity ?? 1,
            undefined,
            buildModulationParams(vol, baseVol, [baseVol, ...overlayVols]),
            null,
            this.overlayKeepsColormapAlpha,
          ),
        )
      }
      this.destroyNonCachedOverlayTexture()
      this.overlayTexture = await blendOverlaysGPU(
        device,
        overlayTextures,
        dimsOut,
        this.overlayAlphaBlend,
        this.overlayColorBlend,
      )
      for (const tex of overlayTextures) tex.destroy()
    }
  }

  /**
   * Clip the overlay to the background's non-transparent voxels
   * (isBackgroundMasking). The masked copy replaces overlayTexture; the input
   * is destroyed only when no cache owns it, because the orient and RGBA
   * caches write into their texture again on the next update.
   */
  async maskOverlayByBackground(device: GPUDevice): Promise<void> {
    if (!this.overlayTexture || !this.volumeTexture) return
    const masked = await orient.maskOverlayByBackground(
      device,
      this.volumeTexture,
      this.overlayTexture,
    )
    this.destroyNonCachedOverlayTexture()
    this.overlayTexture = masked
  }

  async updateAffineOverlay(
    device: GPUDevice,
    baseVol: NVImage,
    overlayVol: NVImage,
  ): Promise<boolean> {
    if (!this.isReady || !this.overlayOrientCache) return false
    if (!baseVol.dimsRAS || isPaqd(overlayVol.hdr)) return false
    if (isRgbaDatatype(overlayVol.hdr.datatypeCode)) {
      return false
    }
    const mtx = NVTransforms.calculateOverlayTransformMatrix(
      baseVol,
      overlayVol,
    )
    this.overlayOrientCache = await orient.prepareOrientTextureCache(
      device,
      overlayVol,
      baseVol,
      mtx as Float32Array,
      overlayVol.opacity ?? 1,
      this.overlayOrientCache,
      buildModulationParams(overlayVol, baseVol, [baseVol, overlayVol]),
      this.overlayKeepsColormapAlpha,
    )
    orient.dispatchOrient(device, this.overlayOrientCache)
    this.overlayTexture = this.overlayOrientCache.outputTexture
    return true
  }

  private destroyNonCachedVolumeTexture(): void {
    if (
      this.volumeTexture &&
      this.volumeTexture !== this.volumeOrientCache?.outputTexture &&
      this.volumeTexture !== this.volumeRgbaCache?.texture
    ) {
      this.volumeTexture.destroy()
    }
    this.volumeTexture = null
  }

  clearVolume(): void {
    this.destroyNonCachedVolumeTexture()
    orient.destroyOrientTextureCache(this.volumeOrientCache)
    this.volumeOrientCache = null
    orient.destroyRGBATextureCache(this.volumeRgbaCache)
    this.volumeRgbaCache = null
  }

  private destroyNonCachedOverlayTexture(): void {
    if (
      this.overlayTexture &&
      this.overlayTexture !== this.overlayOrientCache?.outputTexture &&
      this.overlayTexture !== this.overlayRgbaCache?.texture
    ) {
      this.overlayTexture.destroy()
    }
    this.overlayTexture = null
  }

  clearOverlay(): void {
    this.destroyNonCachedOverlayTexture()
    orient.destroyOrientTextureCache(this.overlayOrientCache)
    this.overlayOrientCache = null
    orient.destroyRGBATextureCache(this.overlayRgbaCache)
    this.overlayRgbaCache = null
    this._destroyOverlayChunks()
    this.clearOverlayChunked()
    this._clearCombinedOverlayChunked()
    this._invalidateBindGroupCache()
  }

  /** Whether an overlay is co-registered at the base grid (same RAS dims). */
  /** Forget the streamed combined overlays; base reclaims the full budget. */
  /** The NVImage backing the active independent chunked overlay (or null). */
  /**
   * Build one RGBA8 overlay texture per chunk for a chunked oversized volume.
   * The overlay layer shares the background volume's ChunkPlan, so the chunk
   * textures align 1:1 with the volume chunks. A single overlay is oriented
   * directly per chunk; multiple overlays are oriented per chunk and blended
   * on the GPU (mirroring the non-chunked multi-overlay path).
   *
   * RGB/RGBA-datatype overlays are skipped on chunked volumes (the chunked
   * orient pass only supports scalar sources, matching the volume chunker).
   *
   * `overlayVols` is the full overlay list (not just the chunk-rendered subset)
   * so a modulator that is itself hidden or streamed can still be resolved.
   */
  private async _updateOverlayChunks(
    device: GPUDevice,
    baseVol: NVImage,
    plan: ChunkPlan,
    standardVols: NVImage[],
    overlayVols: NVImage[],
  ): Promise<void> {
    // Chunked overlay path: drop the single-texture representation.
    this.destroyNonCachedOverlayTexture()
    orient.destroyOrientTextureCache(this.overlayOrientCache)
    this.overlayOrientCache = null
    orient.destroyRGBATextureCache(this.overlayRgbaCache)
    this.overlayRgbaCache = null
    this._destroyOverlayChunks()

    const supported = standardVols.filter(
      (v) => !isRgbaDatatype(v.hdr.datatypeCode) && v.img,
    )
    if (supported.length < standardVols.length) {
      log.warn(
        'chunked overlay: RGB/RGBA-datatype overlays are not yet supported ' +
          'on oversized volumes, and streamed overlays without an in-memory ' +
          'image cannot be resliced whole; skipped',
      )
    }
    if (supported.length === 0) {
      this._invalidateBindGroupCache()
      return
    }

    const mtxs = supported.map(
      (v) =>
        NVTransforms.calculateOverlayTransformMatrix(
          baseVol,
          v,
        ) as Float32Array,
    )
    // Same modulation the non-chunked path applies; re-targeted per chunk below.
    const mods = supported.map((v) =>
      buildModulationParams(v, baseVol, [baseVol, ...overlayVols]),
    )

    if (supported.length === 1) {
      this.overlayChunks = await orient.overlay2TextureChunked(
        device,
        supported[0],
        baseVol,
        mtxs[0],
        plan,
        supported[0].opacity ?? 1,
        mods[0],
      )
      this._invalidateBindGroupCache()
      return
    }

    // Multiple overlays: orient + GPU-blend per chunk.
    const safeMods = mods.map((mod) => {
      if (
        modulationFitsTextureLimit(mod, device.limits.maxTextureDimension3D)
      ) {
        return mod
      }
      log.warn(
        `modulation disabled: grid ${mod?.dims.join('x')} exceeds WebGPU maxTextureDimension3D (${device.limits.maxTextureDimension3D})`,
      )
      return null
    })
    const sharedModTextures = safeMods.map((mod) =>
      mod ? orient.createModTexture(device, mod) : null,
    )
    const [dx, dy, dz] = plan.volumeDims
    const finals: GPUTexture[] = []
    try {
      for (const desc of plan.chunks) {
        const dims = desc.texDims
        const [ox, oy, oz] = desc.texOrigin
        const scale = [dims[0] / dx, dims[1] / dy, dims[2] / dz]
        const offset = [ox / dx, oy / dy, oz / dz]
        const layers: GPUTexture[] = []
        for (let i = 0; i < supported.length; i++) {
          const chunkMtx = chunkOverlayMatrix(mtxs[i], scale, offset)
          layers.push(
            await orient.volume2Texture(
              device,
              supported[i],
              baseVol,
              chunkMtx,
              supported[i].opacity ?? 1,
              dims,
              chunkModulationParams(safeMods[i], scale, offset),
              sharedModTextures[i],
            ),
          )
        }
        finals.push(
          await blendOverlaysGPU(
            device,
            layers,
            [dims[0], dims[1], dims[2]],
            this.overlayAlphaBlend,
            this.overlayColorBlend,
          ),
        )
        for (const tex of layers) tex.destroy()
      }
    } finally {
      for (const texture of sharedModTextures) texture?.destroy()
    }
    this.overlayChunks = finals
    this._invalidateBindGroupCache()
  }

  /** Release all per-chunk overlay textures from a previous build. */
  private _destroyOverlayChunks(): void {
    if (!this.overlayChunks) return
    for (const tex of this.overlayChunks) tex.destroy()
    this.overlayChunks = null
  }

  clearPaqd(): void {
    this.paqdPickGrid = null
    if (this.paqdTexture) {
      this.paqdTexture.destroy()
      this.paqdTexture = null
    }
    this._destroyPaqdChunks()
    if (this.paqdLutTexture) {
      this.paqdLutTexture.destroy()
      this.paqdLutTexture = null
    }
    this._invalidateBindGroupCache()
  }

  /**
   * Build one raw rgba8unorm PAQD texture per chunk. The PAQD layer shares the
   * background volume's ChunkPlan, so chunk indices and texDims line up with
   * the volume chunks. Each chunk's halo+data region is sliced out of the
   * full-volume PAQD buffer with extractChunkBytes (4 bytes/voxel).
   */
  private _updatePaqdChunks(
    device: GPUDevice,
    paqdData: Uint8Array,
    dims: number[],
    plan: ChunkPlan,
  ): void {
    this._destroyPaqdChunks()
    const volumeDims: Vec3i = [dims[0], dims[1], dims[2]]
    const chunks: GPUTexture[] = []
    for (const desc of plan.chunks) {
      const bytes = extractChunkBytes(
        paqdData,
        volumeDims,
        4,
        desc.texOrigin,
        desc.texDims,
      )
      const [tx, ty, tz] = desc.texDims
      const tex = device.createTexture({
        size: [tx, ty, tz],
        format: 'rgba8unorm',
        dimension: '3d',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      device.queue.writeTexture(
        { texture: tex },
        bytes as Uint8Array<ArrayBuffer>,
        { bytesPerRow: tx * 4, rowsPerImage: ty },
        [tx, ty, tz],
      )
      chunks.push(tex)
    }
    this.paqdChunks = chunks
    this._invalidateBindGroupCache()
  }

  /** Release all per-chunk PAQD textures from a previous build. */
  private _destroyPaqdChunks(): void {
    if (!this.paqdChunks) return
    for (const tex of this.paqdChunks) tex.destroy()
    this.paqdChunks = null
  }

  updateBindGroup(device: GPUDevice): void {
    if (
      !this.isReady ||
      !this.bindLayout ||
      !this.paramsBuffer ||
      !this.sampler ||
      !this.samplerNearest
    )
      return
    if (
      !this.matcapTexture ||
      !this.placeholderOverlay ||
      !this.placeholderLut2D
    )
      return

    const overlayTex = this.overlayTexture || this.placeholderOverlay
    const paqdTex = this.paqdTexture || this.placeholderOverlay
    const drawTex = this.drawingTexture || this.placeholderOverlay
    const paqdLutTex = this.paqdLutTexture || this.placeholderLut2D

    // If any shared (non-volume) texture changed since the cache was
    // populated, drop the per-volume bind group cache — its entries
    // reference stale views. This must run for chunked entries too so
    // their per-chunk bind groups get invalidated.
    const shared = this._bindGroupSharedKey
    if (
      shared.matcap !== this.matcapTexture ||
      shared.overlay !== overlayTex ||
      shared.paqd !== paqdTex ||
      shared.draw !== drawTex ||
      shared.lut !== paqdLutTex
    ) {
      this._invalidateBindGroupCache()
      this._bindGroupSharedKey = {
        matcap: this.matcapTexture,
        overlay: overlayTex,
        paqd: paqdTex,
        draw: drawTex,
        lut: paqdLutTex,
      }
    }

    // Chunked volumes build one bind group per chunk inside draw(); there is
    // no single volume bind group to maintain here.
    if (this._activeChunked) return

    // Only the volume texture is required. volumeGradientTexture is legitimately
    // null on an unlit volume (the gradient pass is skipped at upload), and the
    // shader's needsGradient branch is false in exactly that case, so the
    // placeholder bound at binding 4 is never sampled.
    if (!this.volumeTexture) return
    const gradTex = this.volumeGradientTexture || this.placeholderOverlay

    if (
      this.bindGroup &&
      this._bindTexVol === this.volumeTexture &&
      this._bindTexGrad === gradTex &&
      this._bindTexMatcap === this.matcapTexture &&
      this._bindTexOverlay === overlayTex &&
      this._bindTexPaqd === paqdTex &&
      this._bindTexDraw === drawTex &&
      this._bindTexLut === paqdLutTex
    ) {
      return
    }

    this.bindGroup = device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.paramsBuffer, size: renderParamsSize },
        },
        { binding: 1, resource: this.volumeTexture.createView() },
        { binding: 2, resource: this.matcapTexture.createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: gradTex.createView() },
        { binding: 5, resource: overlayTex.createView() },
        { binding: 6, resource: paqdTex.createView() },
        { binding: 7, resource: drawTex.createView() },
        { binding: 8, resource: this.samplerNearest },
        { binding: 9, resource: paqdLutTex.createView() },
      ],
    })
    this._bindTexVol = this.volumeTexture
    this._bindTexGrad = gradTex
    this._bindTexMatcap = this.matcapTexture
    this._bindTexOverlay = overlayTex
    this._bindTexPaqd = paqdTex
    this._bindTexDraw = drawTex
    this._bindTexLut = paqdLutTex
    if (this._activeVolKey) {
      this._bindGroupCache.set(this._activeVolKey, this.bindGroup)
    }
  }

  updateDrawingTexture(
    device: GPUDevice,
    rgba: Uint8Array,
    dims: number[],
    plan?: ChunkPlan,
    dirtyChunks?: readonly number[],
  ): void {
    if (!this.isReady) return
    if (plan) {
      this._updateDrawingChunks(device, rgba, dims, plan, dirtyChunks)
      return
    }
    // Non-chunked path: switching back from a chunked volume frees the
    // per-chunk drawing textures so only one representation is live.
    this._destroyDrawingChunks()
    if (!this.drawingTexture) {
      this.drawingTexture = device.createTexture({
        size: dims,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        dimension: '3d',
      })
      this._invalidateBindGroupCache()
    }
    device.queue.writeTexture(
      { texture: this.drawingTexture },
      rgba as Uint8Array<ArrayBuffer>,
      { bytesPerRow: dims[0] * 4, rowsPerImage: dims[1] },
      dims,
    )
  }

  /**
   * Build (or refresh) one rgba8unorm drawing texture per chunk. The drawing
   * layer shares the background volume's ChunkPlan, so chunk indices and
   * texDims line up with the volume chunks. Each chunk's halo+data region is
   * sliced out of the full-volume RGBA buffer with extractChunkBytes.
   */
  private _updateDrawingChunks(
    device: GPUDevice,
    rgba: Uint8Array,
    dims: number[],
    plan: ChunkPlan,
    dirtyChunks?: readonly number[],
  ): void {
    // Switching to chunked frees the single-texture representation.
    if (this.drawingTexture) {
      this.drawingTexture.destroy()
      this.drawingTexture = null
    }
    const volumeDims: Vec3i = [dims[0], dims[1], dims[2]]
    const reuse =
      this.drawingChunks !== null &&
      this.drawingChunks.length === plan.chunks.length
    if (!reuse) {
      this._destroyDrawingChunks()
      this.drawingChunks = []
    }
    const chunks = this.drawingChunks ?? []
    // When reusing existing textures, a pen stroke only dirties a few chunks;
    // re-upload just those. A fresh build (or no dirty set) uploads everything.
    const indices =
      reuse && dirtyChunks
        ? dirtyChunks
        : Array.from({ length: plan.chunks.length }, (_, i) => i)
    for (const i of indices) {
      const desc = plan.chunks[i]
      const bytes = extractChunkBytes(
        rgba,
        volumeDims,
        4,
        desc.texOrigin,
        desc.texDims,
      )
      const [tx, ty, tz] = desc.texDims
      let tex = reuse ? chunks[i] : null
      if (!tex) {
        tex = device.createTexture({
          size: [tx, ty, tz],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          dimension: '3d',
        })
        chunks[i] = tex
      }
      device.queue.writeTexture(
        { texture: tex },
        bytes as Uint8Array<ArrayBuffer>,
        { bytesPerRow: tx * 4, rowsPerImage: ty },
        [tx, ty, tz],
      )
    }
    this.drawingChunks = chunks
    // New textures invalidate cached per-chunk bind groups (binding 7).
    if (!reuse) this._invalidateBindGroupCache()
  }

  /** Release all per-chunk drawing textures from a previous build. */
  private _destroyDrawingChunks(): void {
    if (!this.drawingChunks) return
    for (const tex of this.drawingChunks) tex.destroy()
    this.drawingChunks = null
  }

  destroyDrawing(): void {
    if (this.drawingTexture) {
      this.drawingTexture.destroy()
      this.drawingTexture = null
    }
    this._destroyDrawingChunks()
    this._invalidateBindGroupCache()
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    tileIndex: number,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    matRAS: Float32Array | number[],
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    gradientAmount: number,
    volumeCount: number,
    clipPlaneColor: number[],
    clipPlanes: number[],
    isClipCutaway = false,
    paqdUniforms: readonly number[] = [0, 0, 0, 0],
    earlyTermination = 0.95,
    backOpacity = 1,
  ): void {
    if (
      !this.isReady ||
      !this.pipeline ||
      !this.paramsBuffer ||
      !this.vertexBuffer ||
      !this.indexBuffer
    )
      return

    if (this._activeChunked) {
      this._drawChunked(
        device,
        pass,
        tileIndex,
        mvpMatrix,
        normalMatrix,
        matRAS,
        volScale,
        rayDir,
        gradientAmount,
        volumeCount,
        clipPlaneColor,
        clipPlanes,
        isClipCutaway,
        paqdUniforms,
        earlyTermination,
        backOpacity,
      )
      return
    }

    if (!this.bindGroup || !this.volumeTexture) return

    const renderOffset = Math.trunc(tileIndex * alignedRenderSize)
    if (!Number.isFinite(renderOffset)) return

    // Non-chunked: pass-through (identity) tiled-volume uniforms so the cube
    // renders as its own [0,1] tex space exactly as before.
    this._writeRenderParams(
      device,
      this.paramsBuffer,
      renderOffset,
      mvpMatrix,
      normalMatrix,
      matRAS,
      volScale,
      rayDir,
      gradientAmount,
      volumeCount,
      isClipCutaway,
      paqdUniforms,
      earlyTermination,
      clipPlaneColor,
      clipPlanes,
      {
        volumeTexDimsFull: [
          this.volumeTexture.width,
          this.volumeTexture.height,
          this.volumeTexture.depthOrArrayLayers,
        ],
        chunkSubOrigin: [0, 0, 0],
        chunkSubSize: [1, 1, 1],
        dataOriginTexFrac: [0, 0, 0],
        dataSizeTexFrac: [1, 1, 1],
        rayStepTexVox: [
          this.volumeTexture.width,
          this.volumeTexture.height,
          this.volumeTexture.depthOrArrayLayers,
        ],
      },
      // Not an overlay layer, never cross-faded, and carrying the base
      // volume's own opacity.
      0,
      1,
      backOpacity,
    )

    // With an overlay, PAQD or drawing layer in the ray march, specialization
    // measured slower on Metal (up to +40%), so those draws stay generic.
    // SLICES has no march loops to specialize away: exempting it measured
    // 0.66 vs 0.72 ms/frame with three overlays, which is below the bench's
    // trustworthy floor, so it stays on the same rule as the rest.
    const hasLayer =
      this._bindTexOverlay !== this.placeholderOverlay ||
      this._bindTexPaqd !== this.placeholderOverlay ||
      this._bindTexDraw !== this.placeholderOverlay
    const variant = hasLayer
      ? null
      : this._variantPipeline(
          device,
          renderVariantKey({
            clipPlanes,
            isClipCutaway,
            renderMode: this.renderMode,
            cubic: this.isCubicInterpolation && this._cubicVolumeSafe,
            gradientAmount,
            gradientOpacity: this.gradientOpacity,
            silhouette: this.silhouette,
          }),
        )
    pass.setPipeline(variant ?? this.pipeline)
    pass.setBindGroup(0, this.bindGroup, [renderOffset])
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint16')
    pass.drawIndexed(this.cube.indices.length)
  }

  /**
   * The specialized pipeline for `key`, or null while it compiles. Compiled
   * asynchronously so a state change never stalls a frame; the generic
   * pipeline renders identically in the meantime.
   */
  private _variantPipeline(
    device: GPUDevice,
    key: number,
  ): GPURenderPipeline | null {
    const variants = this._variantPipelines
    const cached = variants.get(key)
    if (cached !== undefined || !this._pipelineDesc) return cached ?? null
    variants.set(key, null)
    device
      .createRenderPipelineAsync(
        this._pipelineDesc(renderVariantConstants(key)),
      )
      .then((p) => variants.set(key, p))
      .catch((e) => log.warn(`Render pipeline variant ${key} failed: ${e}`))
    return null
  }

  /**
   * Draw one chunked volume into a 3D-render tile: one cube draw per chunk,
   * composited back-to-front. Each chunk gets its own bind group (distinct
   * volume + gradient textures) and its own uniform slot. Back-to-front order
   * is required for the premultiplied-alpha framebuffer blend to composite
   * overlapping chunk contributions correctly.
   */
  private _drawChunked(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    tileIndex: number,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    matRAS: Float32Array | number[],
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    gradientAmount: number,
    volumeCount: number,
    clipPlaneColor: number[],
    clipPlanes: number[],
    isClipCutaway: boolean,
    paqdUniforms: readonly number[],
    earlyTermination: number,
    backOpacity: number,
  ): void {
    this._drawChunkedEntry(
      device,
      pass,
      this._activeChunked,
      false,
      CHUNK_PARAMS_BASE,
      tileIndex,
      mvpMatrix,
      normalMatrix,
      matRAS,
      volScale,
      rayDir,
      gradientAmount,
      volumeCount,
      clipPlaneColor,
      clipPlanes,
      isClipCutaway,
      paqdUniforms,
      earlyTermination,
      backOpacity,
    )
  }

  /**
   * Draw the independently-streamed hi-res overlay as its own translucent
   * chunk cubes over the base, in the same render pass. Composited via the
   * premultiplied-alpha OVER framebuffer blend. matRAS is the OVERLAY volume's
   * matRAS (its own grid); the camera (mvp/volScale/rayDir) is shared with the
   * base tile.
   *
   * Compositing-order limitation: the base and overlay cube sets are each
   * sorted back-to-front internally, but the overlay set is drawn entirely
   * after the base, so per-pixel the overlay always composites over the base
   * regardless of true depth. Correct for a translucent layer sitting on top of
   * anatomy; an approximation where a base chunk is physically in front of an
   * overlay chunk. A globally-merged order is a future improvement (mirrors the
   * existing per-chunk back-to-front approximation between neighbouring base
   * chunks).
   */
  drawOverlayChunked(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    tileIndex: number,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    matRAS: Float32Array | number[],
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    gradientAmount: number,
    volumeCount: number,
    clipPlaneColor: number[],
    clipPlanes: number[],
    isClipCutaway = false,
    paqdUniforms: readonly number[] = [0, 0, 0, 0],
    earlyTermination = 0.95,
  ): void {
    if (!this._activeOverlayChunked) return
    this._drawChunkedEntry(
      device,
      pass,
      this._activeOverlayChunked,
      true,
      OVERLAY_CHUNK_PARAMS_BASE,
      tileIndex,
      mvpMatrix,
      normalMatrix,
      matRAS,
      volScale,
      rayDir,
      gradientAmount,
      volumeCount,
      clipPlaneColor,
      clipPlanes,
      isClipCutaway,
      paqdUniforms,
      earlyTermination,
    )
  }

  /**
   * Shared chunked-cube draw loop for both the base volume and the independent
   * hi-res overlay. `overlayMode` forces the optional overlay/paqd/drawing
   * layers to placeholders (so only the chunk's own volume is ray-marched) and
   * sets overlayLayerMode=1 so the shader skips the base clip-surface/AO/matcap
   * treatment. `chunkSlotBase` selects the per-entry uniform region so the two
   * cube sets never share uniform slots within a frame.
   */
  private _drawChunkedEntry(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    entry: ChunkedTexEntry | null,
    overlayMode: boolean,
    chunkSlotBase: number,
    tileIndex: number,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    matRAS: Float32Array | number[],
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    gradientAmount: number,
    volumeCount: number,
    clipPlaneColor: number[],
    clipPlanes: number[],
    isClipCutaway: boolean,
    paqdUniforms: readonly number[],
    // The base volume's own opacity. Left at the neutral 1 by the overlay
    // entry, whose opacity is already baked into its chunk textures.
    earlyTermination: number,
    backOpacity = 1,
  ): void {
    if (
      !entry ||
      !this.pipelineChunked ||
      !this.pipelineChunkedMip ||
      !this.paramsBuffer ||
      !this.vertexBuffer ||
      !this.indexBuffer ||
      !this.bindLayout ||
      !this.sampler ||
      !this.samplerNearest ||
      !this.matcapTexture ||
      !this.placeholderOverlay ||
      !this.placeholderLut2D
    )
      return
    if (entry.manager.chunkCount === 0) return
    // Chunk banks are sized for MAX_CHUNK_TILES tiles (not MAX_TILES); a chunked
    // volume drawn beyond that is skipped rather than overflowing into the next
    // bank. Real layouts (multiplanar/render, modest mosaics) stay well under it.
    if (tileIndex < 0 || tileIndex >= MAX_CHUNK_TILES) return

    const paqdLutTex = this.paqdLutTexture || this.placeholderLut2D
    // The overlay layer draws only its own chunk volume — force the optional
    // overlay/paqd/drawing layers to the transparent placeholder so their
    // shader passes (guarded on textureDimensions > 2) stay inert.
    const overlayTex = overlayMode
      ? this.placeholderOverlay
      : this.overlayTexture || this.placeholderOverlay
    const paqdTex = overlayMode
      ? this.placeholderOverlay
      : this.paqdTexture || this.placeholderOverlay
    const drawTex = overlayMode
      ? this.placeholderOverlay
      : this.drawingTexture || this.placeholderOverlay
    // Per-chunk drawing/overlay/PAQD textures align 1:1 with the volume chunks
    // (shared ChunkPlan); fall back to the shared texture when not chunked or
    // when drawing the overlay layer itself.
    const chunkCount = entry.manager.chunkCount
    const drawingChunks =
      !overlayMode &&
      this.drawingChunks &&
      this.drawingChunks.length === chunkCount
        ? this.drawingChunks
        : null
    const overlayChunks =
      !overlayMode &&
      this.overlayChunks &&
      this.overlayChunks.length === chunkCount
        ? this.overlayChunks
        : null
    const paqdChunks =
      !overlayMode && this.paqdChunks && this.paqdChunks.length === chunkCount
        ? this.paqdChunks
        : null
    // Streamed combined overlay (strategy A): for the base entry, base block i's
    // overlay slot is the streamed overlay's resident chunk i (placeholder until
    // it streams in). Takes precedence over the whole-reslice overlayChunks.
    const stackFuse =
      !overlayMode && entry === this._activeChunked ? this._stackFuse : null
    const stackRegions = stackFuse ? chunkRegions(entry.plan) : []
    const stackGen = stackFuse ? this._stackGen() : ''
    const combinedOverlay =
      !overlayMode &&
      entry === this._activeChunked &&
      this._combinedOverlayEntries.length === 1
        ? this._combinedOverlayEntries[0]
        : null

    const explode = entry.volume.chunkExplode
    const brickOpacity = entry.volume.chunkBrickOpacity
    const offsets = chunkOffsetFor(entry.plan, explode)
    const covered = (i: number): boolean => entry.manager.isCoveredByRetiring(i)
    let order = chunkDrawOrder(
      entry.plan,
      entry.manager.retiringChunks,
      covered,
      rayDir,
      offsets,
      volScale,
    )
    // Retiring cubes take uniform slots after the plan's; past the per-tile
    // cap, draw the plan alone (its uncovered regions fall back to the floor).
    if (order.length > MAX_CHUNKS_PER_TILE) {
      order = chunkDrawOrder(entry.plan, [], covered, rayDir, offsets, volScale)
    }

    // MIP: merge chunk draws (and the overlay entry's draws over the base) by
    // component-wise max instead of OVER — matching the shader's own per-layer
    // MIP rule (depthAwareMix), so the result is the true full-ray maximum
    // independent of chunk draw order.
    pass.setPipeline(
      this.renderMode === VOLUME_RENDER_MODE.MAXIMUM
        ? this.pipelineChunkedMip
        : this.pipelineChunked,
    )
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint16')

    // Coarse floor: when a fine chunk of the base volume has not streamed in,
    // draw a coarse-floor cube for that chunk's region instead of skipping it,
    // so the 3D view shows coarse detail immediately and never pops in from
    // blank. A freshly-resident fine chunk then cross-fades in over its floor
    // cube (drawn behind it) so detail dissolves in instead of popping. Once
    // settled, each region is drawn exactly once (fine if faded in, else
    // coarse), so there is no steady-state volumetric double-exposure.
    const floorActive =
      !overlayMode &&
      entry === this._activeChunked &&
      this.coarseFloorTexture !== null &&
      this.coarseFloorGradientTexture !== null

    // Captured (narrowed) locals so the floor-cube closure can reference them
    // without re-deriving non-null narrowing inside the nested scope.
    const paramsBuffer = this.paramsBuffer
    const matcapTexture = this.matcapTexture
    const placeholderOverlay = this.placeholderOverlay
    const bindLayout = this.bindLayout
    const sampler = this.sampler
    const samplerNearest = this.samplerNearest

    // Draw the coarse-floor cube for one chunk region. It uses its own uniform
    // bank (FLOOR_CHUNK_PARAMS_BASE) so a mid-fade chunk's floor cube and fine
    // cube never share a dynamic offset within a frame. Samples the coarse
    // whole-volume texture at the chunk's full-volume fraction: data{Origin,Size}
    // = chunkSub{Origin,Size} makes chunkTexCoord the identity into the
    // (halo-less) coarse texture. The bind group (coarse texture + its gradient
    // + transparent placeholders) is identical for every cube, so it is cached.
    const drawFloorCube = (chunkIndex: number, slot: number): void => {
      const floorTex = this.coarseFloorTexture
      if (!floorTex) return
      if (!this._floorBindGroup) {
        this._floorBindGroup = device.createBindGroup({
          layout: bindLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: paramsBuffer, size: renderParamsSize },
            },
            { binding: 1, resource: floorTex.createView() },
            { binding: 2, resource: matcapTexture.createView() },
            { binding: 3, resource: sampler },
            {
              binding: 4,
              resource: (
                this.coarseFloorGradientTexture ?? floorTex
              ).createView(),
            },
            { binding: 5, resource: placeholderOverlay.createView() },
            { binding: 6, resource: placeholderOverlay.createView() },
            { binding: 7, resource: placeholderOverlay.createView() },
            { binding: 8, resource: samplerNearest },
            { binding: 9, resource: paqdLutTex.createView() },
          ],
        })
      }
      const cu = chunkUniformsFor(entry.plan, chunkIndex)
      const floorRenderOffset =
        FLOOR_CHUNK_PARAMS_BASE +
        (tileIndex * MAX_CHUNKS_PER_TILE + slot) * alignedRenderSize
      this._writeRenderParams(
        device,
        paramsBuffer,
        floorRenderOffset,
        mvpMatrix,
        normalMatrix,
        chunkExplodedMatRAS(entry.plan, chunkIndex, matRAS, explode),
        volScale,
        rayDir,
        gradientAmount,
        volumeCount,
        isClipCutaway,
        paqdUniforms,
        earlyTermination,
        clipPlaneColor,
        clipPlanes,
        {
          volumeTexDimsFull: cu.volumeTexDimsFull,
          chunkSubOrigin: cu.chunkSubOrigin,
          chunkSubSize: cu.chunkSubSize,
          dataOriginTexFrac: cu.chunkSubOrigin,
          dataSizeTexFrac: cu.chunkSubSize,
          // March at the floor texture's OWN voxel density, not the fine common
          // grid: the step-size correction turns each step into an optical depth
          // of `fineVoxels / steps` reference steps, so oversampling a much
          // coarser texture drives the first in-tissue sample to alpha 1 and the
          // cube renders as a dark surface shell instead of an integrated
          // backdrop.
          rayStepTexVox: this.coarseFloorDims ?? cu.volumeTexDimsFull,
          // The floor is not a member of `plan.chunks`, so its downsample
          // comes from its own dims. It is usually the coarsest data on
          // screen: uncompensated, it puts the scene's largest brightness
          // step right at the edge of the resident fine region.
          lodDownsample: this.coarseFloorDims
            ? dimsDownsample(entry.plan.volumeDims, this.coarseFloorDims)
            : 1,
          // The floor is one whole-volume texture, so the cubic kernel is always
          // safely fed here. It still follows the fine bricks' verdict: when
          // their halo is too thin and cubic is refused, a cubic floor under
          // trilinear bricks would put a reconstruction change exactly at the
          // edge of the resident region. One filter per volume, always.
          cubicSafe: entry.cubicSafe,
        },
        0,
        // The fine cube in front of this one carries the cross-fade weight;
        // the floor only takes the brick's own opacity (chunkBrickOpacity),
        // so a dimmed brick's backdrop dims with it. The floor is base-volume
        // data, so it takes the base's opacity along with it.
        brickOpacity?.[chunkIndex] ?? 1,
        backOpacity,
      )
      pass.setBindGroup(0, this._floorBindGroup, [floorRenderOffset])
      pass.drawIndexed(this.cube.indices.length)
    }

    // A retiring brick from a make-before-break swap: its own texture, placed
    // by its own (older) plan, at full strength, without layers (as the floor
    // it stands in for).
    const drawRetiringCube = (
      ref: RetiringChunk<VolumeChunkGPU>,
      slot: number,
    ): void => {
      const chunk = ref.chunk
      let bindGroup = this._retiringBindGroups.get(chunk)
      if (!bindGroup) {
        bindGroup = device.createBindGroup({
          layout: bindLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: paramsBuffer, size: renderParamsSize },
            },
            { binding: 1, resource: chunk.volumeTexture.createView() },
            { binding: 2, resource: matcapTexture.createView() },
            { binding: 3, resource: sampler },
            { binding: 4, resource: chunk.volumeGradientTexture.createView() },
            { binding: 5, resource: placeholderOverlay.createView() },
            { binding: 6, resource: placeholderOverlay.createView() },
            { binding: 7, resource: placeholderOverlay.createView() },
            { binding: 8, resource: samplerNearest },
            { binding: 9, resource: paqdLutTex.createView() },
          ],
        })
        this._retiringBindGroups.set(chunk, bindGroup)
      }
      const renderOffset =
        chunkSlotBase +
        (tileIndex * MAX_CHUNKS_PER_TILE + slot) * alignedRenderSize
      this._writeRenderParams(
        device,
        paramsBuffer,
        renderOffset,
        mvpMatrix,
        normalMatrix,
        chunkExplodedMatRAS(ref.plan, ref.index, matRAS, null),
        volScale,
        rayDir,
        gradientAmount,
        volumeCount,
        isClipCutaway,
        paqdUniforms,
        earlyTermination,
        clipPlaneColor,
        clipPlanes,
        {
          ...chunkUniformsFor(ref.plan, ref.index),
          // Its own plan's halo decides whether cubic sampling is safe.
          cubicSafe: entry.cubicSafe && planSupportsCubic(ref.plan),
        },
        overlayMode ? 1 : 0,
        1,
        backOpacity,
      )
      pass.setBindGroup(0, bindGroup, [renderOffset])
      pass.drawIndexed(this.cube.indices.length)
    }

    for (let slot = 0; slot < order.length; slot++) {
      const item = order[slot]
      if (item.retiring) {
        drawRetiringCube(item.retiring, slot)
        continue
      }
      const chunkIndex = item.index
      const chunk = entry.manager.getChunk(chunkIndex)
      if (!chunk) {
        if (floorActive) drawFloorCube(chunkIndex, slot)
        continue
      }
      // Cross-fade a freshly-resident fine chunk in over its coarse floor: draw
      // the floor cube first (full strength), then the fine cube composites over
      // it with premultiplied weight `fade`. Once settled (fade === 1) the floor
      // cube is skipped and only the fine cube is drawn.
      const fade = floorActive
        ? entry.manager.fadeFraction(
            chunkIndex,
            this._frameNow,
            this.chunkFadeMs,
          )
        : 1
      if (fade < 1) {
        drawFloorCube(chunkIndex, slot)
        this._fadeActive = true
      }
      let bindGroup = entry.bindGroups[chunkIndex]
      if (!bindGroup) {
        bindGroup = device.createBindGroup({
          layout: this.bindLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: this.paramsBuffer, size: renderParamsSize },
            },
            { binding: 1, resource: chunk.volumeTexture.createView() },
            { binding: 2, resource: this.matcapTexture.createView() },
            { binding: 3, resource: this.sampler },
            {
              binding: 4,
              resource: chunk.volumeGradientTexture.createView(),
            },
            {
              binding: 5,
              resource: (stackFuse
                ? (stackFuse.get(
                    chunkIndex,
                    stackRegions[chunkIndex],
                    stackGen,
                  ) ?? this.placeholderOverlay)
                : combinedOverlay
                  ? (combinedOverlay.manager.getChunk(chunkIndex)
                      ?.volumeTexture ?? this.placeholderOverlay)
                  : overlayChunks
                    ? overlayChunks[chunkIndex]
                    : overlayTex
              ).createView(),
            },
            {
              binding: 6,
              resource: (paqdChunks
                ? paqdChunks[chunkIndex]
                : paqdTex
              ).createView(),
            },
            {
              binding: 7,
              resource: (drawingChunks
                ? drawingChunks[chunkIndex]
                : drawTex
              ).createView(),
            },
            { binding: 8, resource: this.samplerNearest },
            { binding: 9, resource: paqdLutTex.createView() },
          ],
        })
        entry.bindGroups[chunkIndex] = bindGroup
      }

      const renderOffset =
        chunkSlotBase +
        (tileIndex * MAX_CHUNKS_PER_TILE + slot) * alignedRenderSize
      this._writeRenderParams(
        device,
        this.paramsBuffer,
        renderOffset,
        mvpMatrix,
        normalMatrix,
        chunkExplodedMatRAS(entry.plan, chunkIndex, matRAS, explode),
        volScale,
        rayDir,
        gradientAmount,
        volumeCount,
        isClipCutaway,
        paqdUniforms,
        earlyTermination,
        clipPlaneColor,
        clipPlanes,
        {
          ...chunkUniformsFor(entry.plan, chunkIndex),
          cubicSafe: entry.cubicSafe,
        },
        overlayMode ? 1 : 0,
        // The brick's own opacity (chunkBrickOpacity) rides the fade lane, not
        // backOpacity: a chunked draw applies backOpacity per sample, where a
        // ray through solid tissue saturates whatever the value, so dimming
        // that way barely shows. Scaling the brick's premultiplied result
        // fades its presence and coverage together, and deeper bricks show
        // through it.
        fade * (brickOpacity?.[chunkIndex] ?? 1),
        backOpacity,
      )

      pass.setBindGroup(0, bindGroup, [renderOffset])
      pass.drawIndexed(this.cube.indices.length)
    }
  }

  private _writeRenderParams(
    device: GPUDevice,
    paramsBuffer: GPUBuffer,
    offset: number,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    matRAS: Float32Array | number[],
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    gradientAmount: number,
    volumeCount: number,
    isClipCutaway: boolean,
    paqdUniforms: readonly number[],
    earlyTermination: number,
    clipPlaneColor: number[],
    clipPlanes: number[],
    chunkUniforms: ChunkUniforms,
    overlayLayerMode = 0,
    fadeAlpha = 1,
    backOpacity = 1,
  ): void {
    device.queue.writeBuffer(
      paramsBuffer,
      offset,
      new Float32Array([
        ...mvpMatrix,
        ...normalMatrix,
        ...matRAS,
        ...volScale,
        1.0,
        ...rayDir,
        1.0,
        gradientAmount,
        volumeCount,
        isClipCutaway ? 1.0 : 0.0,
        // overlayLayerMode (was numPaqd, unused): 1 for an independent hi-res
        // overlay cube draw (skip clip-surface/AO/matcap), 0 otherwise.
        overlayLayerMode,
        ...clipPlaneColor,
        ...clipPlanes,
        ...paqdUniforms,
        earlyTermination,
        // clipPlaneOverlay sits at WGSL offset 372 (the f32 immediately after
        // earlyTermination); the following _pad0: vec2f aligns to 384 and ends
        // at 392, and the next vec4f aligns to 400. These 7 floats advance the
        // byte cursor 372 → 400 (to that vec4f), unchanged.
        this.clipPlaneOverlay ? 1.0 : 0.0,
        // fadeAlpha (lane after clipPlaneOverlay): streaming cross-fade weight.
        fadeAlpha,
        // renderMode (offset 380): 0 = composite (OVER), 1 = maximum-intensity
        // projection. Occupies what used to be implicit padding, so nothing moves.
        this.renderMode,
        // cubicFilter (offset 384, was _pad0.x): tricubic B-spline reconstruction
        // in the background fine pass. Forced off for a categorical volume and
        // for a brick whose halo is too thin to feed the kernel (see the GL
        // renderer's identical gate).
        this.isCubicInterpolation &&
        this._cubicVolumeSafe &&
        chunkUniforms.cubicSafe !== false
          ? 1
          : 0,
        // invGamma (offset 388, was _pad0.y): the shader raises the classified
        // RGB to this power. Two exponents compose here (pow is associative in
        // the exponent): the reciprocal of the user-facing display gamma, and
        // this brick's per-level compensation for the brightness a coarse
        // pyramid level loses in the march. The latter is 1 for every
        // single-level and non-chunked draw -- and for SLICES, which takes one
        // sample per plane and so loses nothing to compensate for. Without that
        // gate a coarse floor brick's planes read brighter than the resident
        // fine ones beside them.
        invGamma(this.gamma) *
          lodGammaExponent(
            chunkUniforms.lodDownsample ?? 1,
            // SLICES takes one sample per plane whatever the level, so there is
            // nothing to compensate; 0 makes lodGammaExponent an exact no-op.
            this.renderMode === VOLUME_RENDER_MODE.SLICES
              ? 0
              : this.lodBrightnessCompensation,
          ),
        // lodOpacityScale (offset 392, was the first _pad0 lane): scales the
        // step-size opacity exponent for a coarse brick. 1 for every
        // single-level and non-chunked draw, and for the default coefficient 0.
        lodOpacityScale(
          chunkUniforms.lodDownsample ?? 1,
          this.lodOpacityCompensation,
        ),
        // backOpacity (offset 396, the last _pad0 lane): the background
        // volume's own opacity, scaling every background sample's alpha.
        // Overlays bake theirs into the overlay texture during the orient
        // pass, so this is the only volume it applies to.
        backOpacity,
        ...chunkUniforms.volumeTexDimsFull,
        1,
        // The next three .w lanes are NOT padding: they carry the crosshair
        // planes for SLICES mode (see sliceFrac() in volumeShaderLib.ts), which
        // is why the 512-byte Params struct does not have to grow for them.
        ...chunkUniforms.chunkSubOrigin,
        this.sliceFrac[0],
        ...chunkUniforms.chunkSubSize,
        this.sliceFrac[1],
        ...chunkUniforms.dataOriginTexFrac,
        this.sliceFrac[2],
        ...chunkUniforms.dataSizeTexFrac,
        // .w: isAlphaClipDark, read by SLICES only (see alphaClipDark()).
        this.isAlphaClipDark ? 1 : 0,
        ...chunkUniforms.rayStepTexVox,
        // .w lane: ray samples per voxel in the fine march (was pad).
        this.sampleRate,
        // layerGradientMode (offset 496): the stencil the overlay and drawing
        // passes use for their own gradient. Trailing f32s -- the struct's
        // 16-byte alignment rounds the size back up to the 512 it already
        // occupied, so no offset above moves and the buffer does not grow.
        this.layerGradientMode,
        // gradientOpacity (500) and silhouettePower (504): background-only
        // alpha modulation from the precomputed gradient. 0 is a no-op for both.
        this.gradientOpacity,
        this.silhouette,
        // overlayOpacityCorrection (508).
        this.isOverlayOpacityCorrected ? 1 : 0,
      ]),
    )
  }

  async loadMatcap(device: GPUDevice, matcapUrl: string): Promise<void> {
    if (!this.isReady) return

    try {
      const newTex = await wgpu.bitmap2textureOrFallback(device, matcapUrl)
      if (this.matcapTexture) this.matcapTexture.destroy()
      this.matcapTexture = newTex
      this._matcapUrl = matcapUrl
      this._invalidateBindGroupCache()
      // Wait for GPU to finish upload
      await device.queue.onSubmittedWorkDone()
    } catch (e) {
      log.warn('Matcap load failed', e)
    }
  }

  /**
   * Set (or clear, with null) the coarse whole-volume floor texture for the
   * active base. `coarseVol` is a small in-memory pyramid level supplied by the
   * app; it is oriented once into a single RGBA texture (its own colormap /
   * calibration). The 2D slice path samples it behind the resident fine chunks;
   * the 3D ray-march draws a floor cube (with its gradient, for matcap lighting)
   * for each chunk region whose fine chunk has not streamed in. Re-orients only
   * when {@link coarseFloorKey} changes.
   */
  async setCoarseFloor(
    device: GPUDevice,
    coarseVol: NVImage | null,
  ): Promise<void> {
    if (!this.isReady) return
    this._floorBindGroup = null
    if (!coarseVol) {
      this.coarseFloorTexture?.destroy()
      this.coarseFloorGradientTexture?.destroy()
      this.coarseFloorTexture = null
      this.coarseFloorGradientTexture = null
      this.coarseFloorDims = null
      this._coarseFloorKey = null
      return
    }
    // Orient the coarse level into its own (small) RGBA grid. It shares the base
    // volume's mm box, so the slice can sample it at the base's texture fraction.
    const mtx = NVTransforms.calculateOverlayTransformMatrix(
      coarseVol,
      coarseVol,
    )
    const key = coarseFloorKey(coarseVol, mtx)
    if (key === this._coarseFloorKey && this.coarseFloorTexture) return
    // overlayOpacity 0: the floor stands in for the BASE volume, so it must be
    // baked with base semantics (alpha straight from the colormap LUT). Passing
    // 1 selects the overlay path, which makes alpha binary (`step()`); every
    // voxel above threshold then reads fully opaque and a floor cube terminates
    // its ray on the first surface hit, rendering as a dark shell.
    const tex = await orient.volume2Texture(
      device,
      coarseVol,
      coarseVol,
      mtx as Float32Array,
      0,
    )
    // Gradient for the 3D floor cubes' matcap lighting (matches base shading).
    const grad = await wgpu.volume2TextureGradientRGBA(device, tex)
    this.coarseFloorTexture?.destroy()
    this.coarseFloorGradientTexture?.destroy()
    this.coarseFloorTexture = tex
    this.coarseFloorGradientTexture = grad
    this.coarseFloorDims = [tex.width, tex.height, tex.depthOrArrayLayers]
    this._coarseFloorKey = key
  }

  hasVolume(): boolean {
    return this._activeChunked !== null || this.volumeTexture !== null
  }

  /**
   * True when the active base volume is chunked (tiled / multi-LOD). Such a
   * volume has no single whole-volume texture, so the GPU depth-pick pass cannot
   * sample it; callers fall back to a CPU bounding-box ray pick.
   */
  get hasChunkedVolume(): boolean {
    return this._activeChunked !== null
  }

  hasOverlay(): boolean {
    return this.overlayTexture !== null
  }

  destroy(): void {
    // Destroy textures
    if (this.matcapTexture) {
      this.matcapTexture.destroy()
      this.matcapTexture = null
      this._matcapUrl = null
    }
    // Destroy all cached per-volume textures (covers the currently active
    // volumeTexture/volumeGradientTexture, which alias an entry).
    for (const entry of this._texCache.values()) {
      this._destroyTexEntry(entry)
    }
    // Release the non-chunked orient-texture cache + standalone gradient
    // (normal single-volume path).
    this.clearVolume()
    if (this.volumeGradientTexture) {
      this.volumeGradientTexture.destroy()
      this.volumeGradientTexture = null
    }
    this._texCache.clear()
    this._bindGroupCache.clear()
    this._activeChunked = null
    this._activeOverlayChunked = null
    this._combinedOverlayEntries = []
    this._activeVolKey = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.coarseFloorTexture?.destroy()
    this.coarseFloorGradientTexture?.destroy()
    this.coarseFloorTexture = null
    this.coarseFloorGradientTexture = null
    this.coarseFloorDims = null
    this._floorBindGroup = null
    this._coarseFloorKey = null
    this.clearOverlay()
    if (this.paqdTexture) {
      this.paqdTexture.destroy()
      this.paqdTexture = null
    }
    this._destroyPaqdChunks()
    if (this.drawingTexture) {
      this.drawingTexture.destroy()
      this.drawingTexture = null
    }
    this._destroyDrawingChunks()
    if (this.placeholderOverlay) {
      this.placeholderOverlay.destroy()
      this.placeholderOverlay = null
    }

    // Destroy buffers
    if (this.paramsBuffer) {
      this.paramsBuffer.destroy()
      this.paramsBuffer = null
    }
    if (this.vertexBuffer) {
      this.vertexBuffer.destroy()
      this.vertexBuffer = null
    }
    if (this.indexBuffer) {
      this.indexBuffer.destroy()
      this.indexBuffer = null
    }

    // Clear references
    this.bindGroup = null
    this.sampler = null
    this.samplerNearest = null
    this.pipeline = null
    this.pipelineChunked = null
    this.pipelineChunkedMip = null
    this._variantPipelines = new Map()
    this._pipelineDesc = null
    this.bindLayout = null
    this._bindTexVol = null
    this._bindTexGrad = null
    this._bindTexMatcap = null
    this._bindTexOverlay = null
    this._bindTexPaqd = null
    this._bindTexDraw = null
    this._bindTexLut = null
    this.isReady = false

    // Destroy per-device cached pipelines
    if (this._device) {
      orient.destroy(this._device)
      this._device = null
    }
  }
}
