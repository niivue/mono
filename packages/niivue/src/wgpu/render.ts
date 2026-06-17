import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVShapes from '@/mesh/NVShapes'
import { isPaqd } from '@/NVConstants'
import type { NVImage, VolumeChunkExplode } from '@/NVTypes'
import { NVRenderer } from '@/view/NVRenderer'
import {
  isRgbaDatatype,
  preparePaqdOverlayData,
} from '@/view/NVRenderVolumeData'
import {
  chunkExplodedMatRAS,
  chunkExplodeEnabled,
  chunkExplodeOffsetFrac,
} from '@/volume/ChunkExplode'
import { ChunkResidencyManager } from '@/volume/ChunkResidency'
import {
  chunksBackToFront,
  chunksInFrustum,
  chunksNotClippedOut,
  orderByViewCenter,
} from '@/volume/ChunkVisibility'
import {
  bytesPerSourceVoxel,
  estimateChunkedBytes,
  formatBytes,
  maxChunksForBudget,
} from '@/volume/chunkBudget'
import {
  type ChunkPlan,
  chunkVolume,
  needsChunking,
  type Vec3i,
} from '@/volume/chunking'
import { chunkOverlayMatrix, extractChunkBytes } from '@/volume/orientChunked'
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
 * Default GPU memory budget, in bytes, for a chunked volume's resident chunk
 * set (scalar + RGBA + gradient across resident chunks). Picked to fit
 * comfortably below a typical 4 GiB discrete-GPU budget while leaving headroom
 * for overlays, fonts, and other resident textures. Overridable per instance
 * via the `maxChunkResidencyBytes` option — the ChunkResidencyManager evicts
 * least-recently-visible chunks to keep the resident set within budget.
 */
const DEFAULT_CHUNK_RESIDENCY_BYTES = 1_500_000_000

/**
 * Maximum chunks a single chunked volume may tile into. Bounds the per-chunk
 * uniform-buffer slot allocation (one slot per chunk per chunk-tile). A volume
 * that tiles into more chunks than this fails fast in updateVolume with a clear
 * error — a structural limit of the fixed-size uniform buffer, not a memory
 * budget (memory pressure is handled by chunk eviction). Raised to 1024 (from
 * 256) so full-resolution pyramid levels of large volumes still load; kept
 * memory-neutral by sizing the chunk banks with MAX_CHUNK_TILES instead of
 * MAX_TILES (see paramsBuffer allocation).
 */
const MAX_CHUNKS_PER_TILE = 1024

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

/**
 * Streaming-pump budget per `pumpChunkUploads` call. The pump uploads chunks
 * (each: source fetch + orient + gradient) round-robin across chunked volumes
 * until either the wall-clock budget or the hard cap is reached, then yields so
 * the next frame can present the freshly-resident bricks. A wall-clock budget
 * (rather than a fixed count) self-tunes: when uploads are cheap (cached fetch,
 * fast GPU) many land per frame for a quick fill; when they are expensive the
 * frame still yields promptly. The cap bounds the worst case.
 */
const CHUNK_UPLOAD_BUDGET_MS = 8
const MAX_CHUNK_UPLOADS_PER_FRAME = 24
/**
 * How many upcoming queued chunks the pump prefetches (source fetch) ahead of
 * upload, per chunked volume per pump. Matched to the uploader's internal
 * outstanding-fetch cap so the fetch window stays full as uploads drain it.
 */
const CHUNK_PREFETCH_WINDOW = 16
/**
 * Share of the single configured `maxChunkResidencyBytes` given to an
 * independent hi-res overlay's residency manager; the base keeps the rest. In
 * the 3D render both layers are all-resident, so without a split base + overlay
 * could each fill the full budget and over-commit VRAM. The overlay gets the
 * smaller share since the base is the primary anatomy.
 */
const OVERLAY_RESIDENCY_FRACTION = 0.4

/**
 * Near-plane depth convention for this backend's clip space. WebGPU clip space
 * has z in [0, w]; `chunksInFrustum` uses this to cull against the near plane.
 */
const CLIP_SPACE_ZERO_TO_ONE = true

type Vec3f = [number, number, number]

/**
 * Per-chunk uniform values for one cube draw of a chunked volume. The renderer
 * computes these from the ChunkPlan; the shader uses them to scale the unit
 * cube into the chunk's sub-region and remap sample positions into the chunk
 * texture (including halo). Non-chunked draws use identity pass-through values.
 */
interface ChunkUniforms {
  /** Full volume RAS dims (used for ray step size and frac2ndc). */
  volumeTexDimsFull: Vec3f
  /** Chunk's sub-cube origin in the full-volume [0,1] cube. */
  chunkSubOrigin: Vec3f
  /** Chunk's sub-cube size in the full-volume [0,1] cube. */
  chunkSubSize: Vec3f
  /** Halo offset in the chunk's local texture (skips low-side halo). */
  dataOriginTexFrac: Vec3f
  /** Data extent in the chunk's local texture (excludes halo on both sides). */
  dataSizeTexFrac: Vec3f
}

/** Single-texture volume: fits within maxTextureDimension3D on all axes. */
interface SingleTexEntry {
  kind: 'single'
  volumeTexture: GPUTexture
  volumeGradientTexture: GPUTexture
}

/** Chunked (tiled) volume: one or more axes exceed maxTextureDimension3D. */
interface ChunkedTexEntry {
  kind: 'chunked'
  /** Volume object that owns mutable per-volume render options. */
  volume: NVImage
  /** GPU residency bookkeeping for the volume's chunks. */
  manager: ChunkResidencyManager<VolumeChunkGPU>
  /** On-demand uploader the streaming pump drives to fill the manager. */
  uploader: ChunkUploaderGPU
  plan: ChunkPlan
  /** Per-chunk cached bind group; null until built or after invalidation. */
  bindGroups: (GPUBindGroup | null)[]
}

type TexCacheEntry = SingleTexEntry | ChunkedTexEntry

// 480 bytes = 120 floats:
//   16 mvp + 16 norm + 16 matRAS + 4 volScale + 4 rayDir + 4 (gradient/numVol/cutaway/pad)
//   + 4 clipPlaneColor + 24 clipPlanes + 4 paqd + 1 earlyTermination + 7 _pad0 (vec3 align)
//   + 4 volumeTexDimsFull + 4 chunkSubOrigin + 4 chunkSubSize
//   + 4 dataOriginTexFrac + 4 dataSizeTexFrac
const renderParamsSize = 480
export const alignedRenderSize =
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
// Duration of the streaming-chunk cross-fade between LOD levels. A chunk
// admitted this long ago (or longer) draws at full strength; younger chunks
// dissolve in over the floor. Set to 0 to disable the cross-fade entirely:
// fadeFraction then returns 1 immediately, so a fine chunk pops in at full
// strength (the floor is still drawn for chunks that are not yet resident).
const CHUNK_FADE_MS = 0

/**
 * Steady-state GPU bytes one resident chunk occupies. The scalar source
 * texture is destroyed after the orient pass, so only the RGBA color texture
 * and the gradient texture persist — both rgba8unorm (4 bytes/voxel) over the
 * chunk's padded `texDims`.
 */
function chunkResidentBytes(chunk: VolumeChunkGPU): number {
  const [tx, ty, tz] = chunk.desc.texDims
  return tx * ty * tz * 8
}

/** Per-chunk uniform values derived from a chunk descriptor and its plan. */
function chunkUniformsFor(plan: ChunkPlan, chunkIndex: number): ChunkUniforms {
  const desc = plan.chunks[chunkIndex]
  const [vx, vy, vz] = plan.volumeDims
  const [tx, ty, tz] = desc.texDims
  return {
    volumeTexDimsFull: [vx, vy, vz],
    chunkSubOrigin: [
      desc.voxelOrigin[0] / vx,
      desc.voxelOrigin[1] / vy,
      desc.voxelOrigin[2] / vz,
    ],
    chunkSubSize: [
      desc.voxelDims[0] / vx,
      desc.voxelDims[1] / vy,
      desc.voxelDims[2] / vz,
    ],
    dataOriginTexFrac: [
      desc.haloLow[0] / tx,
      desc.haloLow[1] / ty,
      desc.haloLow[2] / tz,
    ],
    dataSizeTexFrac: [
      desc.voxelDims[0] / tx,
      desc.voxelDims[1] / ty,
      desc.voxelDims[2] / tz,
    ],
  }
}

function chunkOffsetFor(
  plan: ChunkPlan,
  explode: VolumeChunkExplode | undefined,
): ((chunkIndex: number) => Vec3f) | undefined {
  if (!chunkExplodeEnabled(explode)) return undefined
  return (chunkIndex: number) =>
    chunkExplodeOffsetFrac(plan, chunkIndex, explode)
}

export class VolumeRenderer extends NVRenderer {
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
  // GPU memory budget for a chunked volume's resident chunk set. Set from the
  // maxChunkResidencyBytes option in init; passed to each ChunkResidencyManager.
  private _chunkResidencyBytes = DEFAULT_CHUNK_RESIDENCY_BYTES
  // Scene flag (set per-frame from md.scene): clip the overlay/PAQD/drawing passes
  // with the base volume instead of letting them ignore the clip plane.
  clipPlaneOverlay = false
  private _matcapUrl: string | null = null
  private _bindTexVol: GPUTexture | null = null
  private _bindTexGrad: GPUTexture | null = null
  private _bindTexMatcap: GPUTexture | null = null
  private _bindTexOverlay: GPUTexture | null = null
  private _bindTexPaqd: GPUTexture | null = null
  private _bindTexDraw: GPUTexture | null = null
  private _bindTexLut: GPUTexture | null = null
  private overlayOrientCache: orient.OrientTextureCache | null = null
  // Per-volume GPU texture cache. Populated by updateVolume; consumed by
  // bindCachedVolume to switch the active volume/gradient texture per tile
  // when rendering multi-instance global3d scenes.
  private _texCache: Map<string, TexCacheEntry> = new Map()
  // Per-volume cached bind groups so multi-volume tile loops can swap
  // textures without rebuilding the bind group every frame. Keyed by the
  // same cacheKey as _texCache. Invalidated whenever any non-volume
  // texture (overlay/paqd/draw/matcap/lut) changes. Single-texture entries
  // only — chunked entries cache per-chunk bind groups on the entry itself.
  private _bindGroupCache: Map<string, GPUBindGroup> = new Map()
  private _activeVolKey: string | null = null
  // Set when bindCachedVolume selects a chunked entry; null for single
  // entries. draw() branches on this to run the multi-chunk loop.
  private _activeChunked: ChunkedTexEntry | null = null
  // Set when an independently-streamed hi-res overlay (chunkOverlayOf) is
  // loaded over a chunked base. It has its OWN ChunkPlan + residency manager
  // (a second _texCache entry, keyed by its own url/name) and is drawn as
  // translucent chunk cubes over the base, instead of being resliced onto the
  // base grid. Null when no such overlay is present (base path unchanged).
  private _activeOverlayChunked: ChunkedTexEntry | null = null
  // Streamed combined overlays (strategy A): overlays that carry a chunkSource
  // and are co-registered at the base grid. Each becomes a chunked entry whose
  // plan matches the base (chunk i covers base chunk i), streams via the pump,
  // and feeds the base block's overlay slot (binding 5) — so the base
  // ray-march, clip plane, and compositing are reused unchanged.
  private _combinedOverlayEntries: ChunkedTexEntry[] = []
  // Coarse whole-volume "floor" texture for the active base. On 2D slices it is
  // drawn as one full-coverage quad behind the resident fine chunks, so a deep-
  // zoom slice never blanks while finer chunks stream — coarse detail shows
  // immediately and sharpens as chunks arrive. Oriented once from a coarse
  // pyramid level the app supplies (niivue stays LOD-agnostic). Null when unset.
  coarseFloorTexture: GPUTexture | null = null
  // Gradient for the coarse floor, used by the 3D ray-march floor cubes for
  // matcap lighting consistent with the resident fine chunks. Null when unset.
  coarseFloorGradientTexture: GPUTexture | null = null
  // Cached bind group for the 3D floor cubes (coarse texture + gradient +
  // placeholders). Reused for every missing chunk; reset when the floor or
  // matcap changes. Per-cube geometry differs only via the uniform offset.
  private _floorBindGroup: GPUBindGroup | null = null
  private _coarseFloorKey: string | null = null
  // Wall-clock stamp captured once per frame in beginChunkFrame, so every chunk
  // draw in the frame measures fade age against the same instant.
  private _frameNow = 0
  // Set true during a frame whenever a chunk drew mid cross-fade, so the view
  // schedules a follow-up frame to keep the fade animating to completion.
  private _fadeActive = false
  // True while pumpChunkUploads has an async upload in flight. Guards against
  // re-entrant pumps double-uploading a chunk that is queued but not yet
  // admitted (admit clears the queue, so one pump at a time stays correct).
  private _pumpInFlight = false
  private _bindGroupSharedKey: {
    matcap: GPUTexture | null
    overlay: GPUTexture | null
    paqd: GPUTexture | null
    draw: GPUTexture | null
    lut: GPUTexture | null
  } = { matcap: null, overlay: null, paqd: null, draw: null, lut: null }

  constructor() {
    super()
    this.pipeline = null
    this.pipelineChunked = null
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
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindLayout],
      }),
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

    this.pipelineChunked = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindLayout],
      }),
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

    this.isReady = true
  }

  async updateVolume(
    device: GPUDevice,
    vol: NVImage,
    matcap: string = '',
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

    const cacheKey = vol.url || vol.name

    if (forcedPlan || oversized) {
      const chunkedEntry = await this._ensureChunkedVolumeEntry(
        device,
        vol,
        this._chunkResidencyBytes,
      )
      this._activeChunked = chunkedEntry
      this._activeVolKey = cacheKey || null
      this.volumeTexture =
        chunkedEntry.manager.getChunk(0)?.volumeTexture ?? null
      this.volumeGradientTexture =
        chunkedEntry.manager.getChunk(0)?.volumeGradientTexture ?? null
      await this._ensureMatcap(device, matcap)
      return
    }

    let entry = cacheKey ? this._texCache.get(cacheKey) : undefined
    if (entry && entry.kind !== 'single') {
      this._destroyTexEntry(entry)
      entry = undefined
    }
    if (!entry) {
      const mtx = NVTransforms.calculateOverlayTransformMatrix(vol, vol)
      const volumeTexture = await orient.volume2Texture(
        device,
        vol,
        vol,
        mtx as Float32Array,
        0,
      )
      const volumeGradientTexture = await wgpu.volume2TextureGradientRGBA(
        device,
        volumeTexture,
      )
      entry = { kind: 'single', volumeTexture, volumeGradientTexture }
      if (cacheKey) this._texCache.set(cacheKey, entry)
    }
    this._activeChunked = null
    this.volumeTexture = entry.volumeTexture
    this.volumeGradientTexture = entry.volumeGradientTexture
    this._activeVolKey = cacheKey || null

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
   * Halo is 3 (not the [1,1,1] default): the per-chunk gradient runs a sobel
   * (radius 1) + blur (radius 1) stencil, and trilinear sampling at the data
   * edge reaches one voxel further, so the gradient is only seam-free between
   * chunks with a 3-voxel halo.
   */
  private async _ensureChunkedVolumeEntry(
    device: GPUDevice,
    vol: NVImage,
    budgetBytes: number,
    onResidencyChange?: (chunkIndex: number) => void,
  ): Promise<ChunkedTexEntry> {
    const srcDims: Vec3i = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
    const rasDims: Vec3i = vol.dimsRAS
      ? [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
      : srcDims
    const limit = this.maxTextureDimension3D
    const plan = vol.chunkPlan ?? chunkVolume(rasDims, limit, [3, 3, 3])
    vol.chunkPlan = plan
    const bpv = bytesPerSourceVoxel(vol.hdr.datatypeCode) || 4
    const budget = estimateChunkedBytes(plan, bpv)
    log.warn(
      `Volume ${vol.name} (${rasDims.join('x')}) exceeds ` +
        `maxTextureDimension3D=${limit}. Chunk plan: ` +
        `${plan.gridDims.join('x')} = ${budget.chunkCount} chunks, ` +
        `~${formatBytes(budget.totalBytes)} GPU memory ` +
        `(${formatBytes(budget.scalarBytes)} scalar + ` +
        `${formatBytes(budget.rgbaBytes)} RGBA + ` +
        `${formatBytes(budget.gradientBytes)} gradient).`,
    )
    if (plan.chunks.length > MAX_CHUNKS_PER_TILE) {
      throw new Error(
        `Volume ${vol.name} tiles into ${plan.chunks.length} chunks, ` +
          `exceeding the per-tile limit of ${MAX_CHUNKS_PER_TILE}. ` +
          `Use a coarser pyramid level or crop the volume.`,
      )
    }
    const cacheKey = vol.url || vol.name
    const existing = cacheKey ? this._texCache.get(cacheKey) : undefined
    if (existing && existing.kind === 'chunked') {
      existing.volume = vol
      return existing
    }
    if (existing) this._destroyTexEntry(existing)
    const uploader = await createChunkUploaderGPU(device, vol, plan)
    // Per-chunk bind groups, indexed by chunk index. Hoisted above the manager
    // so the onEvict hook can null the slot of an evicted chunk — a re-admitted
    // chunk gets a fresh texture, so its old bind group would dangle.
    const bindGroups: (GPUBindGroup | null)[] = plan.chunks.map(() => null)
    const manager = new ChunkResidencyManager<VolumeChunkGPU>(
      plan.chunks.length,
      budgetBytes,
      {
        bytesOf: chunkResidentBytes,
        destroy: (c) => destroyVolumeChunksGPU([c]),
        onEvict: (ci) => {
          bindGroups[ci] = null
          onResidencyChange?.(ci)
        },
        prefetch: (ci) => uploader.prefetchChunk(ci),
        onAdmit: onResidencyChange,
      },
    )
    manager.admit(0, await uploader.uploadChunk(0))
    const entry: ChunkedTexEntry = {
      kind: 'chunked',
      volume: vol,
      manager,
      uploader,
      plan,
      bindGroups,
    }
    if (cacheKey) this._texCache.set(cacheKey, entry)
    return entry
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
      const newTex = await wgpu.bitmap2textureOrFallback(device, matcap)
      if (this.matcapTexture) this.matcapTexture.destroy()
      this.matcapTexture = newTex
      this._matcapUrl = matcap
      this._invalidateBindGroupCache()
    }
  }

  /**
   * Switch the active volume/gradient textures to the cache entry for
   * `cacheKey` (a volume url or name). Used per-tile by global3d rendering
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
      this.volumeTexture = entry.manager.getChunk(0)?.volumeTexture ?? null
      this.volumeGradientTexture =
        entry.manager.getChunk(0)?.volumeGradientTexture ?? null
      return true
    }
    this._activeChunked = null
    this.volumeTexture = entry.volumeTexture
    this.volumeGradientTexture = entry.volumeGradientTexture
    const cached = this._bindGroupCache.get(cacheKey)
    if (cached) {
      this.bindGroup = cached
      this._bindTexVol = entry.volumeTexture
      this._bindTexGrad = entry.volumeGradientTexture
    }
    return true
  }

  /**
   * When the active volume is chunked, expose its plan and per-chunk color
   * textures so the 2D slice renderer can draw one in-plane-restricted quad
   * per chunk. Returns null for single-texture volumes.
   */
  getActiveChunkedSlice(): {
    plan: ChunkPlan
    chunkTextures: (GPUTexture | null)[]
    overlayChunks: GPUTexture[] | null
    paqdChunks: GPUTexture[] | null
  } | null {
    if (!this._activeChunked) return null
    const { manager } = this._activeChunked
    const chunkCount = manager.chunkCount
    // Indexed by chunk index; null for chunks not yet streamed in. The slice
    // loop skips nulls — a transient gap rather than a hole, since the pump
    // fills them within a few frames.
    const chunkTextures: (GPUTexture | null)[] = []
    for (let i = 0; i < chunkCount; i++) {
      chunkTextures.push(manager.getChunk(i)?.volumeTexture ?? null)
    }
    return {
      plan: this._activeChunked.plan,
      chunkTextures,
      // A streamed combined overlay (strategy A) feeds the slice overlay slot
      // from its resident chunks (transparent placeholder until each streams
      // in); otherwise the whole-reslice overlayChunks apply.
      overlayChunks:
        this._combinedOverlaySliceChunks(chunkCount) ??
        (this.overlayChunks && this.overlayChunks.length === chunkCount
          ? this.overlayChunks
          : null),
      paqdChunks:
        this.paqdChunks && this.paqdChunks.length === chunkCount
          ? this.paqdChunks
          : null,
    }
  }

  /**
   * Per-chunk overlay textures for the active streamed combined overlay, sized
   * to the base chunk count, with the transparent placeholder where a chunk is
   * not yet resident. Null when no single combined overlay is active.
   */
  private _combinedOverlaySliceChunks(chunkCount: number): GPUTexture[] | null {
    if (this._combinedOverlayEntries.length !== 1 || !this.placeholderOverlay) {
      return null
    }
    const entry = this._combinedOverlayEntries[0]
    if (entry.manager.chunkCount !== chunkCount) return null
    const placeholder = this.placeholderOverlay
    const out: GPUTexture[] = []
    for (let i = 0; i < chunkCount; i++) {
      out.push(entry.manager.getChunk(i)?.volumeTexture ?? placeholder)
    }
    return out
  }

  /**
   * Streaming cross-fade weight in [0,1] for one chunk of the active chunked
   * base, for the 2D slice path: ramps 0->1 over CHUNK_FADE_MS from admit, so a
   * fine chunk slice dissolves in over the coarse floor instead of popping.
   * Returns 1 (no fade) when there is no floor to dissolve into or no active
   * chunked base. Flags fadeActive while a chunk is mid-fade so the view keeps
   * re-rendering to animate it.
   */
  activeChunkedSliceFade(chunkIndex: number): number {
    if (!this._activeChunked || this.coarseFloorTexture === null) return 1
    const fade = this._activeChunked.manager.fadeFraction(
      chunkIndex,
      this._frameNow,
      CHUNK_FADE_MS,
    )
    if (fade < 1) this._fadeActive = true
    return fade
  }

  /**
   * Phase 3c: queue the active chunked volume's chunks for streaming upload.
   * `requestUpload` is idempotent — already-resident or already-queued chunks
   * are skipped — so the view may call this every frame with a tile's working
   * set. No-op when the active volume is not chunked.
   */
  requestVisibleChunks(chunkIndices: readonly number[]): void {
    const entry = this._activeChunked
    if (!entry) return
    for (const ci of chunkIndices) entry.manager.requestUpload(ci)
  }

  /**
   * When an independently-streamed hi-res overlay is active, expose its plan
   * and per-chunk color textures so the 2D slice renderer can draw one
   * in-plane-restricted quad per overlay chunk. Returns null when no such
   * overlay is present.
   */
  getActiveOverlayChunkedSlice(): {
    plan: ChunkPlan
    chunkTextures: (GPUTexture | null)[]
  } | null {
    const entry = this._activeOverlayChunked
    if (!entry) return null
    const chunkTextures: (GPUTexture | null)[] = []
    for (let i = 0; i < entry.manager.chunkCount; i++) {
      chunkTextures.push(entry.manager.getChunk(i)?.volumeTexture ?? null)
    }
    return { plan: entry.plan, chunkTextures }
  }

  /**
   * Phase 3c: frustum-cull the active chunked volume against a 3D render
   * tile's MVP and queue the visible chunks for streaming. No-op when the
   * active volume is not chunked.
   */
  requestChunksInFrustum(
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
    clipPlanes: number[],
    isCutaway: boolean,
  ): void {
    this._requestChunksInFrustum(
      this._activeChunked,
      mvp,
      matRAS,
      clipPlanes,
      isCutaway,
      // Streamed combined overlays share the base grid, so mirror the base's
      // visible working set onto their managers (same chunk indices).
      this._combinedOverlayEntries.map((e) => e.manager),
    )
  }

  /**
   * Same frustum-driven working set for the independently-streamed hi-res
   * overlay. The overlay is culled against its OWN plan + matRAS but the same
   * scene MVP (shared camera). No-op when no chunked overlay is active.
   */
  requestOverlayChunksInFrustum(
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
    clipPlanes: number[],
    isCutaway: boolean,
  ): void {
    this._requestChunksInFrustum(
      this._activeOverlayChunked,
      mvp,
      matRAS,
      clipPlanes,
      isCutaway,
    )
  }

  private _requestChunksInFrustum(
    entry: ChunkedTexEntry | null,
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
    clipPlanes: number[],
    isCutaway: boolean,
    mirrors: ChunkResidencyManager<VolumeChunkGPU>[] = [],
  ): void {
    if (!entry) return
    // Exploded view: the whole plan is the working set. Explode spreads the
    // blocks apart (often beyond the framed extent), so a frustum cull would
    // drop the blocks that pan off the viewport edges during a rotate; the LRU
    // would then evict them and the 1-chunk/frame pump cannot refill them
    // before the next drag frame, so they visibly blink out. Stamping every
    // chunk each frame keeps them all resident (eviction never drops a chunk
    // touched this frame) so the separated blocks stay put while the camera
    // moves. An exploded render is a deliberate "show all blocks" view, so
    // requesting them all matches intent.
    if (chunkExplodeEnabled(entry.volume.chunkExplode)) {
      for (let ci = 0; ci < entry.plan.chunks.length; ci++) {
        entry.manager.requestUpload(ci)
        for (const m of mirrors) m.requestUpload(ci)
      }
      return
    }
    const offset = chunkOffsetFor(entry.plan, entry.volume.chunkExplode)
    const visible = chunksInFrustum(
      entry.plan,
      mvp,
      CLIP_SPACE_ZERO_TO_ONE,
      matRAS,
      offset,
    )
    // Drop chunks a clip plane removes entirely from the cutaway, so we never
    // stream blocks the 3D render hides.
    const unclipped = chunksNotClippedOut(
      entry.plan,
      visible,
      clipPlanes,
      isCutaway,
      offset,
    )
    // Stream the centre of the view first, then spiral outward. Streamed
    // combined overlays share the base grid, so the same indices apply.
    const ordered = orderByViewCenter(
      entry.plan,
      unclipped,
      mvp,
      matRAS,
      offset,
    )
    // Cap the working set to what the residency budget can hold. A full-volume
    // render makes every visible chunk needed-this-frame, so eviction can't drop
    // any of them; without a cap the resident set grows to the entire visible
    // set and exhausts GPU memory (lost device). Streaming only the most
    // view-central chunks that fit keeps memory bounded — the coarse floor
    // covers the rest.
    const cap = maxChunksForBudget(
      entry.plan,
      bytesPerSourceVoxel(entry.volume.hdr.datatypeCode),
      entry.manager.budgetBytes,
    )
    for (const ci of ordered.slice(0, cap)) {
      entry.manager.requestUpload(ci)
      for (const m of mirrors) m.requestUpload(ci)
    }
  }

  /**
   * Queue a 2D-slice working set, viewport-bounded: of the chunks the slice
   * plane crosses (`crossing`), request only those also inside the slice tile's
   * ortho frustum. Without this, a depth-1 volume (every chunk crosses the one
   * axial plane) would stream the whole level; with it, only the on-screen
   * tiles stream — so a gigapixel slide pans at full resolution within budget.
   * Falls back to all `crossing` for an exploded view (intent: show all blocks).
   */
  requestVisibleChunksInView(
    crossing: readonly number[],
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
  ): void {
    this._requestVisibleChunksInView(
      this._activeChunked,
      crossing,
      mvp,
      matRAS,
      // Streamed combined overlays share the base grid — mirror the slice
      // working set so the overlay streams alongside the base on 2D slices too.
      this._combinedOverlayEntries.map((e) => e.manager),
    )
  }

  /** 2D-slice working set for the independently-streamed hi-res overlay. */
  requestOverlayVisibleChunksInView(
    crossing: readonly number[],
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
  ): void {
    this._requestVisibleChunksInView(
      this._activeOverlayChunked,
      crossing,
      mvp,
      matRAS,
    )
  }

  private _requestVisibleChunksInView(
    entry: ChunkedTexEntry | null,
    crossing: readonly number[],
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
    mirrors: ChunkResidencyManager<VolumeChunkGPU>[] = [],
  ): void {
    if (!entry) return
    if (chunkExplodeEnabled(entry.volume.chunkExplode)) {
      for (const ci of crossing) {
        entry.manager.requestUpload(ci)
        for (const m of mirrors) m.requestUpload(ci)
      }
      return
    }
    const offset = chunkOffsetFor(entry.plan, entry.volume.chunkExplode)
    const inView = new Set(
      chunksInFrustum(entry.plan, mvp, CLIP_SPACE_ZERO_TO_ONE, matRAS, offset),
    )
    const visible = crossing.filter((ci) => inView.has(ci))
    // Stream the centre of the view first, then spiral outward, capped to what
    // the residency budget can hold (see _requestChunksInFrustum).
    const ordered = orderByViewCenter(entry.plan, visible, mvp, matRAS, offset)
    const cap = maxChunksForBudget(
      entry.plan,
      bytesPerSourceVoxel(entry.volume.hdr.datatypeCode),
      entry.manager.budgetBytes,
    )
    for (const ci of ordered.slice(0, cap)) {
      entry.manager.requestUpload(ci)
      for (const m of mirrors) m.requestUpload(ci)
    }
  }

  /**
   * Phase 3d: advance every chunked volume's LRU clock. Must be called once at
   * the start of each frame, before the view requests its working set, so
   * working-set `requestUpload` calls stamp the current frame and a same-frame
   * eviction in `pumpChunkUploads` cannot drop a visible chunk.
   */
  beginChunkFrame(): void {
    this._frameNow = performance.now()
    this._fadeActive = false
    for (const entry of this._texCache.values()) {
      if (entry.kind === 'chunked') entry.manager.beginFrame()
    }
  }

  /**
   * True if any chunk drew mid cross-fade in the last frame. The view ORs this
   * into its follow-up-frame decision so a fade animates to completion even
   * when no further chunks are streaming in.
   */
  get fadeActive(): boolean {
    return this._fadeActive
  }

  /**
   * Stream in queued chunks for every cached chunked volume — the per-frame
   * upload pump. Uploads chunks round-robin across chunked volumes (one per
   * volume per round, so base and overlay fill together) until the wall-clock
   * budget `CHUNK_UPLOAD_BUDGET_MS` or the cap `MAX_CHUNK_UPLOADS_PER_FRAME` is
   * reached, then `admit`s them. Returns true if any chunk was admitted, so the
   * view can schedule a follow-up frame to present the newly-resident data and
   * keep the pump going. A single pump runs at a time: a re-entrant call while
   * an async upload is in flight returns false immediately.
   */
  async pumpChunkUploads(): Promise<boolean> {
    if (this._pumpInFlight) return false
    this._pumpInFlight = true
    let admitted = false
    let uploaded = 0
    const start = performance.now()
    try {
      // Kick off source fetches for the upcoming working set so they run in
      // parallel ahead of the serial upload below. prefetchChunk is idempotent
      // and self-bounded, so topping up the window every pump keeps it full as
      // uploads drain it.
      for (const entry of this._texCache.values()) {
        if (entry.kind !== 'chunked') continue
        for (const ci of entry.manager.peekPendingUploads(
          CHUNK_PREFETCH_WINDOW,
        ))
          entry.uploader.prefetchChunk(ci)
      }
      // Round-robin: each pass takes at most one queued chunk from each chunked
      // entry, so a busy base does not starve the overlay (and vice versa).
      let progressed = true
      while (
        progressed &&
        uploaded < MAX_CHUNK_UPLOADS_PER_FRAME &&
        performance.now() - start < CHUNK_UPLOAD_BUDGET_MS
      ) {
        progressed = false
        for (const entry of this._texCache.values()) {
          if (entry.kind !== 'chunked') continue
          if (
            uploaded >= MAX_CHUNK_UPLOADS_PER_FRAME ||
            performance.now() - start >= CHUNK_UPLOAD_BUDGET_MS
          )
            break
          const indices = entry.manager.takePendingUploads(1)
          if (indices.length === 0) continue
          const i = indices[0]
          try {
            entry.manager.admit(i, await entry.uploader.uploadChunk(i))
          } catch (err) {
            // Isolate a single chunk's failure: mark it failed and keep pumping.
            // failUpload clears the in-flight marker so a later working-set pass
            // re-enqueues it. Rethrowing would reject the whole pump and stop the
            // view's self-driven re-render loop, freezing all streaming until an
            // unrelated redraw (e.g. a drag) re-kicks it.
            entry.manager.failUpload(i)
            log.error('chunk upload failed', err)
            continue
          }
          admitted = true
          uploaded++
          progressed = true
        }
      }
    } finally {
      this._pumpInFlight = false
    }
    return admitted
  }

  /** Release the GPU textures backing a single cache entry. */
  private _destroyTexEntry(entry: TexCacheEntry): void {
    if (entry.kind === 'chunked') {
      entry.manager.destroy()
      entry.uploader.dispose()
      if (this._activeChunked === entry) this._activeChunked = null
      if (this._activeOverlayChunked === entry)
        this._activeOverlayChunked = null
      const ci = this._combinedOverlayEntries.indexOf(entry)
      if (ci >= 0) this._combinedOverlayEntries.splice(ci, 1)
    } else {
      entry.volumeTexture.destroy()
      entry.volumeGradientTexture.destroy()
    }
  }

  /** Release any cached volume textures whose key is not in `keepKeys`. */
  pruneVolumeCache(keepKeys: Set<string>): void {
    for (const [key, entry] of this._texCache) {
      if (keepKeys.has(key)) continue
      this._destroyTexEntry(entry)
      this._texCache.delete(key)
      this._bindGroupCache.delete(key)
    }
  }

  private _invalidateBindGroupCache(): void {
    this._bindGroupCache.clear()
    this._floorBindGroup = null
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

    // Filter out overlays with zero opacity
    const visible = overlayVols.filter((v) => (v.opacity ?? 1) > 0)
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
      await this._updateOverlayChunkedIndependent(device, independentVols[0])
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
      const streamedCombined = reslicedVols.filter(
        (v) => v.chunkSource && this._dimsMatchBase(v, baseVol),
      )
      const wholeReslice = reslicedVols.filter(
        (v) => !(v.chunkSource && this._dimsMatchBase(v, baseVol)),
      )
      await this._updateCombinedOverlayChunked(device, streamedCombined)
      await this._updateOverlayChunks(
        device,
        baseVol,
        baseVol.chunkPlan,
        wholeReslice,
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
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        this.clearOverlay()
        this.overlayTexture = await orient.volume2Texture(
          device,
          vol,
          baseVol,
          mtx as Float32Array,
          vol.opacity ?? 1,
        )
        return
      }
      this.destroyNonCachedOverlayTexture()
      this.overlayOrientCache = await orient.prepareOrientTextureCache(
        device,
        vol,
        baseVol,
        mtx as Float32Array,
        vol.opacity ?? 1,
        this.overlayOrientCache,
      )
      orient.dispatchOrient(device, this.overlayOrientCache)
      this.overlayTexture = this.overlayOrientCache.outputTexture
    } else if (inMem.length > 1) {
      this.destroyNonCachedOverlayTexture()
      orient.destroyOrientTextureCache(this.overlayOrientCache)
      this.overlayOrientCache = null
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
          ),
        )
      }
      this.destroyNonCachedOverlayTexture()
      this.overlayTexture = await orient.blendOverlaysGPU(
        device,
        overlayTextures,
        dimsOut,
      )
      for (const tex of overlayTextures) tex.destroy()
    }
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
    )
    orient.dispatchOrient(device, this.overlayOrientCache)
    this.overlayTexture = this.overlayOrientCache.outputTexture
    return true
  }

  private destroyNonCachedOverlayTexture(): void {
    if (
      this.overlayTexture &&
      this.overlayTexture !== this.overlayOrientCache?.outputTexture
    ) {
      this.overlayTexture.destroy()
    }
    this.overlayTexture = null
  }

  clearOverlay(): void {
    this.destroyNonCachedOverlayTexture()
    orient.destroyOrientTextureCache(this.overlayOrientCache)
    this.overlayOrientCache = null
    this._destroyOverlayChunks()
    this.clearOverlayChunked()
    this._clearCombinedOverlayChunked()
    this._invalidateBindGroupCache()
  }

  /**
   * Build (or reuse) the independent chunked entry for a hi-res streamed
   * overlay and mark it active. The entry lives in _texCache under the
   * overlay's own key, so the per-frame pump streams it alongside the base.
   * Drawn as translucent chunk cubes over the base in _drawOverlayChunked.
   */
  private async _updateOverlayChunkedIndependent(
    device: GPUDevice,
    vol: NVImage,
  ): Promise<void> {
    // Split the single configured residency budget: the overlay gets a share,
    // the base keeps the rest, so base + overlay together stay within the
    // configured cap instead of each filling it.
    const overlayBudget = this._chunkResidencyBytes * OVERLAY_RESIDENCY_FRACTION
    const entry = await this._ensureChunkedVolumeEntry(
      device,
      vol,
      overlayBudget,
    )
    // Apply the split even when the entry was reused from the cache (its
    // manager may have been built with a different budget).
    entry.manager.setBudgetBytes(overlayBudget)
    this._activeOverlayChunked = entry
    if (this._activeChunked && this._activeChunked !== entry) {
      this._activeChunked.manager.setBudgetBytes(
        this._chunkResidencyBytes * (1 - OVERLAY_RESIDENCY_FRACTION),
      )
    }
    this._invalidateBindGroupCache()
  }

  /**
   * Forget the active independent chunked overlay. The cache entry itself is
   * left in _texCache for reuse / normal pruneVolumeCache lifecycle; only the
   * active pointer is cleared so it is no longer drawn or requested. The base
   * reclaims the full residency budget the overlay had been sharing.
   */
  clearOverlayChunked(): void {
    this._activeOverlayChunked = null
    this._activeChunked?.manager.setBudgetBytes(this._chunkResidencyBytes)
  }

  hasOverlayChunked(): boolean {
    return this._activeOverlayChunked !== null
  }

  /** Whether an overlay is co-registered at the base grid (same RAS dims). */
  private _dimsMatchBase(vol: NVImage, baseVol: NVImage): boolean {
    const a = vol.dimsRAS
    const b = baseVol.dimsRAS
    return !!a && !!b && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
  }

  /**
   * Strategy A: build (or reuse) a base-aligned chunked entry for each streamed
   * combined overlay (a chunkSource overlay co-registered at the base grid).
   * They stream via the per-frame pump and feed the base block's overlay slot,
   * so the base ray-march / clip plane / compositing are reused unchanged. The
   * onResidencyChange hook invalidates the base chunk's bind group when an
   * overlay chunk arrives or is evicted, so binding 5 tracks residency.
   */
  private async _updateCombinedOverlayChunked(
    device: GPUDevice,
    vols: NVImage[],
  ): Promise<void> {
    this._combinedOverlayEntries = []
    if (vols.length === 0) return
    // Split the configured budget: overlays share OVERLAY_RESIDENCY_FRACTION
    // between them, the base keeps the rest.
    const overlayBudget =
      (this._chunkResidencyBytes * OVERLAY_RESIDENCY_FRACTION) / vols.length
    for (const vol of vols) {
      const entry = await this._ensureChunkedVolumeEntry(
        device,
        vol,
        overlayBudget,
        (ci) => {
          const base = this._activeChunked
          if (base) base.bindGroups[ci] = null
        },
      )
      entry.manager.setBudgetBytes(overlayBudget)
      this._combinedOverlayEntries.push(entry)
    }
    if (this._activeChunked) {
      this._activeChunked.manager.setBudgetBytes(
        this._chunkResidencyBytes * (1 - OVERLAY_RESIDENCY_FRACTION),
      )
    }
    this._invalidateBindGroupCache()
  }

  /** Forget the streamed combined overlays; base reclaims the full budget. */
  private _clearCombinedOverlayChunked(): void {
    if (this._combinedOverlayEntries.length === 0) return
    this._combinedOverlayEntries = []
    this._activeChunked?.manager.setBudgetBytes(this._chunkResidencyBytes)
    this._invalidateBindGroupCache()
  }

  /** The NVImage backing the active independent chunked overlay (or null). */
  getOverlayChunkedVolume(): NVImage | null {
    return this._activeOverlayChunked?.volume ?? null
  }

  /**
   * Aggregate streaming stats across all chunked volumes (base + overlay), for
   * HUD / debug instrumentation. `resident` is bricks currently on the GPU,
   * `pending` queued for upload, `inFlight` mid-upload, `total` the chunk count.
   */
  chunkStreamStats(): {
    resident: number
    pending: number
    inFlight: number
    total: number
  } {
    let resident = 0
    let pending = 0
    let inFlight = 0
    let total = 0
    for (const entry of this._texCache.values()) {
      if (entry.kind !== 'chunked') continue
      resident += entry.manager.residentCount
      pending += entry.manager.pendingUploadCount
      inFlight += entry.manager.inFlightUploadCount
      total += entry.manager.chunkCount
    }
    return { resident, pending, inFlight, total }
  }

  /**
   * Drop the resident bricks of every streamed overlay (the base-aligned combined
   * overlays and an independent hi-res overlay), leaving the base volume resident.
   * The next frame re-requests and re-bakes only the overlay blocks in the current
   * view frustum, picking up the overlays' current `opacity` (and any chunkSource
   * whose output changed). Lets a changed overlay opacity apply without a full
   * volume reload.
   */
  rebakeChunkedOverlays(): void {
    for (const entry of this._combinedOverlayEntries) entry.manager.destroy()
    this._activeOverlayChunked?.manager.destroy()
    this._invalidateBindGroupCache()
  }

  /**
   * Build one RGBA8 overlay texture per chunk for a chunked oversized volume.
   * The overlay layer shares the background volume's ChunkPlan, so the chunk
   * textures align 1:1 with the volume chunks. A single overlay is oriented
   * directly per chunk; multiple overlays are oriented per chunk and blended
   * on the GPU (mirroring the non-chunked multi-overlay path).
   *
   * RGB/RGBA-datatype overlays are skipped on chunked volumes (the chunked
   * orient pass only supports scalar sources, matching the volume chunker).
   */
  private async _updateOverlayChunks(
    device: GPUDevice,
    baseVol: NVImage,
    plan: ChunkPlan,
    standardVols: NVImage[],
  ): Promise<void> {
    // Chunked overlay path: drop the single-texture representation.
    this.destroyNonCachedOverlayTexture()
    orient.destroyOrientTextureCache(this.overlayOrientCache)
    this.overlayOrientCache = null
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

    if (supported.length === 1) {
      this.overlayChunks = await orient.overlay2TextureChunked(
        device,
        supported[0],
        baseVol,
        mtxs[0],
        plan,
        supported[0].opacity ?? 1,
      )
      this._invalidateBindGroupCache()
      return
    }

    // Multiple overlays: orient + GPU-blend per chunk.
    const [dx, dy, dz] = plan.volumeDims
    const finals: GPUTexture[] = []
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
          ),
        )
      }
      finals.push(
        await orient.blendOverlaysGPU(device, layers, [
          dims[0],
          dims[1],
          dims[2],
        ]),
      )
      for (const tex of layers) tex.destroy()
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

    if (!this.volumeTexture || !this.volumeGradientTexture) return

    if (
      this.bindGroup &&
      this._bindTexVol === this.volumeTexture &&
      this._bindTexGrad === this.volumeGradientTexture &&
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
        { binding: 4, resource: this.volumeGradientTexture.createView() },
        { binding: 5, resource: overlayTex.createView() },
        { binding: 6, resource: paqdTex.createView() },
        { binding: 7, resource: drawTex.createView() },
        { binding: 8, resource: this.samplerNearest },
        { binding: 9, resource: paqdLutTex.createView() },
      ],
    })
    this._bindTexVol = this.volumeTexture
    this._bindTexGrad = this.volumeGradientTexture
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
      },
    )

    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup, [renderOffset])
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint16')
    pass.drawIndexed(this.cube.indices.length)
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
    earlyTermination: number,
  ): void {
    if (
      !entry ||
      !this.pipelineChunked ||
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
    const combinedOverlay =
      !overlayMode &&
      entry === this._activeChunked &&
      this._combinedOverlayEntries.length === 1
        ? this._combinedOverlayEntries[0]
        : null

    const explode = entry.volume.chunkExplode
    const order = chunksBackToFront(
      entry.plan,
      rayDir,
      chunkOffsetFor(entry.plan, explode),
      volScale,
    )

    pass.setPipeline(this.pipelineChunked)
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
        },
        0,
      )
      pass.setBindGroup(0, this._floorBindGroup, [floorRenderOffset])
      pass.drawIndexed(this.cube.indices.length)
    }

    for (let slot = 0; slot < order.length; slot++) {
      const chunkIndex = order[slot]
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
        ? entry.manager.fadeFraction(chunkIndex, this._frameNow, CHUNK_FADE_MS)
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
              resource: (combinedOverlay
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
        chunkUniformsFor(entry.plan, chunkIndex),
        overlayMode ? 1 : 0,
        fade,
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
        // earlyTermination); the following _pad0: vec3f aligns to 384. These 7
        // floats advance the byte cursor 372 → 400 (to the next vec4f), unchanged.
        this.clipPlaneOverlay ? 1.0 : 0.0,
        // fadeAlpha (lane after clipPlaneOverlay): streaming cross-fade weight.
        fadeAlpha,
        0,
        0,
        0,
        0,
        0,
        ...chunkUniforms.volumeTexDimsFull,
        1,
        ...chunkUniforms.chunkSubOrigin,
        1,
        ...chunkUniforms.chunkSubSize,
        1,
        ...chunkUniforms.dataOriginTexFrac,
        1,
        ...chunkUniforms.dataSizeTexFrac,
        1,
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
   * when the source/colormap/window changes.
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
      this._coarseFloorKey = null
      return
    }
    const key = `${coarseVol.url || coarseVol.name}|${coarseVol.colormap}|${coarseVol.calMin}|${coarseVol.calMax}`
    if (key === this._coarseFloorKey && this.coarseFloorTexture) return
    // Orient the coarse level into its own (small) RGBA grid. It shares the base
    // volume's mm box, so the slice can sample it at the base's texture fraction.
    const mtx = NVTransforms.calculateOverlayTransformMatrix(
      coarseVol,
      coarseVol,
    )
    const tex = await orient.volume2Texture(
      device,
      coarseVol,
      coarseVol,
      mtx as Float32Array,
      1,
    )
    // Gradient for the 3D floor cubes' matcap lighting (matches base shading).
    const grad = await wgpu.volume2TextureGradientRGBA(device, tex)
    this.coarseFloorTexture?.destroy()
    this.coarseFloorGradientTexture?.destroy()
    this.coarseFloorTexture = tex
    this.coarseFloorGradientTexture = grad
    this._coarseFloorKey = key
  }

  hasVolume(): boolean {
    return this._activeChunked !== null || this.volumeTexture !== null
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
