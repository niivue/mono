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
import { applyCORS } from '@/NVLoader'
import type { NVImage, VolumeChunkExplode } from '@/NVTypes'
import { blendOverlayData } from '@/view/NVMeshView'
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
import * as depthPickShader from './depthPickShader'
import * as gradient from './gradient'
import {
  type ChunkUploaderGL,
  createChunkUploaderGL,
  destroyVolumeChunksGL,
  type VolumeChunkGL,
} from './orientChunked'
import * as orientOverlay from './orientOverlay'
import * as renderShader from './renderShader'
import { Shader } from './shader'

/**
 * Default GPU memory budget, in bytes, for a chunked volume's resident chunk
 * set. Mirrors the WebGPU backend; overridable per instance via the
 * `maxChunkResidencyBytes` option. The ChunkResidencyManager evicts
 * least-recently-visible chunks to keep the resident set within budget.
 */
const DEFAULT_CHUNK_RESIDENCY_BYTES = 1_500_000_000

/**
 * Maximum chunks a single chunked volume may tile into. The WebGL2 backend sets
 * per-chunk uniforms per draw call (no fixed slot buffer), so this is purely a
 * parity guard mirroring the WebGPU backend's structural limit, keeping
 * cross-backend error behavior identical. Raised to 1024 (from 256) in lockstep
 * with the WebGPU paths so full-resolution levels of large volumes load.
 */
const MAX_CHUNKS_PER_TILE = 1024

/**
 * Streaming-pump budget per `pumpChunkUploads` call. Mirrors the WebGPU
 * backend: chunks (source fetch + orient + gradient) upload round-robin across
 * chunked volumes until the wall-clock budget or hard cap is hit, then the pump
 * yields so the next frame can present the freshly-resident bricks. A
 * wall-clock budget self-tunes the fill rate to upload cost.
 */
const CHUNK_UPLOAD_BUDGET_MS = 8
const MAX_CHUNK_UPLOADS_PER_FRAME = 24
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
 * independent hi-res overlay's residency manager; the base keeps the rest, so
 * base + overlay together stay within the configured cap instead of each
 * filling it. The overlay gets the smaller share (base is the primary anatomy).
 */
const OVERLAY_RESIDENCY_FRACTION = 0.4

/**
 * Near-plane depth convention for this backend's clip space. WebGL2 clip space
 * has z in [-w, w]; `chunksInFrustum` uses this to cull against the near plane.
 */
const CLIP_SPACE_ZERO_TO_ONE = false

type Vec3f = [number, number, number]

/**
 * Per-chunk uniform values for one cube draw of a chunked volume. The shader
 * uses them to scale the unit cube into the chunk's sub-region and remap
 * sample positions into the chunk texture. Non-chunked draws use identity
 * pass-through values.
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
  /**
   * This brick's source-level full-volume dims, driving the ray-step density so
   * coarse multi-LOD bricks step at their own resolution. Equals
   * volumeTexDimsFull for single-level plans.
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

/** Single-texture volume: fits within max3D on all axes. */
interface SingleTexEntry {
  kind: 'single'
  volumeTexture: WebGLTexture
  /**
   * Null when the volume was uploaded with no gradient consumer switched on --
   * the gradient pass is skipped entirely in that case. `_ensureSingleGradients`
   * fills it in on the first frame after one turns on.
   */
  volumeGradientTexture: WebGLTexture | null
  /**
   * Dims the gradient pass was (or will be) built with. Stored rather than
   * re-derived so a deferred build uses exactly the value its upload would
   * have, and WebGL cannot query a texture's size to recover it.
   */
  gradDims: Vec3f
  /** Full RAS volume dims — WebGL cannot query a texture's size. */
  dims: Vec3f
  /** Categorical volume: never smooth its baked label colors (see _cubicVolumeSafe). */
  isLabel: boolean
}

/** Chunked (tiled) volume: one or more axes exceed max3D. */
interface ChunkedTexEntry {
  kind: 'chunked'
  /** Volume object that owns mutable per-volume render options. */
  volume: NVImage
  /** GPU residency bookkeeping for the volume's chunks. */
  manager: ChunkResidencyManager<VolumeChunkGL>
  /** On-demand uploader the streaming pump drives to fill the manager. */
  uploader: ChunkUploaderGL
  plan: ChunkPlan
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

/**
 * Steady-state GPU bytes one resident chunk occupies. The scalar source
 * texture is destroyed after the orient pass, so only the RGBA color texture
 * and the gradient texture persist — both rgba8 (4 bytes/voxel) over the
 * chunk's padded `texDims`.
 */
function chunkResidentBytes(chunk: VolumeChunkGL): number {
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
  private _gl: WebGL2RenderingContext | null
  shader: Shader | null
  depthPickShaderProgram: Shader | null
  matcapTexture: WebGLTexture | null
  private _matcapUrl: string | null
  volumeTexture: WebGLTexture | null
  volumeGradientTexture: WebGLTexture | null
  overlayTexture: WebGLTexture | null
  // Per-chunk overlay textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the overlay layer is chunked; the
  // single-texture overlayTexture stays null in that case (and vice versa).
  overlayChunks: WebGLTexture[] | null
  paqdTexture: WebGLTexture | null
  // Per-chunk raw PAQD textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the PAQD layer is chunked; the
  // single-texture paqdTexture stays null in that case (and vice versa).
  paqdChunks: WebGLTexture[] | null
  paqdLutTexture: WebGLTexture | null
  drawingTexture: WebGLTexture | null
  // Per-chunk drawing textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the drawing layer is chunked; the
  // single-texture drawingTexture stays null in that case (and vice versa).
  drawingChunks: WebGLTexture[] | null
  drawingLinearSampler: WebGLSampler | null
  placeholderOverlay: WebGLTexture | null
  cubeVAO: WebGLVertexArrayObject | null
  vertexBuffer: WebGLBuffer | null
  indexBuffer: WebGLBuffer | null
  cube: { vertices: number[]; indices: number[] }
  max3D: number
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
  // Coarse whole-volume "floor" texture for the active base, drawn behind the
  // resident fine chunks on 2D slices so a deep-zoom slice never blanks while
  // finer chunks stream. Oriented once from a coarse pyramid level the app
  // supplies (niivue stays LOD-agnostic). Null when unset.
  coarseFloorTexture: WebGLTexture | null = null
  /** Voxel dims of `coarseFloorTexture` (drives the floor cubes' step count). */
  coarseFloorDims: [number, number, number] | null = null
  // Gradient for the coarse floor, used by the 3D ray-march floor cubes for
  // matcap lighting consistent with the resident fine chunks. Null when unset.
  coarseFloorGradientTexture: WebGLTexture | null = null
  private _coarseFloorKey: string | null = null
  // Per-volume GPU texture cache. Populated by updateVolume; consumed by
  // bindCachedVolume to switch the active volume/gradient texture per tile
  // when rendering multi-instance global3d scenes.
  private _texCache: Map<string, TexCacheEntry>
  // Current volume gradient/illumination amount, set by the view each frame
  // BEFORE chunk work (request/pump). Chunk uploaders read this to skip the
  // (expensive, per-slice) gradient pass when the volume is unlit (== 0).
  gradientAmount = 0
  // True once any chunk was uploaded without a real gradient (unlit). If lighting
  // is later enabled, those chunks are re-streamed so they gain gradients.
  private _uploadedUnlit = false
  // Dims for the non-cached single-texture volume's deferred gradient build.
  // The single-texture analogue of _uploadedUnlit: non-null and paired with a
  // null volumeGradientTexture means "gradient skipped, build it if asked".
  private _singleGradDims: Vec3f | null = null
  // Set when the active volume is chunked; null for single-texture volumes.
  // draw() branches on this to run the multi-chunk loop.
  private _activeChunked: ChunkedTexEntry | null = null
  // False when the active volume is categorical (colormapLabel): the ray march
  // samples an RGBA texture whose colors are already baked, so a smooth
  // reconstruction would blend two unrelated labels into a third label's colour.
  // Cubic is forced off for such a volume regardless of the global setting.
  private _cubicVolumeSafe = true
  // Set when an independently-streamed hi-res overlay (chunkOverlayOf) is
  // loaded over a chunked base. It has its OWN ChunkPlan + residency manager
  // (a second _texCache entry, keyed by its own url/name) and draws as
  // translucent chunk cubes over the base, instead of being resliced onto the
  // base grid. Null when no such overlay is present (base path unchanged).
  private _activeOverlayChunked: ChunkedTexEntry | null = null
  // Streamed combined overlays (strategy A): base-aligned chunked overlay
  // entries (chunkSource, co-registered at the base grid) that stream via the
  // pump and feed the base block's overlay texture unit — base ray-march / clip
  // plane / compositing reused unchanged. WebGL2 rebinds overlay textures each
  // draw, so no bind-group invalidation is needed.
  private _combinedOverlayEntries: ChunkedTexEntry[] = []
  // Full RAS dims of the active single-texture volume. WebGL cannot query a
  // texture's size, so the renderer tracks it for the volumeTexDimsFull
  // uniform on non-chunked draws and depth picks.
  private _activeDims: Vec3f = [0, 0, 0]
  private _pumpInFlight = false
  // Wall-clock stamp captured once per frame in beginChunkFrame, so every chunk
  // draw in the frame measures fade age against the same instant.
  private _frameNow = 0
  // Set true during a frame whenever a chunk drew mid cross-fade, so the view
  // schedules a follow-up frame to keep the fade animating to completion.
  private _fadeActive = false
  private overlayOrientCache: orientOverlay.OverlayTextureCache | null = null
  private volumeOrientCache: orientOverlay.OverlayTextureCache | null = null

  constructor() {
    super()
    this._gl = null
    this.shader = null
    this.depthPickShaderProgram = null
    this.matcapTexture = null
    this._matcapUrl = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.overlayTexture = null
    this.overlayChunks = null
    this.paqdTexture = null
    this.paqdChunks = null
    this.paqdLutTexture = null
    this.drawingTexture = null
    this.drawingChunks = null
    this.drawingLinearSampler = null
    this.placeholderOverlay = null
    this.cubeVAO = null
    this.vertexBuffer = null
    this.indexBuffer = null
    this.cube = NVShapes.getCubeMesh()
    this.max3D = 0
    this._texCache = new Map()
  }

  async init(
    gl: WebGL2RenderingContext,
    max3D: number,
    chunkResidencyBytes: number = DEFAULT_CHUNK_RESIDENCY_BYTES,
  ): Promise<void> {
    if (this.isReady) return
    this._gl = gl

    this.max3D = max3D
    this._chunkResidencyBytes = chunkResidencyBytes

    // Create cube VAO
    this.cubeVAO = gl.createVertexArray()
    gl.bindVertexArray(this.cubeVAO)

    // Vertex buffer
    this.vertexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(this.cube.vertices),
      gl.STATIC_DRAW,
    )

    // Position attrib at location 0
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)

    // Index buffer
    this.indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array(this.cube.indices),
      gl.STATIC_DRAW,
    )

    gl.bindVertexArray(null)

    // Create placeholder 2x2x2 RGBA overlay texture (all zeros - transparent black)
    this.placeholderOverlay = gl.createTexture()
    if (this.placeholderOverlay) {
      gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
      const emptyData = new Uint8Array(2 * 2 * 2 * 4) // 32 bytes, all zeros
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGBA,
        2,
        2,
        2,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        emptyData,
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    }

    // Compile volume rendering shader
    this.shader = new Shader(
      gl,
      renderShader.vertexShader,
      renderShader.fragmentShader,
    )
    // Fix uniform array locations (Shader class doesn't handle arrays correctly)
    this.shader.uniforms.clipPlanes = gl.getUniformLocation(
      this.shader.program,
      'clipPlanes[0]',
    )

    // Compile depth-pick shader for depth picking
    this.depthPickShaderProgram = new Shader(
      gl,
      depthPickShader.depthPickVertexShader,
      depthPickShader.depthPickFragmentShader,
    )
    this.depthPickShaderProgram.uniforms.clipPlanes = gl.getUniformLocation(
      this.depthPickShaderProgram.program,
      'clipPlanes[0]',
    )

    this.isReady = true
  }

  private _createFallbackTexture2D(gl: WebGL2RenderingContext): WebGLTexture {
    const texture = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return texture
  }

  private async _loadTexture2D(
    gl: WebGL2RenderingContext,
    imageSrc: string,
  ): Promise<WebGLTexture> {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const texture = gl.createTexture()
        if (!texture) {
          reject(new Error('Failed to create texture'))
          return
        }
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          image,
        )
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.bindTexture(gl.TEXTURE_2D, null)
        resolve(texture)
      }
      image.onerror = reject
      applyCORS(image)
      image.src = imageSrc
    })
  }

  private async _loadTexture2DOrFallback(
    gl: WebGL2RenderingContext,
    imageSrc: string,
  ): Promise<WebGLTexture> {
    if (!imageSrc) return this._createFallbackTexture2D(gl)
    return this._loadTexture2D(gl, imageSrc)
  }

  async updateVolume(
    gl: WebGL2RenderingContext,
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
    const limit = this.max3D
    const forcedPlan = vol.chunkPlan
    const oversized =
      needsChunking(srcDims, limit) || needsChunking(rasDims, limit)

    const cacheKey = vol.url || vol.name

    if (forcedPlan || oversized) {
      const chunkedEntry = await this._ensureChunkedVolumeEntry(
        gl,
        vol,
        this._chunkResidencyBytes,
      )
      this._activeChunked = chunkedEntry
      this._cubicVolumeSafe = !vol.colormapLabel
      this._activeDims = [rasDims[0], rasDims[1], rasDims[2]]
      this._syncChunkedAliases(chunkedEntry)
      await this._ensureMatcap(gl, matcap)
      return
    }

    const mtx = NVTransforms.calculateOverlayTransformMatrix(vol, vol)
    const modParams = buildModulationParams(vol, vol, allVolumes)
    // Leaving a chunked volume: the aliases below name textures the chunked
    // cache entry still owns, and the single-volume paths that follow delete
    // whatever they find in them. Drop the pointers first so a later switch
    // back to the chunked volume doesn't bind a freed texture.
    if (this._activeChunked) {
      this.volumeTexture = null
      this.volumeGradientTexture = null
    }
    this._activeChunked = null
    this._cubicVolumeSafe = !vol.colormapLabel

    if (perVolumeCache) {
      // Multi-instance / global3d: cache each volume's texture by key so the
      // render loop can switch the active texture per tile via
      // bindCachedVolume. (volumeOrientCache is a single slot and cannot serve
      // per-tile volume switching.)
      let entry = cacheKey ? this._texCache.get(cacheKey) : undefined
      if (entry && entry.kind !== 'single') {
        this._destroyTexEntry(gl, entry)
        entry = undefined
      }
      if (!entry) {
        const volumeTexture = await orientOverlay.overlay2Texture(
          gl,
          vol,
          vol,
          mtx as Float32Array,
          0,
          undefined,
          modParams,
        )
        gl.bindTexture(gl.TEXTURE_3D, null)
        const gradDims = [
          vol.hdr.dims[1],
          vol.hdr.dims[2],
          vol.hdr.dims[3],
        ] as Vec3f
        // Skipped outright when nothing reads it. The pass is a per-z-slice
        // FBO render over the whole volume and the texture it produces is the
        // size of the volume, so an unlit scene pays neither.
        const volumeGradientTexture = this._needsGradient()
          ? gradient.volume2TextureGradientRGBA(gl, volumeTexture, gradDims)
          : null
        entry = {
          kind: 'single',
          volumeTexture,
          volumeGradientTexture,
          gradDims,
          dims: [rasDims[0], rasDims[1], rasDims[2]],
          isLabel: !!vol.colormapLabel,
        }
        if (cacheKey) this._texCache.set(cacheKey, entry)
      }
      this.volumeTexture = entry.volumeTexture
      this.volumeGradientTexture = entry.volumeGradientTexture
      this._singleGradDims = entry.gradDims
      this._activeDims = entry.dims
    } else {
      // Normal single-volume path: orient-texture cache + modulation. Scalar
      // volumes go through the orient-texture cache so cal_min/max/colormap
      // tweaks only re-run the cheap orient pass.
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        // RGB/RGBA volumes bypass the orient pass (direct upload, no cache)
        this.clearVolume(gl)
        this.volumeTexture = await orientOverlay.overlay2Texture(
          gl,
          vol,
          vol,
          mtx as Float32Array,
          0,
          undefined,
          modParams,
        )
      } else {
        this.deleteNonCachedVolumeTexture(gl)
        this.volumeOrientCache = orientOverlay.prepareOverlayTextureCache(
          gl,
          vol,
          vol,
          mtx as Float32Array,
          0,
          this.volumeOrientCache,
          modParams,
        )
        this.volumeTexture = this.volumeOrientCache.outputTexture
      }
      gl.bindTexture(gl.TEXTURE_3D, null)
      const gradDims = [
        vol.hdr.dims[1],
        vol.hdr.dims[2],
        vol.hdr.dims[3],
      ] as Vec3f
      if (this.volumeGradientTexture) {
        gl.deleteTexture(this.volumeGradientTexture)
      }
      // See the cached branch: skipped when nothing reads it, and remembered
      // (via _singleGradDims) so it can be filled in later without a reupload.
      this._singleGradDims = gradDims
      this.volumeGradientTexture = this._needsGradient()
        ? gradient.volume2TextureGradientRGBA(gl, this.volumeTexture, gradDims)
        : null
      this._activeDims = [rasDims[0], rasDims[1], rasDims[2]]
    }

    await this._ensureMatcap(gl, matcap)
  }

  /**
   * Build (or reuse from the texture cache) the chunked GL entry for an
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
    gl: WebGL2RenderingContext,
    vol: NVImage,
    budgetBytes: number,
  ): Promise<ChunkedTexEntry> {
    const srcDims: Vec3i = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
    const rasDims: Vec3i = vol.dimsRAS
      ? [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
      : srcDims
    const limit = this.max3D
    const plan = vol.chunkPlan ?? chunkVolume(rasDims, limit, [3, 3, 3])
    vol.chunkPlan = plan
    const bpv = bytesPerSourceVoxel(vol.hdr.datatypeCode) || 4
    const budget = estimateChunkedBytes(plan, bpv)
    log.warn(
      `Volume ${vol.name} (${rasDims.join('x')}) exceeds ` +
        `max3D=${limit}. Chunk plan: ` +
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
        // bake the old state, so rebuild the uploader (recaptures the 4D frame
        // window) and re-stream: evict everything, then admit chunk 0 with the
        // new state so the volume stays present while the working set refills —
        // the same drop-and-refill mechanism as _refreshUnlitChunksForLighting.
        existing.displayKey = displayKey
        // The decoded tier is deliberately kept: it holds SOURCE bytes, and a
        // colormap or window change re-orients the same source. The re-stream
        // below therefore costs uploads, not fetches.
        const newUploader = createChunkUploaderGL(
          gl,
          vol,
          existing.plan,
          () => this._needsGradient(),
          existing.decoded,
        )
        existing.uploader.dispose()
        existing.uploader = newUploader
        existing.speculative.clear()
        existing.manager.remap(new Map(), existing.plan.chunks.length)
        const chunk0 = await existing.uploader.uploadChunk(0)
        if (!chunk0.hasGradient) this._uploadedUnlit = true
        existing.manager.admit(0, chunk0)
      }
      return existing
    }
    if (existing) this._destroyTexEntry(gl, existing)
    // The entry holds the live uploader so an in-place plan swap can replace it;
    // the prefetch hook reads it off `entry` (not a creation closure) so it
    // always targets the current plan.
    const decoded = new DecodedChunkCache(
      decodedTierBudgetBytes(budgetBytes, bpv),
    )
    const entry: ChunkedTexEntry = {
      kind: 'chunked',
      volume: vol,
      manager: undefined as unknown as ChunkResidencyManager<VolumeChunkGL>,
      uploader: createChunkUploaderGL(
        gl,
        vol,
        plan,
        () => this._needsGradient(),
        decoded,
      ),
      plan,
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
    entry.manager = new ChunkResidencyManager<VolumeChunkGL>(
      plan.chunks.length,
      budgetBytes,
      {
        bytesOf: chunkResidentBytes,
        destroy: (c) => destroyVolumeChunksGL(gl, [c]),
        prefetch: (ci) => entry.uploader.prefetchChunk(ci),
        cancel: (ci) => entry.uploader.cancelChunk(ci),
      },
    )
    const chunk0 = await entry.uploader.uploadChunk(0)
    if (!chunk0.hasGradient) this._uploadedUnlit = true
    entry.manager.admit(0, chunk0)
    if (cacheKey) this._texCache.set(cacheKey, entry)
    return entry
  }

  /**
   * Swap a chunked volume's plan in place (multi-LOD refocus): re-key resident
   * GPU chunks to the new plan by content so unchanged bricks keep their
   * textures and only changed/new bricks stream. Mirrors the WebGPU backend.
   */
  /**
   * Refresh the whole-volume texture aliases for a chunked entry.
   *
   * A chunked volume has no single volume texture: `volumeTexture` /
   * `volumeGradientTexture` are a best-effort alias of chunk 0. Chunk 0 is not
   * guaranteed resident (a refocus can evict it, and `remap` destroys every chunk
   * the new plan does not match), so re-derive them whenever residency changes --
   * otherwise they dangle at a texture that has already been deleted.
   */
  private _syncChunkedAliases(entry: ChunkedTexEntry): void {
    const chunk0 = entry.manager.getChunk(0)
    this.volumeTexture = chunk0?.volumeTexture ?? null
    this.volumeGradientTexture = chunk0?.volumeGradientTexture ?? null
  }

  async swapChunkedVolumePlan(
    gl: WebGL2RenderingContext,
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
    const newUploader = createChunkUploaderGL(
      gl,
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
    entry.volume = vol
    entry.displayKey = chunkedDisplayKey(vol)
    vol.chunkPlan = newPlan
    if (entry.manager.residentCount === 0) {
      const chunk0 = await entry.uploader.uploadChunk(0)
      if (!chunk0.hasGradient) this._uploadedUnlit = true
      entry.manager.admit(0, chunk0)
    }
    // remap() destroyed every chunk the new plan does not match, so the aliases
    // captured for the old plan may now name deleted textures.
    if (this._activeChunked === entry) this._syncChunkedAliases(entry)
  }

  /**
   * Reload the matcap texture when the URL changes so that opts.matcap
   * updates take effect. Matcap is independent of the per-volume cache.
   */
  private async _ensureMatcap(
    gl: WebGL2RenderingContext,
    matcap: string,
  ): Promise<void> {
    // Matcap is independent of per-volume cache. Reload when the URL
    // changes so that opts.matcap updates take effect — otherwise the
    // first loaded matcap sticks for the lifetime of the renderer.
    if (this.matcapTexture == null || this._matcapUrl !== matcap) {
      const newTex = await this._loadTexture2DOrFallback(gl, matcap)
      if (this.matcapTexture) gl.deleteTexture(this.matcapTexture)
      this.matcapTexture = newTex
      this._matcapUrl = matcap
    }
  }

  /**
   * Switch the active volume/gradient textures to the cache entry for
   * `cacheKey` (a volume url or name). Used per-tile by global3d rendering
   * to draw distinct volumes without re-uploading their data each frame.
   * Returns true if the cache hit and textures were rebound.
   */
  bindCachedVolume(cacheKey: string | undefined): boolean {
    if (!cacheKey) return false
    const entry = this._texCache.get(cacheKey)
    if (!entry) return false
    if (entry.kind === 'chunked') {
      // Chunked draws run the multi-chunk loop in draw(); these legacy
      // single-texture pointers are best-effort aliases for callers that
      // inspect them, not the chunked volume's readiness signal.
      this._activeChunked = entry
      this._cubicVolumeSafe = !entry.volume.colormapLabel
      this._activeDims = entry.plan.volumeDims
      this._syncChunkedAliases(entry)
      return true
    }
    this._activeChunked = null
    this._cubicVolumeSafe = !entry.isLabel
    this.volumeTexture = entry.volumeTexture
    this.volumeGradientTexture = entry.volumeGradientTexture
    this._singleGradDims = entry.gradDims
    this._activeDims = entry.dims
    return true
  }

  /**
   * When the active volume is chunked, expose its plan and per-chunk color
   * textures so the 2D slice renderer can draw one in-plane-restricted quad
   * per chunk. Returns null for single-texture volumes.
   */
  getActiveChunkedSlice(): {
    plan: ChunkPlan
    chunkTextures: (WebGLTexture | null)[]
    overlayChunks: WebGLTexture[] | null
    paqdChunks: WebGLTexture[] | null
  } | null {
    if (!this._activeChunked) return null
    const { manager } = this._activeChunked
    const chunkCount = manager.chunkCount
    // Indexed by chunk index; null for chunks not yet streamed in. The slice
    // loop skips nulls — a transient gap rather than a hole, since the pump
    // fills them within a few frames.
    const chunkTextures: (WebGLTexture | null)[] = []
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
  private _combinedOverlaySliceChunks(
    chunkCount: number,
  ): WebGLTexture[] | null {
    if (this._combinedOverlayEntries.length !== 1 || !this.placeholderOverlay) {
      return null
    }
    const entry = this._combinedOverlayEntries[0]
    if (entry.manager.chunkCount !== chunkCount) return null
    const placeholder = this.placeholderOverlay
    const out: WebGLTexture[] = []
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
    chunkTextures: (WebGLTexture | null)[]
  } | null {
    const entry = this._activeOverlayChunked
    if (!entry) return null
    const chunkTextures: (WebGLTexture | null)[] = []
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
    mirrors: ChunkResidencyManager<VolumeChunkGL>[] = [],
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
    // set and exhausts GPU memory (white context loss). Streaming only the most
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
    mirrors: ChunkResidencyManager<VolumeChunkGL>[] = [],
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
   */
  private _ensureSingleGradients(): void {
    const gl = this._gl
    if (!gl || !this._needsGradient()) return
    for (const entry of this._texCache.values()) {
      if (entry.kind !== 'single' || entry.volumeGradientTexture) continue
      entry.volumeGradientTexture = gradient.volume2TextureGradientRGBA(
        gl,
        entry.volumeTexture,
        entry.gradDims,
      )
      // updateVolume / bindCachedVolume copied the then-null pointer into the
      // live slot, so re-point it at the texture just built.
      if (entry.volumeTexture === this.volumeTexture) {
        this.volumeGradientTexture = entry.volumeGradientTexture
      }
    }
    if (
      !this._activeChunked &&
      this.volumeTexture &&
      !this.volumeGradientTexture &&
      this._singleGradDims
    ) {
      this.volumeGradientTexture = gradient.volume2TextureGradientRGBA(
        gl,
        this.volumeTexture,
        this._singleGradDims,
      )
    }
  }

  private _refreshUnlitChunksForLighting(): void {
    if (!this._needsGradient() || !this._uploadedUnlit) return
    this._uploadedUnlit = false
    for (const entry of this._texCache.values()) {
      if (entry.kind !== 'chunked') continue
      entry.manager.remap(new Map(), entry.plan.chunks.length)
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
   * keep the pump going. A single pump runs at a time so source-backed chunk
   * fetches cannot overlap the next frame's drain.
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
  private _destroyTexEntry(
    gl: WebGL2RenderingContext,
    entry: TexCacheEntry,
  ): void {
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
      gl.deleteTexture(entry.volumeTexture)
      // Null when the volume was uploaded with no gradient consumer on.
      if (entry.volumeGradientTexture) {
        gl.deleteTexture(entry.volumeGradientTexture)
      }
    }
  }

  /** Release any cached volume textures whose key is not in `keepKeys`. */
  pruneVolumeCache(keepKeys: Set<string>): void {
    const gl = this._gl
    if (!gl) return
    for (const [key, entry] of this._texCache) {
      if (keepKeys.has(key)) continue
      this._destroyTexEntry(gl, entry)
      this._texCache.delete(key)
    }
  }

  async updateOverlays(
    gl: WebGL2RenderingContext,
    baseVol: NVImage,
    overlayVols: NVImage[],
    _paqdUniforms: readonly number[] = [0, 0, 0, 0],
  ): Promise<void> {
    if (!this.isReady) return
    this.clearPaqd(gl)

    if (!baseVol.dimsRAS) {
      this.clearOverlay(gl)
      return
    }
    const dimsOut = [baseVol.dimsRAS[1], baseVol.dimsRAS[2], baseVol.dimsRAS[3]]

    // Filter out overlays with zero opacity
    const visible = overlayVols.filter((v) => (v.opacity ?? 1) > 0)
    if (visible.length === 0) {
      this.clearOverlay(gl)
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
          this._updatePaqdChunks(gl, paqdData, dimsOut, baseVol.chunkPlan)
        } else {
          // Upload raw PAQD 3D texture (nearest-neighbor)
          this.paqdTexture = gl.createTexture()
          if (this.paqdTexture) {
            gl.bindTexture(gl.TEXTURE_3D, this.paqdTexture)
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
            gl.texImage3D(
              gl.TEXTURE_3D,
              0,
              gl.RGBA8,
              dimsOut[0],
              dimsOut[1],
              dimsOut[2],
              0,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              paqdData,
            )
            gl.bindTexture(gl.TEXTURE_3D, null)
          }
        }
        // Upload 256-entry padded LUT as 2D texture (nearest-neighbor)
        this.paqdLutTexture = gl.createTexture()
        if (this.paqdLutTexture) {
          gl.bindTexture(gl.TEXTURE_2D, this.paqdLutTexture)
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            256,
            1,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            lut256,
          )
          gl.bindTexture(gl.TEXTURE_2D, null)
        }
      }
    }

    // Independently-streamed hi-res overlays carry chunkOverlayOf: they have
    // their own ChunkPlan + residency and draw as their own chunk cubes over
    // the base, rather than being resliced onto the base grid. Split them out
    // from the base-grid-resliced overlays.
    const independentVols = standardVols.filter((v) => v.chunkOverlayOf)
    const reslicedVols = standardVols.filter((v) => !v.chunkOverlayOf)
    if (independentVols.length > 0) {
      await this._updateOverlayChunkedIndependent(gl, independentVols[0])
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
      await this._updateCombinedOverlayChunked(gl, streamedCombined)
      this._updateOverlayChunks(gl, baseVol, baseVol.chunkPlan, wholeReslice)
      return
    }
    // Non-chunked: drop any per-chunk overlay textures from a prior volume.
    this._clearCombinedOverlayChunked()
    this._destroyOverlayChunks(gl)

    // A streamed overlay (chunkSource, no in-memory `img`) can only render via
    // the chunked path above. It reaches here only transiently — e.g. an
    // overlay-option change fires loadVolumes() while a prior base load is still
    // in flight, so updateOverlays runs before the base's chunkPlan is set.
    // Reslicing it would call overlay2Texture/prepareOverlayTextureCache on a
    // null `img` and throw "image data missing"; skip it until the next update
    // (once the base is chunked) renders it through the combined path.
    const inMem = reslicedVols.filter((v) => v.img)
    if (inMem.length < reslicedVols.length) {
      log.warn(
        'updateOverlays: skipping streamed overlay(s) with no in-memory image ' +
          'until the base volume is chunked',
      )
    }

    // Upload standard overlays
    if (inMem.length === 0) {
      this.clearOverlay(gl)
    } else if (inMem.length === 1) {
      const vol = inMem[0]
      const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        this.clearOverlay(gl)
        this.overlayTexture = orientOverlay.overlay2Texture(
          gl,
          vol,
          baseVol,
          mtx as Float32Array,
          vol.opacity ?? 1,
        )
        gl.bindTexture(gl.TEXTURE_3D, null)
        return
      }
      this.deleteNonCachedOverlayTexture(gl)
      this.overlayOrientCache = orientOverlay.prepareOverlayTextureCache(
        gl,
        vol,
        baseVol,
        mtx as Float32Array,
        vol.opacity ?? 1,
        this.overlayOrientCache,
        buildModulationParams(vol, baseVol, [baseVol, ...overlayVols]),
      )
      this.overlayTexture = this.overlayOrientCache.outputTexture
      gl.bindTexture(gl.TEXTURE_3D, null)
    } else if (inMem.length > 1) {
      this.deleteNonCachedOverlayTexture(gl)
      orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
      this.overlayOrientCache = null
      const overlayData: Uint8Array[] = []
      for (const vol of inMem) {
        const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
        const tex = orientOverlay.overlay2Texture(
          gl,
          vol,
          baseVol,
          mtx as Float32Array,
          vol.opacity ?? 1,
          undefined,
          buildModulationParams(vol, baseVol, [baseVol, ...overlayVols]),
        )
        const data = orientOverlay.readTexture3D(gl, tex, dimsOut)
        gl.deleteTexture(tex)
        overlayData.push(data)
      }
      const blended = blendOverlayData(overlayData, dimsOut)
      this.deleteNonCachedOverlayTexture(gl)
      this.overlayTexture = gl.createTexture()
      if (!this.overlayTexture) return
      gl.bindTexture(gl.TEXTURE_3D, this.overlayTexture)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGBA8,
        dimsOut[0],
        dimsOut[1],
        dimsOut[2],
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        blended,
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    }
  }

  updateAffineOverlay(
    gl: WebGL2RenderingContext,
    baseVol: NVImage,
    overlayVol: NVImage,
  ): boolean {
    if (!this.isReady || !this.overlayOrientCache) return false
    if (!baseVol.dimsRAS || isPaqd(overlayVol.hdr)) return false
    if (isRgbaDatatype(overlayVol.hdr.datatypeCode)) {
      return false
    }
    const mtx = NVTransforms.calculateOverlayTransformMatrix(
      baseVol,
      overlayVol,
    )
    this.overlayOrientCache = orientOverlay.prepareOverlayTextureCache(
      gl,
      overlayVol,
      baseVol,
      mtx as Float32Array,
      overlayVol.opacity ?? 1,
      this.overlayOrientCache,
      buildModulationParams(overlayVol, baseVol, [baseVol, overlayVol]),
    )
    this.overlayTexture = this.overlayOrientCache.outputTexture
    return true
  }

  private deleteNonCachedVolumeTexture(gl: WebGL2RenderingContext): void {
    if (
      this.volumeTexture &&
      this.volumeTexture !== this.volumeOrientCache?.outputTexture
    ) {
      gl.deleteTexture(this.volumeTexture)
    }
    // Always drop the reference: either we just deleted the texture, or the
    // cache still owns it via volumeOrientCache.outputTexture. The caller
    // reassigns this.volumeTexture immediately after.
    this.volumeTexture = null
  }

  clearVolume(gl: WebGL2RenderingContext): void {
    this.deleteNonCachedVolumeTexture(gl)
    orientOverlay.destroyOverlayTextureCache(gl, this.volumeOrientCache)
    this.volumeOrientCache = null
  }

  private deleteNonCachedOverlayTexture(gl: WebGL2RenderingContext): void {
    if (
      this.overlayTexture &&
      this.overlayTexture !== this.overlayOrientCache?.outputTexture
    ) {
      gl.deleteTexture(this.overlayTexture)
    }
    this.overlayTexture = null
  }

  clearOverlay(gl: WebGL2RenderingContext): void {
    this.deleteNonCachedOverlayTexture(gl)
    orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
    this.overlayOrientCache = null
    this._destroyOverlayChunks(gl)
    this.clearOverlayChunked()
    this._clearCombinedOverlayChunked()
  }

  /**
   * Set (or clear, with null) the coarse whole-volume floor texture for the
   * active base. `coarseVol` is a small in-memory pyramid level supplied by the
   * app; it is oriented once into a single RGBA texture (its own colormap /
   * calibration) that the 2D slice path samples behind the resident fine
   * chunks. Re-orients only when the source/colormap/window changes.
   */
  setCoarseFloor(gl: WebGL2RenderingContext, coarseVol: NVImage | null): void {
    if (!coarseVol) {
      if (this.coarseFloorTexture) gl.deleteTexture(this.coarseFloorTexture)
      if (this.coarseFloorGradientTexture)
        gl.deleteTexture(this.coarseFloorGradientTexture)
      this.coarseFloorTexture = null
      this.coarseFloorGradientTexture = null
      this.coarseFloorDims = null
      this._coarseFloorKey = null
      return
    }
    const key = `${coarseVol.url || coarseVol.name}|${coarseVol.colormap}|${coarseVol.calMin}|${coarseVol.calMax}`
    if (key === this._coarseFloorKey && this.coarseFloorTexture) return
    // Orient the coarse level into its own (small) RGBA grid. It shares the base
    // volume's mm box, so the slice samples it at the base's texture fraction.
    const mtx = NVTransforms.calculateOverlayTransformMatrix(
      coarseVol,
      coarseVol,
    )
    // overlayOpacity 0: the floor stands in for the BASE volume, so it must be
    // baked with base semantics (alpha straight from the colormap LUT). Passing
    // 1 selects the overlay path, which makes alpha binary (`step()`); every
    // voxel above threshold then reads fully opaque and a floor cube terminates
    // its ray on the first surface hit, rendering as a dark shell.
    const tex = orientOverlay.overlay2Texture(
      gl,
      coarseVol,
      coarseVol,
      mtx as Float32Array,
      0,
    )
    // Gradient for the 3D floor cubes' matcap lighting (matches base shading).
    const dims: [number, number, number] = coarseVol.dimsRAS
      ? [coarseVol.dimsRAS[1], coarseVol.dimsRAS[2], coarseVol.dimsRAS[3]]
      : [coarseVol.dims[1] ?? 1, coarseVol.dims[2] ?? 1, coarseVol.dims[3] ?? 1]
    const grad = gradient.volume2TextureGradientRGBA(gl, tex, dims)
    if (this.coarseFloorTexture) gl.deleteTexture(this.coarseFloorTexture)
    if (this.coarseFloorGradientTexture)
      gl.deleteTexture(this.coarseFloorGradientTexture)
    this.coarseFloorTexture = tex
    this.coarseFloorGradientTexture = grad
    this.coarseFloorDims = dims
    this._coarseFloorKey = key
  }

  /**
   * Build (or reuse) the independent chunked entry for a hi-res streamed
   * overlay and mark it active. The entry lives in _texCache under the
   * overlay's own key, so the per-frame pump streams it alongside the base.
   * Drawn as translucent chunk cubes over the base in _drawOverlayChunkedVolume.
   */
  private async _updateOverlayChunkedIndependent(
    gl: WebGL2RenderingContext,
    vol: NVImage,
  ): Promise<void> {
    // Split the single configured residency budget: the overlay gets a share,
    // the base keeps the rest, so base + overlay together stay within the
    // configured cap instead of each filling it.
    const overlayBudget = this._chunkResidencyBytes * OVERLAY_RESIDENCY_FRACTION
    const entry = await this._ensureChunkedVolumeEntry(gl, vol, overlayBudget)
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
   * combined overlay. They stream via the pump and feed the base block's overlay
   * texture unit, so the base ray-march / clip plane / compositing are reused
   * unchanged.
   */
  private async _updateCombinedOverlayChunked(
    gl: WebGL2RenderingContext,
    vols: NVImage[],
  ): Promise<void> {
    this._combinedOverlayEntries = []
    if (vols.length === 0) return
    const overlayBudget =
      (this._chunkResidencyBytes * OVERLAY_RESIDENCY_FRACTION) / vols.length
    for (const vol of vols) {
      const entry = await this._ensureChunkedVolumeEntry(gl, vol, overlayBudget)
      setChunkBudget(entry, overlayBudget)
      this._combinedOverlayEntries.push(entry)
    }
    if (this._activeChunked) {
      setChunkBudget(
        this._activeChunked,
        this._chunkResidencyBytes * (1 - OVERLAY_RESIDENCY_FRACTION),
      )
    }
  }

  /** Forget the streamed combined overlays; base reclaims the full budget. */
  private _clearCombinedOverlayChunked(): void {
    if (this._combinedOverlayEntries.length === 0) return
    this._combinedOverlayEntries = []
    if (this._activeChunked) {
      setChunkBudget(this._activeChunked, this._chunkResidencyBytes)
    }
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
   * volume reload. (WebGL2 rebinds overlay textures each draw, so no bind-group
   * cache to invalidate.)
   */
  rebakeChunkedOverlays(): void {
    for (const entry of this._combinedOverlayEntries) entry.manager.destroy()
    this._activeOverlayChunked?.manager.destroy()
  }

  /**
   * Build one RGBA8 overlay texture per chunk for a chunked oversized volume.
   * The overlay layer shares the background volume's ChunkPlan, so the chunk
   * textures align 1:1 with the volume chunks. A single overlay is oriented
   * directly per chunk; multiple overlays are oriented, read back, and blended
   * on the CPU per chunk (mirroring the non-chunked multi-overlay path).
   *
   * RGB/RGBA-datatype overlays are skipped on chunked volumes (the chunked
   * orient pass only supports scalar sources, matching the volume chunker).
   */
  private _updateOverlayChunks(
    gl: WebGL2RenderingContext,
    baseVol: NVImage,
    plan: ChunkPlan,
    standardVols: NVImage[],
  ): void {
    // Chunked overlay path: drop the single-texture representation.
    this.deleteNonCachedOverlayTexture(gl)
    orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
    this.overlayOrientCache = null
    this._destroyOverlayChunks(gl)

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
    if (supported.length === 0) return

    const mtxs = supported.map(
      (v) =>
        NVTransforms.calculateOverlayTransformMatrix(
          baseVol,
          v,
        ) as Float32Array,
    )

    if (supported.length === 1) {
      this.overlayChunks = orientOverlay.overlay2TextureChunked(
        gl,
        supported[0],
        baseVol,
        mtxs[0],
        plan,
        supported[0].opacity ?? 1,
      )
      return
    }

    // Multiple overlays: orient + read back + blend per chunk.
    const [dx, dy, dz] = plan.volumeDims
    const finals: WebGLTexture[] = []
    for (const desc of plan.chunks) {
      const dims = desc.texDims
      const [ox, oy, oz] = desc.texOrigin
      const scale = [dims[0] / dx, dims[1] / dy, dims[2] / dz]
      const offset = [ox / dx, oy / dy, oz / dz]
      const layers: Uint8Array[] = []
      for (let i = 0; i < supported.length; i++) {
        const chunkMtx = chunkOverlayMatrix(mtxs[i], scale, offset)
        const tex = orientOverlay.overlay2Texture(
          gl,
          supported[i],
          baseVol,
          chunkMtx,
          supported[i].opacity ?? 1,
          dims,
        )
        layers.push(orientOverlay.readTexture3D(gl, tex, dims))
        gl.deleteTexture(tex)
      }
      finals.push(
        this._createOverlayChunkTexture(gl, blendOverlayData(layers, dims), [
          dims[0],
          dims[1],
          dims[2],
        ]),
      )
    }
    this.overlayChunks = finals
  }

  /** Upload one blended RGBA8 chunk as a LINEAR-filtered 3D texture. */
  private _createOverlayChunkTexture(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    dims: number[],
  ): WebGLTexture {
    const tex = gl.createTexture()
    if (!tex)
      throw new Error('_createOverlayChunkTexture: createTexture failed')
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      dims[0],
      dims[1],
      dims[2],
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    )
    gl.bindTexture(gl.TEXTURE_3D, null)
    return tex
  }

  /** Release all per-chunk overlay textures from a previous build. */
  private _destroyOverlayChunks(gl: WebGL2RenderingContext): void {
    if (!this.overlayChunks) return
    for (const tex of this.overlayChunks) gl.deleteTexture(tex)
    this.overlayChunks = null
  }

  clearPaqd(gl: WebGL2RenderingContext): void {
    if (this.paqdTexture) {
      gl.deleteTexture(this.paqdTexture)
      this.paqdTexture = null
    }
    this._destroyPaqdChunks(gl)
    if (this.paqdLutTexture) {
      gl.deleteTexture(this.paqdLutTexture)
      this.paqdLutTexture = null
    }
  }

  /**
   * Build one raw RGBA8 PAQD texture per chunk. The PAQD layer shares the
   * background volume's ChunkPlan, so chunk indices and texDims line up with
   * the volume chunks. Each chunk's halo+data region is sliced out of the
   * full-volume PAQD buffer with extractChunkBytes (4 bytes/voxel). Textures
   * are NEAREST-filtered like the single-texture PAQD path.
   */
  private _updatePaqdChunks(
    gl: WebGL2RenderingContext,
    paqdData: Uint8Array,
    dims: number[],
    plan: ChunkPlan,
  ): void {
    this._destroyPaqdChunks(gl)
    const volumeDims: Vec3i = [dims[0], dims[1], dims[2]]
    const chunks: WebGLTexture[] = []
    for (const desc of plan.chunks) {
      const bytes = extractChunkBytes(
        paqdData,
        volumeDims,
        4,
        desc.texOrigin,
        desc.texDims,
      )
      const [tx, ty, tz] = desc.texDims
      const tex = this._createDrawingTexture(gl, bytes, tx, ty, tz)
      if (tex) chunks.push(tex)
    }
    this.paqdChunks = chunks
  }

  /** Release all per-chunk PAQD textures from a previous build. */
  private _destroyPaqdChunks(gl: WebGL2RenderingContext): void {
    if (!this.paqdChunks) return
    for (const tex of this.paqdChunks) gl.deleteTexture(tex)
    this.paqdChunks = null
  }

  draw(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    normalMatrix: Float32Array,
    matRAS: Float32Array,
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
    if (!this.isReady || !this.shader || !this.cubeVAO || !this.indexBuffer)
      return
    if (!this.matcapTexture) return
    // A chunked volume binds its volume + gradient textures PER CHUNK below
    // (and its coarse-floor cubes bind the floor textures), so it must not be
    // gated on the whole-volume pointers: those are best-effort aliases of
    // chunk 0 and go null as soon as a refocus evicts that chunk (e.g. moving
    // the crosshair to the far face of a clipped volume), which silently
    // blanked the entire volume. WebGPU already branches on the chunked entry
    // before its equivalent guard.
    // Only the volume texture is required. volumeGradientTexture is legitimately
    // null on an unlit volume (the gradient pass is skipped at upload), and the
    // shader's needsGradient branch is false in exactly that case, so a
    // placeholder is bound below and never sampled.
    if (!this._activeChunked && !this.volumeTexture) return

    const shader = this.shader
    const indexCount = this.cube.indices.length

    // 1. Use the program
    shader.use(gl)

    // 2. Bind the Textures
    // Volume (unit 0) + gradient (unit 2) are bound per-chunk in step 5;
    // here only their sampler unit assignments are set.
    if (shader.uniforms.volume) {
      gl.uniform1i(shader.uniforms.volume, 0)
    }

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.matcapTexture)
    if (shader.uniforms.matcap) {
      gl.uniform1i(shader.uniforms.matcap, 1)
    }

    if (shader.uniforms.volumeGradient) {
      gl.uniform1i(shader.uniforms.volumeGradient, 2)
    }

    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this.overlayTexture || this.placeholderOverlay,
    )
    if (shader.uniforms.overlay) {
      gl.uniform1i(shader.uniforms.overlay, 3)
    }

    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_3D, this.paqdTexture || this.placeholderOverlay)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (shader.uniforms.paqd) {
      gl.uniform1i(shader.uniforms.paqd, 4)
    }

    // Bind drawing texture to unit 5 (nearest-neighbor)
    gl.activeTexture(gl.TEXTURE5)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this.drawingTexture || this.placeholderOverlay,
    )
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (shader.uniforms.drawing) {
      gl.uniform1i(shader.uniforms.drawing, 5)
    }

    // Bind drawing texture a second time at unit 7, via a LINEAR sampler
    // object so we can take trilinearly-filtered samples of the same
    // texture for smooth gradient computation at first-hit (unit 5 keeps
    // NEAREST filtering for the categorical ray-march).
    if (!this.drawingLinearSampler) {
      const s = gl.createSampler()
      if (s) {
        gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
        this.drawingLinearSampler = s
      }
    }
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this.drawingTexture || this.placeholderOverlay,
    )
    gl.bindSampler(7, this.drawingLinearSampler)
    if (shader.uniforms.drawingLinear) {
      gl.uniform1i(shader.uniforms.drawingLinear, 7)
    }

    // Bind PAQD LUT to unit 6 (nearest-neighbor 2D texture)
    gl.activeTexture(gl.TEXTURE6)
    if (this.paqdLutTexture) {
      gl.bindTexture(gl.TEXTURE_2D, this.paqdLutTexture)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, null)
    }
    if (shader.uniforms.paqdLut) {
      gl.uniform1i(shader.uniforms.paqdLut, 6)
    }

    // 3. Upload Uniforms
    if (shader.uniforms.mvpMtx)
      gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
    if (shader.uniforms.normMtx)
      gl.uniformMatrix4fv(shader.uniforms.normMtx, false, normalMatrix)
    if (shader.uniforms.matRAS)
      gl.uniformMatrix4fv(shader.uniforms.matRAS, false, matRAS)
    if (shader.uniforms.volScale)
      gl.uniform3fv(shader.uniforms.volScale, volScale as Float32Array)
    const rayDirVec = rayDir ?? [0, 0, 1]
    if (shader.uniforms.rayDir)
      gl.uniform3fv(shader.uniforms.rayDir, (rayDirVec as number[]).slice(0, 3))
    if (shader.uniforms.gradientAmount)
      gl.uniform1f(shader.uniforms.gradientAmount, gradientAmount)
    if (shader.uniforms.numVolumes)
      gl.uniform1f(shader.uniforms.numVolumes, volumeCount)
    if (shader.uniforms.clipPlanes)
      gl.uniform4fv(shader.uniforms.clipPlanes, clipPlanes)
    if (shader.uniforms.clipPlaneColor)
      gl.uniform4fv(shader.uniforms.clipPlaneColor, clipPlaneColor)
    if (shader.uniforms.isClipCutaway)
      gl.uniform1f(shader.uniforms.isClipCutaway, isClipCutaway ? 1.0 : 0.0)
    if (shader.uniforms.clipPlaneOverlay)
      gl.uniform1f(
        shader.uniforms.clipPlaneOverlay,
        this.clipPlaneOverlay ? 1.0 : 0.0,
      )
    if (shader.uniforms.overlayLayerMode)
      gl.uniform1f(shader.uniforms.overlayLayerMode, 0.0)
    if (shader.uniforms.renderMode)
      gl.uniform1f(shader.uniforms.renderMode, this.renderMode)
    // Default fully present; the chunk loop overrides per fading chunk.
    if (shader.uniforms.fadeAlpha) gl.uniform1f(shader.uniforms.fadeAlpha, 1.0)
    if (shader.uniforms.paqdUniforms)
      gl.uniform4fv(shader.uniforms.paqdUniforms, paqdUniforms as number[])
    if (shader.uniforms.earlyTermination)
      gl.uniform1f(shader.uniforms.earlyTermination, earlyTermination)
    // The background volume's own opacity. Overlays bake theirs into the
    // overlay texture during the orient pass, so this is the only volume it
    // applies to -- and the only one it was missing from, since the 2D slice
    // shader has always taken it as a uniform.
    if (shader.uniforms.backOpacity)
      gl.uniform1f(shader.uniforms.backOpacity, backOpacity)

    // 4. Bind Geometry
    gl.bindVertexArray(this.cubeVAO)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)

    // 5. Draw with premultiplied alpha blending (shader outputs premultiplied colors)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    if (this._activeChunked) {
      this._drawChunkedVolume(
        gl,
        shader,
        indexCount,
        rayDirVec as number[],
        matRAS,
        volScale,
        this._activeChunked,
        false,
      )
    } else {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture)
      gl.activeTexture(gl.TEXTURE2)
      // Placeholder when the volume is unlit: the sampler must have a complete
      // texture bound even though the shader never reads it.
      gl.bindTexture(
        gl.TEXTURE_3D,
        this.volumeGradientTexture || this.placeholderOverlay,
      )
      // Non-chunked: pass-through (identity) tiled-volume uniforms so the
      // cube renders as its own [0,1] tex space exactly as before.
      this._setChunkUniforms(gl, shader, {
        volumeTexDimsFull: this._activeDims,
        chunkSubOrigin: [0, 0, 0],
        chunkSubSize: [1, 1, 1],
        dataOriginTexFrac: [0, 0, 0],
        dataSizeTexFrac: [1, 1, 1],
        rayStepTexVox: this._activeDims,
      })
      gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Cleanup
    gl.bindVertexArray(null)
  }

  /** Set the five per-chunk tiled-volume uniforms on the active shader. */
  private _setChunkUniforms(
    gl: WebGL2RenderingContext,
    shader: Shader,
    u: ChunkUniforms,
  ): void {
    if (shader.uniforms.volumeTexDimsFull)
      gl.uniform3fv(shader.uniforms.volumeTexDimsFull, u.volumeTexDimsFull)
    if (shader.uniforms.chunkSubOrigin)
      gl.uniform3fv(shader.uniforms.chunkSubOrigin, u.chunkSubOrigin)
    if (shader.uniforms.chunkSubSize)
      gl.uniform3fv(shader.uniforms.chunkSubSize, u.chunkSubSize)
    if (shader.uniforms.dataOriginTexFrac)
      gl.uniform3fv(shader.uniforms.dataOriginTexFrac, u.dataOriginTexFrac)
    if (shader.uniforms.dataSizeTexFrac)
      gl.uniform3fv(shader.uniforms.dataSizeTexFrac, u.dataSizeTexFrac)
    if (shader.uniforms.rayStepTexVox)
      gl.uniform3fv(shader.uniforms.rayStepTexVox, u.rayStepTexVox)
    if (shader.uniforms.rayVoxSampleRate)
      gl.uniform1f(shader.uniforms.rayVoxSampleRate, this.sampleRate)
    if (shader.uniforms.layerGradMode)
      gl.uniform1f(shader.uniforms.layerGradMode, this.layerGradientMode)
    // Background-only alpha modulation from the precomputed gradient: 0 is a
    // no-op for both. Mirrors the offset-500/504 lanes in wgpu/render.ts.
    if (shader.uniforms.gradientOpacity)
      gl.uniform1f(shader.uniforms.gradientOpacity, this.gradientOpacity)
    if (shader.uniforms.silhouettePower)
      gl.uniform1f(shader.uniforms.silhouettePower, this.silhouette)
    const cubic =
      this.isCubicInterpolation &&
      this._cubicVolumeSafe &&
      u.cubicSafe !== false
    if (shader.uniforms.cubicFilter)
      gl.uniform1f(shader.uniforms.cubicFilter, cubic ? 1 : 0)
    // The shader raises the classified RGB to this power. Two exponents
    // compose here (pow is associative in the exponent): the reciprocal of the
    // user-facing display gamma, and this brick's per-level compensation for
    // the brightness a coarse pyramid level loses in the march. The latter is
    // 1 for every single-level and non-chunked draw.
    if (shader.uniforms.invGamma)
      gl.uniform1f(
        shader.uniforms.invGamma,
        invGamma(this.gamma) *
          lodGammaExponent(
            u.lodDownsample ?? 1,
            this.lodBrightnessCompensation,
          ),
      )
    // Scales the step-size opacity exponent for a coarse brick. 1 for every
    // single-level and non-chunked draw, and for the default coefficient of 0.
    if (shader.uniforms.lodOpacityScale)
      gl.uniform1f(
        shader.uniforms.lodOpacityScale,
        lodOpacityScale(u.lodDownsample ?? 1, this.lodOpacityCompensation),
      )
  }

  /**
   * Draw one chunked volume: one cube draw per chunk, composited back-to-
   * front. Each chunk binds its own volume + gradient textures and its own
   * chunk uniforms. Back-to-front order is required for the premultiplied-
   * alpha framebuffer blend to composite overlapping chunks correctly.
   */
  private _drawChunkedVolume(
    gl: WebGL2RenderingContext,
    shader: Shader,
    indexCount: number,
    rayDir: number[],
    matRAS: Float32Array,
    volScale: Float32Array | number[],
    entry: ChunkedTexEntry | null,
    overlayMode: boolean,
  ): void {
    if (!entry || entry.manager.chunkCount === 0) return
    const chunkCount = entry.manager.chunkCount
    // depthFunc ALWAYS (vs the global LESS): the per-chunk cube draws
    // composite back-to-front with OVER blending and must not depth-test
    // against each other, or a chunk behind an already-drawn chunk is
    // rejected and its contribution is lost. Restored to LESS after the loop.
    gl.depthFunc(gl.ALWAYS)
    // MIP: merge chunk draws (and the overlay entry's draws over the base) by
    // component-wise max instead of OVER — each cube emits its ray segment's
    // premultiplied maximum and the shader's own per-layer MIP rule is also
    // max, so MAX blending reconstructs the true full-ray maximum independent
    // of chunk draw order (OVER would let a high-alpha near chunk occlude a
    // brighter voxel in a farther chunk). Assumes a black tile behind the cube
    // (the classic MAX-blend MIP convention); non-chunked MIP composites OVER.
    // GL_MAX ignores the blend factors. Restored to FUNC_ADD after the loop.
    const mip = this.renderMode > 0.5
    if (mip) gl.blendEquation(gl.MAX)
    const explode = entry.volume.chunkExplode
    const order = chunksBackToFront(
      entry.plan,
      rayDir,
      chunkOffsetFor(entry.plan, explode),
      volScale,
    )
    // Per-chunk drawing/overlay/PAQD textures align 1:1 with the volume chunks
    // (shared ChunkPlan); when present, swap the matching texture unit so each
    // layer reads its own sub-texture. The overlay layer draws only its own
    // chunk volume, so these stay null (placeholders bound by the caller).
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
    // overlay unit is the streamed overlay's resident chunk i (placeholder until
    // it streams in). Takes precedence over the whole-reslice overlayChunks.
    const combinedOverlay =
      !overlayMode &&
      entry === this._activeChunked &&
      this._combinedOverlayEntries.length === 1
        ? this._combinedOverlayEntries[0]
        : null
    // Coarse floor: draw a coarse-floor cube for each base chunk region whose
    // fine chunk has not streamed in (instead of skipping it), so the 3D view
    // shows coarse detail immediately and never pops in from blank. A freshly-
    // resident fine chunk cross-fades in over its floor cube so detail dissolves
    // in instead of popping. Once settled, each region is drawn once (fine if
    // faded in, else coarse) — no steady-state double-exposure.
    const floorActive =
      !overlayMode &&
      entry === this._activeChunked &&
      this.coarseFloorTexture !== null &&
      this.coarseFloorGradientTexture !== null
    // Draw the coarse-floor cube for one chunk region: bind the coarse texture +
    // its gradient (transparent placeholders for overlay/paqd/drawing, guarded
    // off in the shader), sample at the chunk's full-volume fraction
    // (data{Origin,Size} = chunkSub{Origin,Size} => identity into the halo-less
    // coarse texture), full strength (fadeAlpha = 1). Restores the shared
    // overlay/paqd/drawing bindings afterward so a following fine chunk that has
    // no per-chunk layer texture still reads the caller's shared layers.
    const drawFloorCube = (chunkIndex: number): void => {
      const floorTex = this.coarseFloorTexture
      if (!floorTex) return
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_3D, floorTex)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_3D, this.coarseFloorGradientTexture ?? floorTex)
      for (const unit of [gl.TEXTURE3, gl.TEXTURE4, gl.TEXTURE5, gl.TEXTURE7]) {
        gl.activeTexture(unit)
        gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
      }
      const cu = chunkUniformsFor(entry.plan, chunkIndex)
      this._setChunkUniforms(gl, shader, {
        volumeTexDimsFull: cu.volumeTexDimsFull,
        chunkSubOrigin: cu.chunkSubOrigin,
        chunkSubSize: cu.chunkSubSize,
        dataOriginTexFrac: cu.chunkSubOrigin,
        dataSizeTexFrac: cu.chunkSubSize,
        // March at the floor texture's OWN voxel density, not the fine common
        // grid: the step-size correction turns each step into an optical depth
        // of `fineVoxels / steps` reference steps, so oversampling a 64x coarser
        // texture drives the first in-tissue sample to alpha 1 and the cube
        // renders as a dark surface shell instead of an integrated backdrop.
        rayStepTexVox: this.coarseFloorDims ?? cu.volumeTexDimsFull,
        // The floor is not a member of `plan.chunks`, so its downsample
        // comes from its own dims. It is usually the coarsest data on
        // screen: uncompensated, it puts the scene's largest brightness
        // step right at the edge of the resident fine region.
        lodDownsample: this.coarseFloorDims
          ? dimsDownsample(entry.plan.volumeDims, this.coarseFloorDims)
          : 1,
        // The floor is one whole-volume texture, so the cubic kernel is always
        // safely fed here. It still follows the fine bricks' verdict: when their
        // halo is too thin and cubic is refused, a cubic floor under trilinear
        // bricks would put a reconstruction change exactly at the edge of the
        // resident region. One filter per volume, always.
        cubicSafe: entry.cubicSafe,
      })
      if (shader.uniforms.fadeAlpha)
        gl.uniform1f(shader.uniforms.fadeAlpha, 1.0)
      if (shader.uniforms.matRAS) {
        gl.uniformMatrix4fv(
          shader.uniforms.matRAS,
          false,
          chunkExplodedMatRAS(entry.plan, chunkIndex, matRAS, explode),
        )
      }
      gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
      // Restore the shared layer bindings the caller set before the loop.
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(
        gl.TEXTURE_3D,
        this.overlayTexture || this.placeholderOverlay,
      )
      gl.activeTexture(gl.TEXTURE4)
      gl.bindTexture(gl.TEXTURE_3D, this.paqdTexture || this.placeholderOverlay)
      const drawTex = this.drawingTexture || this.placeholderOverlay
      gl.activeTexture(gl.TEXTURE5)
      gl.bindTexture(gl.TEXTURE_3D, drawTex)
      gl.activeTexture(gl.TEXTURE7)
      gl.bindTexture(gl.TEXTURE_3D, drawTex)
    }
    for (const chunkIndex of order) {
      const chunk = entry.manager.getChunk(chunkIndex)
      if (!chunk) {
        if (floorActive) drawFloorCube(chunkIndex)
        continue
      }
      // Cross-fade a freshly-resident fine chunk in over its coarse floor: draw
      // the floor cube first (full strength), then the fine cube over it with
      // premultiplied weight `fade`. Settled (fade === 1) => fine only.
      const fade = floorActive
        ? entry.manager.fadeFraction(
            chunkIndex,
            this._frameNow,
            this.chunkFadeMs,
          )
        : 1
      if (fade < 1) {
        drawFloorCube(chunkIndex)
        this._fadeActive = true
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_3D, chunk.volumeTexture)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_3D, chunk.volumeGradientTexture)
      if (combinedOverlay) {
        gl.activeTexture(gl.TEXTURE3)
        gl.bindTexture(
          gl.TEXTURE_3D,
          combinedOverlay.manager.getChunk(chunkIndex)?.volumeTexture ??
            this.placeholderOverlay,
        )
      } else if (overlayChunks) {
        gl.activeTexture(gl.TEXTURE3)
        gl.bindTexture(gl.TEXTURE_3D, overlayChunks[chunkIndex])
      }
      if (paqdChunks) {
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_3D, paqdChunks[chunkIndex])
      }
      if (drawingChunks) {
        gl.activeTexture(gl.TEXTURE5)
        gl.bindTexture(gl.TEXTURE_3D, drawingChunks[chunkIndex])
        gl.activeTexture(gl.TEXTURE7)
        gl.bindTexture(gl.TEXTURE_3D, drawingChunks[chunkIndex])
      }
      this._setChunkUniforms(gl, shader, {
        ...chunkUniformsFor(entry.plan, chunkIndex),
        cubicSafe: entry.cubicSafe,
      })
      if (shader.uniforms.fadeAlpha)
        gl.uniform1f(shader.uniforms.fadeAlpha, fade)
      if (shader.uniforms.matRAS) {
        gl.uniformMatrix4fv(
          shader.uniforms.matRAS,
          false,
          chunkExplodedMatRAS(entry.plan, chunkIndex, matRAS, explode),
        )
      }
      gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
    }
    if (mip) gl.blendEquation(gl.FUNC_ADD)
    gl.depthFunc(gl.LESS)
  }

  /**
   * Draw the independently-streamed hi-res overlay as its own translucent
   * chunk cubes over the base, in the same pass. matRAS is the OVERLAY volume's
   * matRAS (its own grid); the camera (mvp/volScale/rayDir) is shared with the
   * base tile. No-op when no chunked overlay is active. Must be called after
   * draw() for the same tile so it composites over the base.
   *
   * Compositing-order limitation: the base and overlay cube sets are each
   * sorted back-to-front internally, but the overlay set is drawn entirely
   * after the base, so per-pixel the overlay always composites over the base
   * regardless of true depth (mirrors the per-chunk back-to-front approximation
   * between neighbouring base chunks). A globally-merged order is future work.
   */
  drawOverlayChunked(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    normalMatrix: Float32Array,
    matRAS: Float32Array,
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
    const entry = this._activeOverlayChunked
    if (!entry) return
    if (!this.isReady || !this.shader || !this.cubeVAO || !this.indexBuffer)
      return
    if (!this.matcapTexture || !this.placeholderOverlay) return

    const shader = this.shader
    const indexCount = this.cube.indices.length
    shader.use(gl)

    // Sampler unit assignments (volume + gradient bound per chunk in the loop).
    if (shader.uniforms.volume) gl.uniform1i(shader.uniforms.volume, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.matcapTexture)
    if (shader.uniforms.matcap) gl.uniform1i(shader.uniforms.matcap, 1)
    if (shader.uniforms.volumeGradient)
      gl.uniform1i(shader.uniforms.volumeGradient, 2)
    // The overlay layer draws only its own chunk volume — bind the transparent
    // placeholder to the optional overlay/paqd/drawing units so those shader
    // passes stay inert.
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
    if (shader.uniforms.overlay) gl.uniform1i(shader.uniforms.overlay, 3)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
    if (shader.uniforms.paqd) gl.uniform1i(shader.uniforms.paqd, 4)
    gl.activeTexture(gl.TEXTURE5)
    gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
    if (shader.uniforms.drawing) gl.uniform1i(shader.uniforms.drawing, 5)
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
    if (shader.uniforms.drawingLinear)
      gl.uniform1i(shader.uniforms.drawingLinear, 7)
    gl.activeTexture(gl.TEXTURE6)
    gl.bindTexture(gl.TEXTURE_2D, null)
    if (shader.uniforms.paqdLut) gl.uniform1i(shader.uniforms.paqdLut, 6)

    // Scalar uniforms. overlayLayerMode=1 makes the shader skip the base
    // clip-surface/AO path and force flat (unlit) translucent compositing, so
    // gradientAmount is passed through but has no effect in overlay mode.
    if (shader.uniforms.mvpMtx)
      gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
    if (shader.uniforms.normMtx)
      gl.uniformMatrix4fv(shader.uniforms.normMtx, false, normalMatrix)
    if (shader.uniforms.volScale)
      gl.uniform3fv(shader.uniforms.volScale, volScale as Float32Array)
    const rayDirVec = (rayDir ?? [0, 0, 1]) as number[]
    if (shader.uniforms.rayDir)
      gl.uniform3fv(shader.uniforms.rayDir, rayDirVec.slice(0, 3))
    if (shader.uniforms.gradientAmount)
      gl.uniform1f(shader.uniforms.gradientAmount, gradientAmount)
    if (shader.uniforms.numVolumes)
      gl.uniform1f(shader.uniforms.numVolumes, volumeCount)
    if (shader.uniforms.clipPlanes)
      gl.uniform4fv(shader.uniforms.clipPlanes, clipPlanes)
    if (shader.uniforms.clipPlaneColor)
      gl.uniform4fv(shader.uniforms.clipPlaneColor, clipPlaneColor)
    if (shader.uniforms.isClipCutaway)
      gl.uniform1f(shader.uniforms.isClipCutaway, isClipCutaway ? 1.0 : 0.0)
    if (shader.uniforms.clipPlaneOverlay)
      gl.uniform1f(
        shader.uniforms.clipPlaneOverlay,
        this.clipPlaneOverlay ? 1.0 : 0.0,
      )
    if (shader.uniforms.overlayLayerMode)
      gl.uniform1f(shader.uniforms.overlayLayerMode, 1.0)
    if (shader.uniforms.renderMode)
      gl.uniform1f(shader.uniforms.renderMode, this.renderMode)
    if (shader.uniforms.paqdUniforms)
      gl.uniform4fv(shader.uniforms.paqdUniforms, paqdUniforms as number[])
    if (shader.uniforms.earlyTermination)
      gl.uniform1f(shader.uniforms.earlyTermination, earlyTermination)
    // Explicitly neutral, not merely omitted: these cubes share the program
    // with draw(), so an unset uniform would keep the base volume's opacity
    // from the previous draw. This layer's own opacity is already baked into
    // its chunk textures by rebakeChunkedOverlays.
    if (shader.uniforms.backOpacity)
      gl.uniform1f(shader.uniforms.backOpacity, 1.0)

    gl.bindVertexArray(this.cubeVAO)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    this._drawChunkedVolume(
      gl,
      shader,
      indexCount,
      rayDirVec,
      matRAS,
      volScale,
      entry,
      true,
    )
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(null)
  }

  drawDepthPick(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    matRAS: Float32Array,
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    clipPlanes: number[],
    isClipCutaway = false,
    volumeCount = 1,
  ): void {
    if (
      !this.isReady ||
      !this.depthPickShaderProgram ||
      !this.cubeVAO ||
      !this.indexBuffer
    )
      return
    if (!this.volumeTexture) return

    const shader = this.depthPickShaderProgram
    const indexCount = this.cube.indices.length

    shader.use(gl)

    // Bind volume texture
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture)
    if (shader.uniforms.volume) gl.uniform1i(shader.uniforms.volume, 0)

    // Bind overlay texture
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this.overlayTexture || this.placeholderOverlay,
    )
    if (shader.uniforms.overlay) gl.uniform1i(shader.uniforms.overlay, 1)

    // Upload uniforms
    if (shader.uniforms.mvpMtx)
      gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
    if (shader.uniforms.matRAS)
      gl.uniformMatrix4fv(shader.uniforms.matRAS, false, matRAS)
    if (shader.uniforms.volScale)
      gl.uniform3fv(shader.uniforms.volScale, volScale as Float32Array)
    const rayDirVec = rayDir ?? [0, 0, 1]
    if (shader.uniforms.rayDir)
      gl.uniform3fv(shader.uniforms.rayDir, (rayDirVec as number[]).slice(0, 3))
    if (shader.uniforms.clipPlanes)
      gl.uniform4fv(shader.uniforms.clipPlanes, clipPlanes)
    if (shader.uniforms.isClipCutaway)
      gl.uniform1f(shader.uniforms.isClipCutaway, isClipCutaway ? 1.0 : 0.0)
    if (shader.uniforms.clipPlaneOverlay)
      gl.uniform1f(
        shader.uniforms.clipPlaneOverlay,
        this.clipPlaneOverlay ? 1.0 : 0.0,
      )
    if (shader.uniforms.numVolumes)
      gl.uniform1f(shader.uniforms.numVolumes, volumeCount)
    // Depth pick uses a single volume texture; pass identity chunk uniforms
    // so the shared vertex shader / preamble run in non-chunked mode.
    this._setChunkUniforms(gl, shader, {
      volumeTexDimsFull: this._activeDims,
      chunkSubOrigin: [0, 0, 0],
      chunkSubSize: [1, 1, 1],
      dataOriginTexFrac: [0, 0, 0],
      dataSizeTexFrac: [1, 1, 1],
      rayStepTexVox: this._activeDims,
    })

    // Draw
    gl.bindVertexArray(this.cubeVAO)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
    gl.bindVertexArray(null)
  }

  async loadMatcap(
    gl: WebGL2RenderingContext,
    matcapUrl: string,
  ): Promise<void> {
    if (!this.isReady) return

    try {
      const newTex = await this._loadTexture2DOrFallback(gl, matcapUrl)
      if (this.matcapTexture) gl.deleteTexture(this.matcapTexture)
      this.matcapTexture = newTex
      this._matcapUrl = matcapUrl
    } catch (e) {
      log.warn('Matcap load failed', e)
    }
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

  updateDrawingTexture(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    dims: number[],
    plan?: ChunkPlan,
    dirtyChunks?: readonly number[],
  ): void {
    if (!this.isReady) return
    if (plan) {
      this._updateDrawingChunks(gl, rgba, dims, plan, dirtyChunks)
      return
    }
    // Non-chunked path: switching back from a chunked volume frees the
    // per-chunk drawing textures so only one representation is live.
    this._destroyDrawingChunks(gl)
    if (this.drawingTexture) {
      gl.bindTexture(gl.TEXTURE_3D, this.drawingTexture)
      gl.texSubImage3D(
        gl.TEXTURE_3D,
        0,
        0,
        0,
        0,
        dims[0],
        dims[1],
        dims[2],
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        rgba,
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    } else {
      this.drawingTexture = this._createDrawingTexture(
        gl,
        rgba,
        dims[0],
        dims[1],
        dims[2],
      )
    }
  }

  /**
   * Build (or refresh) one RGBA8 drawing texture per chunk. The drawing layer
   * shares the background volume's ChunkPlan, so chunk indices and texDims
   * line up with the volume chunks. Each chunk's halo+data region is sliced
   * out of the full-volume RGBA buffer with extractChunkBytes (4 bytes/voxel).
   */
  private _updateDrawingChunks(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    dims: number[],
    plan: ChunkPlan,
    dirtyChunks?: readonly number[],
  ): void {
    // Switching to chunked frees the single-texture representation.
    if (this.drawingTexture) {
      gl.deleteTexture(this.drawingTexture)
      this.drawingTexture = null
    }
    const volumeDims: Vec3i = [dims[0], dims[1], dims[2]]
    const reuse =
      this.drawingChunks !== null &&
      this.drawingChunks.length === plan.chunks.length
    if (!reuse) this._destroyDrawingChunks(gl)
    const chunks: WebGLTexture[] = reuse ? (this.drawingChunks ?? []) : []
    // Reusing textures: a pen stroke only dirties a few chunks; re-upload just
    // those. A fresh build (!reuse) creates every chunk in ascending order.
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
      if (reuse) {
        gl.bindTexture(gl.TEXTURE_3D, chunks[i])
        gl.texSubImage3D(
          gl.TEXTURE_3D,
          0,
          0,
          0,
          0,
          tx,
          ty,
          tz,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bytes,
        )
        gl.bindTexture(gl.TEXTURE_3D, null)
      } else {
        const tex = this._createDrawingTexture(gl, bytes, tx, ty, tz)
        if (tex) chunks.push(tex)
      }
    }
    this.drawingChunks = chunks
  }

  /** Create an RGBA8 3D drawing texture (NEAREST filter, clamp-to-edge). */
  private _createDrawingTexture(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    width: number,
    height: number,
    depth: number,
  ): WebGLTexture | null {
    const tex = gl.createTexture()
    if (!tex) return null
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      width,
      height,
      depth,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    )
    gl.bindTexture(gl.TEXTURE_3D, null)
    return tex
  }

  destroyDrawing(gl: WebGL2RenderingContext): void {
    if (this.drawingTexture) {
      gl.deleteTexture(this.drawingTexture)
      this.drawingTexture = null
    }
    this._destroyDrawingChunks(gl)
  }

  /** Release all per-chunk drawing textures from a previous build. */
  private _destroyDrawingChunks(gl: WebGL2RenderingContext): void {
    if (!this.drawingChunks) return
    for (const tex of this.drawingChunks) gl.deleteTexture(tex)
    this.drawingChunks = null
  }

  destroy(): void {
    const gl = this._gl
    if (!gl) return
    // Delete VAO
    if (this.cubeVAO) gl.deleteVertexArray(this.cubeVAO)
    this.cubeVAO = null

    // Delete buffers
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer)
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer)
    this.vertexBuffer = null
    this.indexBuffer = null

    // Delete textures (cache owns volume + gradient textures)
    if (this.matcapTexture) gl.deleteTexture(this.matcapTexture)
    this._matcapUrl = null
    // _texCache owns chunked + per-volume 'single' entry textures, so freeing
    // the cache covers any this.volumeTexture / this.volumeGradientTexture
    // pointers that alias cache entries.
    for (const entry of this._texCache.values()) {
      this._destroyTexEntry(gl, entry)
    }
    this._texCache.clear()
    this._activeChunked = null
    this._activeOverlayChunked = null
    this._combinedOverlayEntries = []
    this.volumeTexture = null
    if (this.volumeGradientTexture) gl.deleteTexture(this.volumeGradientTexture)
    this.volumeGradientTexture = null
    // Release the non-chunked orient-texture cache (normal single-volume path).
    this.clearVolume(gl)
    if (this.coarseFloorTexture) gl.deleteTexture(this.coarseFloorTexture)
    if (this.coarseFloorGradientTexture)
      gl.deleteTexture(this.coarseFloorGradientTexture)
    this.coarseFloorTexture = null
    this.coarseFloorGradientTexture = null
    this.coarseFloorDims = null
    this._coarseFloorKey = null
    this.clearOverlay(gl)
    if (this.paqdTexture) gl.deleteTexture(this.paqdTexture)
    this._destroyPaqdChunks(gl)
    if (this.drawingTexture) gl.deleteTexture(this.drawingTexture)
    this._destroyDrawingChunks(gl)
    if (this.drawingLinearSampler) gl.deleteSampler(this.drawingLinearSampler)
    if (this.placeholderOverlay) gl.deleteTexture(this.placeholderOverlay)
    this.matcapTexture = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.overlayTexture = null
    this.paqdTexture = null
    this.drawingTexture = null
    this.drawingLinearSampler = null
    this.placeholderOverlay = null

    // Delete shader program
    if (this.shader?.program) gl.deleteProgram(this.shader.program)
    this.shader = null

    // Destroy module resources
    orientOverlay.destroy(gl)
    gradient.destroy(gl)

    this.isReady = false
    this._gl = null
  }
}
