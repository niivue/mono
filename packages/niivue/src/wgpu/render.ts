import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVShapes from '@/mesh/NVShapes'
import {
  invGamma,
  isPaqd,
  lodGammaExponent,
  lodOpacityScale,
  SCENE_DEFAULTS,
  VOLUME_DEFAULTS,
} from '@/NVConstants'
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
  chunkIndicesForResidentBudget,
  estimateChunkedBytes,
  formatBytes,
} from '@/volume/chunkBudget'
import {
  type ChunkPlan,
  chunkLodDownsample,
  chunkOwnedTexBox,
  chunkVolume,
  dimsDownsample,
  matchChunksByContent,
  needsChunking,
  planSupportsCubic,
  type Vec3i,
  warnIfCubicUnsafe,
} from '@/volume/chunking'
import { ChunkTravelPredictor } from '@/volume/chunkPrediction'
import {
  DecodedChunkCache,
  type DecodedChunkStats,
  decodedTierBudgetBytes,
} from '@/volume/decodedChunkCache'
import { buildModulationParams } from '@/volume/modulation'
import {
  chunkedDisplayKey,
  chunkOverlayMatrix,
  extractChunkBytes,
} from '@/volume/orientChunked'
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
 * set (RGBA + gradient across resident chunks; scalar upload textures are
 * transient). Picked to fit comfortably below a typical 4 GiB discrete-GPU
 * budget while leaving headroom for overlays, fonts, and other resident
 * textures. Overridable per instance via the `maxChunkResidencyBytes` option —
 * the ChunkResidencyManager evicts least-recently-visible chunks to keep the
 * resident set within budget.
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
 * How many predicted chunks a chunked volume may have on speculative fetch at
 * once. Small on purpose: the prediction is served from whatever fetch slots
 * the working set left over, so a wrong guess costs a few reads, never a
 * visible chunk's place in the queue.
 */
const CHUNK_PREDICT_WINDOW = 4
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
  /** Full volume RAS dims in the COMMON grid (vertex placement + frac2ndc). */
  volumeTexDimsFull: Vec3f
  /** Chunk's sub-cube origin in the full-volume [0,1] cube. */
  chunkSubOrigin: Vec3f
  /** Chunk's sub-cube size in the full-volume [0,1] cube. */
  chunkSubSize: Vec3f
  /** Halo offset in the chunk's local texture (skips low-side halo). */
  dataOriginTexFrac: Vec3f
  /** Data extent in the chunk's local texture (excludes halo on both sides). */
  dataSizeTexFrac: Vec3f
  /**
   * Full-volume voxel dims at THIS brick's source pyramid level, used solely for
   * the ray-march step density (one step ≈ one source-level voxel across the
   * full cube). Equals `volumeTexDimsFull` for single-level/non-chunked draws;
   * coarser for multi-LOD bricks so they step (and sample) at their own
   * resolution instead of being oversampled at the finest density.
   */
  rayStepTexVox: Vec3f
  /**
   * False when this draw reads a brick whose halo is too thin for the tricubic
   * kernel (see planSupportsCubic). The filter is forced off for that draw so
   * it cannot reconstruct from clamp-to-edge data at an internal brick face,
   * which would show as a seam. Defaults to true (non-chunked draws, and the
   * coarse floor, which is one whole-volume texture).
   */
  cubicSafe?: boolean
  /**
   * Linear downsample factor of this brick's source pyramid level relative to
   * the finest grid (see chunkLodDownsample). 1 for single-level plans and
   * non-chunked draws; drives the per-level brightness compensation.
   */
  lodDownsample?: number
}

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
  /**
   * chunkedDisplayKey at uploader creation. Resident chunk textures bake the
   * colormap/window this key captures, so a mismatch on updateVolume forces an
   * uploader rebuild + full re-stream (see _ensureChunkedVolumeEntry).
   */
  displayKey: string
  /** planSupportsCubic(plan), cached: the plan is immutable for the entry's life. */
  cubicSafe: boolean
  /** Tracks how this volume's working set travels across its chunk grid. */
  predictor: ChunkTravelPredictor
  /** Chunk indices this frame's working set asked for, across every tile. */
  requestedThisFrame: number[]
  /** Chunks currently on speculative fetch, so a stale guess can be released. */
  speculative: Set<number>
  /** Speculative fetches started for this volume, cumulative. */
  predictedCount: number
  /**
   * Decoded source bytes for this volume's chunks, so a chunk evicted from the
   * GPU is demoted here instead of destroyed. Owned by the entry rather than
   * the uploader: the bytes outlive an uploader rebuild, and survive a plan
   * swap by being re-keyed alongside the resident chunks.
   */
  decoded: DecodedChunkCache
  /** Source bytes per voxel, which sets what the decoded tier costs to hold. */
  sourceBytesPerVoxel: number
}

/**
 * Set a chunked entry's GPU residency budget, keeping its decoded tier sized
 * against it. The two move together by construction: the tier exists to shadow
 * the resident set, so a share change that shrinks one must shrink the other.
 */
function setChunkBudget(entry: ChunkedTexEntry, bytes: number): void {
  entry.manager.setBudgetBytes(bytes)
  entry.decoded.setMaxBytes(
    decodedTierBudgetBytes(bytes, entry.sourceBytesPerVoxel),
  )
}

type TexCacheEntry = SingleTexEntry | ChunkedTexEntry

// 500 bytes of data = 125 floats:
//   16 mvp + 16 norm + 16 matRAS + 4 volScale + 4 rayDir + 4 (gradient/numVol/cutaway/pad)
//   + 4 clipPlaneColor + 24 clipPlanes + 4 paqd + 8 scalars (earlyTermination,
//     clipPlaneOverlay, fadeAlpha, renderMode, cubicFilter, invGamma,
//     lodOpacityScale, backOpacity). The last four replaced a 2-lane _pad0
//     plus the 2 lanes WGSL was already inserting implicitly to 16-align
//     volumeTexDimsFull, so the group is 8 lanes before and after.
//   + 4 volumeTexDimsFull + 4 chunkSubOrigin + 4 chunkSubSize
//   + 4 dataOriginTexFrac + 4 dataSizeTexFrac + 4 rayStepTexVox
//   + 3 trailing f32 (layerGradMode, gradientOpacity, silhouettePower)
// The constant below is the size the BIND GROUP declares, which must be the
// size WGSL gives the struct, not the byte count we write into it: a trailing
// f32 leaves the struct 16-byte-aligned at 512, and declaring 508 makes every
// render pipeline fail validation -- silently, as a blank canvas on every
// example. 512 is exactly the old alignedRenderSize, so the params buffer does
// not grow and every *_PARAMS_BASE offset below is unchanged.
const renderParamsSize = 512
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
/**
 * Default duration of the streaming-chunk cross-fade between LOD levels, in ms.
 * A chunk admitted this long ago (or longer) draws at full strength; younger
 * chunks dissolve in over the coarse floor, so a plan swap reads as a soften-
 * then-sharpen rather than a hard cut. Overridable per instance with the
 * `chunkFadeMs` option; 0 disables the cross-fade entirely (fadeFraction then
 * returns 1 immediately, so a fine chunk pops in at full strength — the floor
 * is still drawn for chunks that are not yet resident). Kept short enough that
 * it never reads as lag on a settled view.
 */
const DEFAULT_CHUNK_FADE_MS = 120

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
  // Ray-step density comes from this brick's source level (full-volume dims);
  // for single-level plans levelDims is absent so it falls back to volumeDims.
  const rayStep = plan.levelDims?.[desc.sourceLevel ?? 0] ?? plan.volumeDims
  // The brick's OWNED box inside its own texture. A multi-LOD brick fetches a
  // box snapped out to whole level voxels, so the fetched box is NOT the owned
  // box and using it here would misregister the brick. See `chunkOwnedTexBox`.
  const owned = chunkOwnedTexBox(plan, desc)
  return {
    // World placement uses the COMMON grid (voxelOrigin/voxelDims are common-grid
    // for multi-LOD bricks; identical to the level grid for single-level plans).
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
    // Texture-space remap uses the brick's OWN level grid.
    dataOriginTexFrac: owned.origin,
    dataSizeTexFrac: owned.size,
    rayStepTexVox: [rayStep[0], rayStep[1], rayStep[2]],
    lodDownsample: chunkLodDownsample(plan, desc),
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
  // Cross-fade duration, ms, for a freshly-admitted streaming chunk. Set from
  // the chunkFadeMs option when the view initializes; 0 disables the fade.
  chunkFadeMs = DEFAULT_CHUNK_FADE_MS
  // Scene flag (set per-frame from md.scene): clip the overlay/PAQD/drawing passes
  // with the base volume instead of letting them ignore the clip plane.
  clipPlaneOverlay = false
  // Volume flag (set per-frame from md.volume.renderMode): 0 = composite (OVER),
  // 1 = maximum-intensity projection. See VOLUME_RENDER_MODE.
  renderMode = 0
  // Which stencil the overlay/drawing passes estimate their own gradient with
  // (from md.volume.layerGradientMode). The background volume reads a
  // precomputed gradient texture and is unaffected. See LAYER_GRADIENT_MODE.
  layerGradientMode = VOLUME_DEFAULTS.layerGradientMode
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
  // Tricubic B-spline instead of hardware trilinear in the background fine pass
  // (from md.volume.isCubicInterpolation). Cures the blocky texel staircase that
  // C0 trilinear leaves on band edges, at 8 fetches per sample instead of 1.
  // Assigned every frame by the view, so the setter is where an "on, but the
  // active chunk plan cannot feed the kernel" warning is raised: it is the only
  // point that sees the request and the current plan together (the entry may
  // have been built long before the user turned cubic on).
  private _isCubicInterpolation = VOLUME_DEFAULTS.isCubicInterpolation
  get isCubicInterpolation(): boolean {
    return this._isCubicInterpolation
  }
  set isCubicInterpolation(v: boolean) {
    this._isCubicInterpolation = v
    const entry = this._activeChunked
    if (entry) warnIfCubicUnsafe(entry.volume.name, entry.cubicSafe, v)
  }
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
  // Current volume gradient/illumination amount, set by the view each frame
  // BEFORE chunk work (request/pump). Chunk uploaders read this to skip the
  // gradient compute pass when the volume is unlit (== 0). Mirrors the GL backend.
  gradientAmount = 0
  // True once any chunk was uploaded without a real gradient (unlit). If lighting
  // is later enabled, those chunks are re-streamed so they gain gradients.
  private _uploadedUnlit = false
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
  // False when the active volume is categorical (colormapLabel): the ray march
  // samples an RGBA texture whose colors are already baked, so a smooth
  // reconstruction would blend two unrelated labels into a third label's colour.
  // Cubic is forced off for such a volume regardless of the global setting.
  private _cubicVolumeSafe = true
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
  /** Voxel dims of `coarseFloorTexture` (drives the floor cubes' step count). */
  coarseFloorDims: [number, number, number] | null = null
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
  private volumeOrientCache: orient.OrientTextureCache | null = null

  constructor() {
    super()
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

    const cacheKey = vol.url || vol.name

    if (forcedPlan || oversized) {
      const chunkedEntry = await this._ensureChunkedVolumeEntry(
        device,
        vol,
        this._chunkResidencyBytes,
      )
      this._activeChunked = chunkedEntry
      this._cubicVolumeSafe = !vol.colormapLabel
      this._activeVolKey = cacheKey || null
      this.volumeTexture =
        chunkedEntry.manager.getChunk(0)?.volumeTexture ?? null
      this.volumeGradientTexture =
        chunkedEntry.manager.getChunk(0)?.volumeGradientTexture ?? null
      await this._ensureMatcap(device, matcap)
      return
    }

    const mtx = NVTransforms.calculateOverlayTransformMatrix(vol, vol)
    const modParams = buildModulationParams(vol, vol, allVolumes)
    this._activeChunked = null
    this._cubicVolumeSafe = !vol.colormapLabel

    if (perVolumeCache) {
      // Multi-instance / global3d: cache each volume's texture by key so the
      // render loop can switch the active texture per tile via
      // bindCachedVolume. (volumeOrientCache is a single slot and cannot serve
      // per-tile volume switching.)
      let entry = cacheKey ? this._texCache.get(cacheKey) : undefined
      if (entry && entry.kind !== 'single') {
        this._destroyTexEntry(entry)
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
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        // RGB/RGBA volumes bypass the orient pass (direct upload, no cache)
        this.clearVolume()
        this.volumeTexture = await orient.volume2Texture(
          device,
          vol,
          vol,
          mtx as Float32Array,
          0,
          undefined,
          modParams,
        )
      } else {
        this.destroyNonCachedVolumeTexture()
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
   * Halo is 3 (not the [1,1,1] default): the per-chunk gradient taps at +-0.7
   * voxel through a LINEAR sampler, so it reads one voxel past the chunk, and
   * trilinear sampling at the data edge reaches one further -- a 3-voxel halo
   * keeps the gradient seam-free between chunks with a margin.
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
    const displayKey = chunkedDisplayKey(vol)
    const existing = cacheKey ? this._texCache.get(cacheKey) : undefined
    if (existing && existing.kind === 'chunked') {
      existing.volume = vol
      if (existing.displayKey !== displayKey) {
        // Colormap/window/frame changed after load. Resident chunk textures
        // bake the old state (the uploader's LUT + orient uniforms are fixed at
        // creation), so rebuild the uploader and re-stream: evict everything,
        // then admit chunk 0 with the new state so the volume stays present
        // while the working set refills — the same drop-and-refill mechanism as
        // _refreshUnlitChunksForLighting.
        existing.displayKey = displayKey
        // The decoded tier is deliberately kept: it holds SOURCE bytes, and a
        // colormap or window change re-orients the same source. The re-stream
        // below therefore costs uploads, not fetches.
        const newUploader = await createChunkUploaderGPU(
          device,
          vol,
          existing.plan,
          () => this._needsGradient(),
          existing.decoded,
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
    if (existing) this._destroyTexEntry(existing)
    const decoded = new DecodedChunkCache(
      decodedTierBudgetBytes(budgetBytes, bpv),
    )
    const uploader = await createChunkUploaderGPU(
      device,
      vol,
      plan,
      () => this._needsGradient(),
      decoded,
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
        bytesOf: chunkResidentBytes,
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

  /**
   * Swap a chunked volume's plan in place (multi-LOD refocus): re-key the
   * resident GPU chunks to the new plan by content (`matchChunksByContent`) so
   * unchanged bricks keep their texture and fade, and only changed/new bricks
   * stream — instead of rebuilding the whole entry via a reload. No-op when the
   * volume has no chunked entry yet (first load still goes through updateVolume).
   */
  async swapChunkedVolumePlan(
    device: GPUDevice,
    vol: NVImage,
    newPlan: ChunkPlan,
  ): Promise<void> {
    const cacheKey = vol.url || vol.name
    const entry = cacheKey ? this._texCache.get(cacheKey) : undefined
    if (!entry || entry.kind !== 'chunked') return
    if (newPlan.chunks.length > MAX_CHUNKS_PER_TILE) {
      throw new Error(
        `multi-LOD plan tiles into ${newPlan.chunks.length} chunks, ` +
          `exceeding the per-tile limit of ${MAX_CHUNKS_PER_TILE}.`,
      )
    }
    const oldToNew = matchChunksByContent(entry.plan, newPlan)
    // Rebind the uploader to the new plan; dispose the old orient resources.
    const newUploader = await createChunkUploaderGPU(
      device,
      vol,
      newPlan,
      () => this._needsGradient(),
      entry.decoded,
    )
    entry.uploader.dispose()
    entry.uploader = newUploader
    entry.manager.remap(oldToNew, newPlan.chunks.length)
    // Chunk indices are plan-relative, so the tier is re-keyed by the same
    // content match: a brick the new plan still contains keeps its bytes, and
    // a refocus back to this level finds them.
    entry.decoded.remap(oldToNew)
    entry.plan = newPlan
    // A new grid makes the recorded travel meaningless, and the old uploader
    // took its outstanding speculative reads with it.
    entry.predictor.reset()
    entry.requestedThisFrame.length = 0
    entry.speculative.clear()
    entry.cubicSafe = planSupportsCubic(newPlan)
    warnIfCubicUnsafe(
      entry.volume.name,
      entry.cubicSafe,
      this.isCubicInterpolation,
    )
    entry.bindGroups = newPlan.chunks.map(() => null)
    entry.volume = vol
    entry.displayKey = chunkedDisplayKey(vol)
    vol.chunkPlan = newPlan
    // Keep at least one chunk resident for the first post-swap frame; the pump
    // streams the rest from the next working set.
    if (entry.manager.residentCount === 0) {
      const chunk0 = await entry.uploader.uploadChunk(0)
      if (!chunk0.hasGradient) this._uploadedUnlit = true
      entry.manager.admit(0, chunk0)
    }
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
      this._cubicVolumeSafe = !entry.volume.colormapLabel
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
   * base, for the 2D slice path: ramps 0->1 over `chunkFadeMs` from admit, so a
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
      this.chunkFadeMs,
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
    const capped = chunkIndicesForResidentBudget(
      entry.plan,
      ordered,
      entry.manager.budgetBytes,
    )
    for (const ci of capped) {
      entry.manager.requestUpload(ci)
      for (const m of mirrors) m.requestUpload(ci)
    }
    // Accumulate rather than replace: a multiplanar layout drives this volume
    // from several tiles per frame, and the union is what travels.
    for (const ci of capped) entry.requestedThisFrame.push(ci)
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
    const capped = chunkIndicesForResidentBudget(
      entry.plan,
      ordered,
      entry.manager.budgetBytes,
    )
    for (const ci of capped) {
      entry.manager.requestUpload(ci)
      for (const m of mirrors) m.requestUpload(ci)
    }
    for (const ci of capped) entry.requestedThisFrame.push(ci)
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
    this._refreshUnlitChunksForLighting()
    this._ensureSingleGradients()
    for (const entry of this._texCache.values()) {
      if (entry.kind !== 'chunked') continue
      // Predict from the frame that just ended, before its record is cleared.
      // Here rather than in the pump because the pump is paused mid-drag, and a
      // drag is exactly when the view is travelling and worth fetching ahead of.
      this._speculateAhead(entry)
      entry.requestedThisFrame.length = 0
      entry.manager.beginFrame()
    }
  }

  /**
   * Fetch ahead of the working set along its direction of travel: ask the
   * predictor where the last frame's chunks were heading and start source reads
   * for the answer, releasing the guesses that no longer apply so a wrong turn
   * cannot hold fetch slots for the rest of the session.
   *
   * Speculative only. Nothing here is requested for upload, so the residency
   * queue and the eviction clock never see it, and the uploader admits these
   * reads only into fetch slots the working set is not using.
   */
  private _speculateAhead(entry: ChunkedTexEntry): void {
    const predicted = entry.predictor.predict(
      entry.plan,
      entry.requestedThisFrame,
      CHUNK_PREDICT_WINDOW,
    )
    if (predicted.length === 0) {
      // Either the view is settled or this frame said nothing new. Standing
      // guesses are left alone: dropping them on the first idle frame would
      // cancel every read a discrete scrub had just started for its next step.
      return
    }
    for (const ci of entry.requestedThisFrame) {
      // The view arrived at a guess: the read did its job and the chunk is the
      // working set's now, so drop the claim without cancelling it.
      entry.speculative.delete(ci)
    }
    if (!predicted.some((ci) => entry.speculative.has(ci))) {
      // Nothing standing is on the new heading, so the view turned. Release the
      // old guesses; travel that merely continues shares chunks with them and
      // takes this branch only once its whole flight has been consumed.
      for (const ci of entry.speculative) {
        entry.speculative.delete(ci)
        // Once the working set has claimed a guess the read belongs to the
        // pump, and cancelling it would abort an upload already under way.
        if (entry.manager.isUploadPending(ci)) continue
        entry.uploader.cancelChunk(ci)
      }
    }
    for (const ci of predicted) {
      // One flight of guesses at a time: new reads start only as the view
      // consumes the standing ones, so speculation cannot churn per frame.
      if (entry.speculative.size >= CHUNK_PREDICT_WINDOW) break
      if (entry.manager.isResident(ci)) continue
      if (entry.speculative.has(ci)) continue
      entry.speculative.add(ci)
      entry.predictedCount++
      entry.uploader.prefetchChunk(ci, true)
    }
  }

  /**
   * Whether the per-chunk gradient pass must run. Lighting is not the only
   * consumer: gradient opacity and silhouette read the same texture's magnitude
   * and direction, so an unlit volume with either turned up still needs it.
   */
  private _needsGradient(): boolean {
    return (
      this.gradientAmount > 0 || this.gradientOpacity > 0 || this.silhouette > 0
    )
  }

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
  private _ensureSingleGradients(): void {
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

  private _refreshUnlitChunksForLighting(): void {
    if (!this._needsGradient() || !this._uploadedUnlit) return
    this._uploadedUnlit = false
    for (const entry of this._texCache.values()) {
      if (entry.kind !== 'chunked') continue
      entry.manager.remap(new Map(), entry.plan.chunks.length)
      entry.bindGroups = entry.plan.chunks.map(() => null)
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
          // Capture the uploader + plan generation BEFORE the await: a refocus
          // can run swapChunkedVolumePlan -> remap() during the upload, which
          // bumps the generation and re-keys the plan. Admitting the stale
          // result would put the old brick's texture at a new-plan index.
          const uploader = entry.uploader
          const gen = entry.manager.generation
          try {
            const chunk = await uploader.uploadChunk(i)
            if (entry.manager.generation === gen) {
              if (!chunk.hasGradient) this._uploadedUnlit = true
              entry.manager.admit(i, chunk)
            } else {
              entry.manager.discardUpload(i, chunk)
            }
          } catch (err) {
            // Isolate a single chunk's failure: mark it failed and keep pumping.
            // failUpload clears the in-flight marker so a later working-set pass
            // re-enqueues it. Rethrowing would reject the whole pump and stop the
            // view's self-driven re-render loop, freezing all streaming until an
            // unrelated redraw (e.g. a drag) re-kicks it.
            entry.manager.failUpload(i)
            // An abort is this renderer's own doing (the view stopped wanting
            // the chunk, or the uploader was disposed), so it is not a failure
            // to report.
            if (!(err instanceof Error && err.name === 'AbortError'))
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
        buildModulationParams(vol, baseVol, [baseVol, ...overlayVols]),
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
            undefined,
            buildModulationParams(vol, baseVol, [baseVol, ...overlayVols]),
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
      buildModulationParams(overlayVol, baseVol, [baseVol, overlayVol]),
    )
    orient.dispatchOrient(device, this.overlayOrientCache)
    this.overlayTexture = this.overlayOrientCache.outputTexture
    return true
  }

  private destroyNonCachedVolumeTexture(): void {
    if (
      this.volumeTexture &&
      this.volumeTexture !== this.volumeOrientCache?.outputTexture
    ) {
      this.volumeTexture.destroy()
    }
    this.volumeTexture = null
  }

  clearVolume(): void {
    this.destroyNonCachedVolumeTexture()
    orient.destroyOrientTextureCache(this.volumeOrientCache)
    this.volumeOrientCache = null
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
    setChunkBudget(entry, overlayBudget)
    this._activeOverlayChunked = entry
    if (this._activeChunked && this._activeChunked !== entry) {
      setChunkBudget(
        this._activeChunked,
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
    if (this._activeChunked) {
      setChunkBudget(this._activeChunked, this._chunkResidencyBytes)
    }
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
      setChunkBudget(entry, overlayBudget)
      this._combinedOverlayEntries.push(entry)
    }
    if (this._activeChunked) {
      setChunkBudget(
        this._activeChunked,
        this._chunkResidencyBytes * (1 - OVERLAY_RESIDENCY_FRACTION),
      )
    }
    this._invalidateBindGroupCache()
  }

  /** Forget the streamed combined overlays; base reclaims the full budget. */
  private _clearCombinedOverlayChunked(): void {
    if (this._combinedOverlayEntries.length === 0) return
    this._combinedOverlayEntries = []
    if (this._activeChunked) {
      setChunkBudget(this._activeChunked, this._chunkResidencyBytes)
    }
    this._invalidateBindGroupCache()
  }

  /** The NVImage backing the active independent chunked overlay (or null). */
  getOverlayChunkedVolume(): NVImage | null {
    return this._activeOverlayChunked?.volume ?? null
  }

  /**
   * Cheap per-frame subset of {@link chunkStreamStats}: sums only the chunk
   * managers' scalar counters, skipping the decoded-tier walk and its
   * accumulator allocation. The render loop calls this around every
   * upload-pump run to feed the streaming-event hook, so it must stay O(one
   * integer read per chunked volume).
   */
  chunkStreamCounts(): {
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
   * Aggregate streaming stats across all chunked volumes (base + overlay), for
   * HUD / debug instrumentation. `resident` is bricks currently on the GPU,
   * `pending` queued for upload, `inFlight` mid-upload, `total` the chunk count.
   * `staleDropped` counts queued uploads retired because the working set moved
   * on before they ran — upload work the old cross-frame queue would have spent
   * on viewports the user had already left. `decoded` sums the decoded-chunk
   * tiers: its hit rate is the share of source reads that an evicted brick's
   * return cost nothing but an upload.
   */
  chunkStreamStats(): {
    resident: number
    pending: number
    inFlight: number
    total: number
    staleDropped: number
    predicted: number
    decoded: DecodedChunkStats
  } {
    let resident = 0
    let pending = 0
    let inFlight = 0
    let total = 0
    let staleDropped = 0
    let predicted = 0
    const decoded: DecodedChunkStats = {
      hits: 0,
      misses: 0,
      admitted: 0,
      rejected: 0,
      evicted: 0,
      entries: 0,
      bytes: 0,
      maxBytes: 0,
    }
    for (const entry of this._texCache.values()) {
      if (entry.kind !== 'chunked') continue
      resident += entry.manager.residentCount
      pending += entry.manager.pendingUploadCount
      inFlight += entry.manager.inFlightUploadCount
      total += entry.manager.chunkCount
      staleDropped += entry.manager.staleDropCount
      predicted += entry.predictedCount
      const d = entry.decoded.stats
      decoded.hits += d.hits
      decoded.misses += d.misses
      decoded.admitted += d.admitted
      decoded.rejected += d.rejected
      decoded.evicted += d.evicted
      decoded.entries += d.entries
      decoded.bytes += d.bytes
      decoded.maxBytes += d.maxBytes
    }
    return {
      resident,
      pending,
      inFlight,
      total,
      staleDropped,
      predicted,
      decoded,
    }
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

    // MIP: merge chunk draws (and the overlay entry's draws over the base) by
    // component-wise max instead of OVER — matching the shader's own per-layer
    // MIP rule (depthAwareMix), so the result is the true full-ray maximum
    // independent of chunk draw order.
    pass.setPipeline(
      this.renderMode > 0.5 ? this.pipelineChunkedMip : this.pipelineChunked,
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
        // Full strength: the fine cube in front of this one carries the
        // cross-fade weight. The floor is base-volume data, so it takes the
        // base's opacity along with it.
        1,
        backOpacity,
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
        {
          ...chunkUniformsFor(entry.plan, chunkIndex),
          cubicSafe: entry.cubicSafe,
        },
        overlayMode ? 1 : 0,
        fade,
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
        // single-level and non-chunked draw.
        invGamma(this.gamma) *
          lodGammaExponent(
            chunkUniforms.lodDownsample ?? 1,
            this.lodBrightnessCompensation,
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
        ...chunkUniforms.chunkSubOrigin,
        1,
        ...chunkUniforms.chunkSubSize,
        1,
        ...chunkUniforms.dataOriginTexFrac,
        1,
        ...chunkUniforms.dataSizeTexFrac,
        1,
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
      this.coarseFloorDims = null
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
