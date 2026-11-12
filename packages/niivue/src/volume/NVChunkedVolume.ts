import { mat4, vec3 } from 'gl-matrix'
import * as NVCmaps from '@/cmap/NVCmaps'
import { log } from '@/logger'
import { SLICE_TYPE } from '@/NVConstants'
import type NiiVue from '@/NVControlBase'
import type { PropertyChangeDetail } from '@/NVEvents'
import type {
  NVImage,
  TypedVoxelArray,
  VolumeChunkSource,
  VolumeSourceDescriptor,
} from '@/NVTypes'
import type {
  BudgetPlan,
  BudgetPlanContext,
  BudgetPlanOptions,
  BudgetPlanSpec,
  PlanShapeOptions,
  ResolvedOptions,
  SwapPolicy,
} from './budgetPlans'
import { resolveBudgetPlan } from './budgetPlans'
import type { ChunkedVolumeSource } from './ChunkedVolumeSource'
import {
  type ChunkPlan,
  CUBIC_MIN_HALO,
  chunkVolumeMultiLOD,
  type MultiLodBounds,
  type Vec3f,
  type Vec3i,
} from './chunking'
import { createStreamingNVImage } from './streamingVolume'
import {
  getBitsPerVoxel,
  getTypedArrayConstructor,
  robustDisplayWindow,
} from './utils'

/**
 * Options for {@link NiiVue.loadChunkedVolume}. The plan-shaping half lives in
 * {@link BudgetPlanOptions} (`budgetPlan` plus the individual knobs it layers
 * under); everything here is display state for the streamed volume itself.
 */
/** `v` when it is a finite number, else `fallback` (unset, NaN or null). */
function windowOr(v: number | null | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function sameRadius(a: number | Vec3f, b: number | Vec3f): boolean {
  if (typeof a === 'number' || typeof b === 'number') return a === b
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

export interface ChunkedVolumeOptions extends BudgetPlanOptions {
  /**
   * Display window minimum. Unset: a CT colormap's window, else the sampled
   * data's robust minimum. NaN (or null): the sampled robust minimum.
   */
  calMin?: number
  /**
   * Display window maximum. Unset: a CT colormap's window, else the sampled
   * data's robust maximum. NaN (or null): the sampled robust maximum.
   */
  calMax?: number
  /** Colormap name (default 'gray'). */
  colormap?: string
  /** Layer opacity 0-1 (default 1). */
  opacity?: number
  /** Whether values below calMin are transparent (default true). */
  isTransparentBelowCalMin?: boolean
  /** Display name / id for the volume (default 'chunked volume'). */
  name?: string
  id?: string
  /**
   * Regions (common-grid voxels, min inclusive / max exclusive) that must be
   * covered by ONE uniform pyramid level, e.g. one thin slab per visible
   * orthogonal slice so no slice shows a seam between two resolutions. The
   * budget pass may coarsen a bound as a whole but never mixes levels inside
   * it. Replaced per refocus via {@link NVChunkedVolume.setFocus}. Default none.
   */
  focusBounds?: MultiLodBounds[]
  /** Max concurrent source fetches (default 6; bounds the request flood). */
  maxConcurrentLoads?: number
  /** Retry attempts for a transient fetch failure (default 3, exp backoff). */
  retryAttempts?: number
  /** First time point shown (default 0); see {@link NVChunkedVolume.setFrame}. */
  frame?: number
  /**
   * Volumes whose frame sources share this object switch time points together
   * (`setFrame4D` on any member moves all). Default: this volume alone.
   */
  frameGroup?: object
  /**
   * Bytes of the current plan's bricks a frame switch fetches before it
   * commits, nearest the focus first (default 64 MiB), for the whole frame
   * group, floors included. The rest stream after. Floor: every member
   * always stages its floor and one brick, so a group of n stages at least
   * n of each whatever this says.
   */
  frameStagingBytes?: number
  /**
   * Cap on the decoded bytes the exact voxel readout keeps (default 384 MiB,
   * the decoded tier's cap), shared by every streamed volume of the viewer.
   */
  readoutBytes?: number
  /** Saved in documents so `loadDocument` can reopen this volume. */
  descriptor?: VolumeSourceDescriptor
}

/** Default {@link ChunkedVolumeOptions.frameStagingBytes}. */
const FRAME_STAGING_BYTES = 64 * 1024 ** 2

/** What a frame switch fetched before it commits. */
interface StagedFrame {
  bricks: Map<string, Uint8Array>
  floor: NVImage | null
  /** The window probe re-read for the frame, when there is no floor. */
  probe: NVImage | null
}

/**
 * Size guards for the auto-built coarse floor. It is oriented into ONE RGBA
 * texture, so 256^3 voxels costs ~67 MB — negligible beside the default brick
 * budget — while the edge cap keeps it inside the 3D texture dimension every
 * WebGL2/WebGPU device in practice provides. A pyramid whose COARSEST level is
 * bigger than this gets no floor rather than a multi-second stall on load.
 */
const COARSE_FLOOR_MAX_VOXELS = 256 ** 3
const COARSE_FLOOR_MAX_EDGE = 512

/**
 * Edge cap for the window probe used when there is NO coarse floor to read
 * (the floor was disabled, or the coarsest level is over the floor caps above).
 * A centred crop of the coarsest level, capped here, is enough to place a
 * 2%-98% window and costs one bounded fetch.
 */
const WINDOW_PROBE_MAX_EDGE = 64

/** Host settings that decide whether chunks carry a gradient texture. */
const LIGHTING_PROPERTIES = new Set([
  'volumeIllumination',
  'volumeGradientOpacity',
  'volumeSilhouette',
])

// --- pure helpers (unit-tested; no controller needed) -----------------------

/**
 * Nudge a focus centre off exact octree cell boundaries. A focus ball straddling
 * a boundary forces the bricks on BOTH sides to the finest level, which can blow
 * the budget and collapse the whole plan to a coarse floor; the small asymmetric
 * bias keeps the finest core inside one cell so the brick count stays stable.
 * The centre always stays inside [0, common] per axis: on a thin axis whose
 * extent is below the bias band (common < 2*bias) the clamp collapses to
 * common/2, so the focus is never pushed outside the volume (which would
 * inflate every brick's distance on that axis and starve the finest core).
 */
export function focusCenterBiased(
  common: Vec3i,
  frac: Vec3f,
  cellEdge: number,
): Vec3f {
  const bias: Vec3f = [cellEdge * 0.31, cellEdge * 0.17, cellEdge * 0.23]
  const axis = (i: number): number => {
    const lo = Math.min(bias[i], common[i] / 2)
    const hi = Math.max(common[i] - bias[i], common[i] / 2)
    return Math.min(hi, Math.max(lo, frac[i] * common[i] + bias[i]))
  }
  return [axis(0), axis(1), axis(2)]
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/**
 * Convert a world-mm point to a volume's [0,1] texture fraction via the inverse
 * of its `frac2mm`, so the focus is correct even when the streamed volume does
 * not span the scene AABB or sits on a non-identity-oriented grid. Returns null
 * when `frac2mm` is singular. Clamps to [0,1]: a crosshair outside the volume
 * yields an edge focus, never an off-grid centre.
 */
export function mmToVolumeFraction(frac2mm: mat4, mm: Vec3f): Vec3f | null {
  const inv = mat4.create()
  if (!mat4.invert(inv, frac2mm)) return null
  const out = vec3.create()
  vec3.transformMat4(out, vec3.fromValues(mm[0], mm[1], mm[2]), inv)
  return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])]
}

/** Deep-copy caller bounds so a later mutation cannot alter a stored focus. */
function cloneBounds(bounds: MultiLodBounds[] | undefined): MultiLodBounds[] {
  return (bounds ?? []).map((b) => ({
    min: [b.min[0], b.min[1], b.min[2]],
    max: [b.max[0], b.max[1], b.max[2]],
  }))
}

/**
 * Build a crosshair-focused multi-LOD plan for a source at a focus + radius.
 * Takes only the plan-shaping options: the coarse floor is a display backdrop,
 * not an input to the octree.
 *
 * The octree is subdivided around a BIASED centre (see {@link focusCenterBiased})
 * for stability, while the exact focus is passed as `reserveCenter` so the
 * brick under the crosshair is always at the finest level. A `'none'` focus has
 * no crosshair to reserve, so no finest-detail branch is pinned (whether the
 * plan is uniform still depends on `radius` and the other options).
 * `focusBounds` are passed
 * through as `reserveBounds` (see {@link MultiLodFocus.reserveBounds}).
 */
export function planForFocus(
  source: ChunkedVolumeSource,
  focusFrac: Vec3f,
  radius: number | Vec3f,
  o: PlanShapeOptions & Partial<Pick<ResolvedOptions, 'focus'>>,
  focusBounds?: MultiLodBounds[],
  bytesPerVoxel = 8,
): ChunkPlan {
  const levelDims = source.levels.map((l) => l.shape)
  const common = levelDims[0]
  const center = focusCenterBiased(common, focusFrac, o.cellEdge)
  // Clamp just inside the volume so the point always falls in some brick.
  const reserveCenter: Vec3f | undefined =
    o.focus === 'none'
      ? undefined
      : [
          Math.max(0, Math.min(common[0] - 1e-3, focusFrac[0] * common[0])),
          Math.max(0, Math.min(common[1] - 1e-3, focusFrac[1] * common[1])),
          Math.max(0, Math.min(common[2] - 1e-3, focusFrac[2] * common[2])),
        ]
  return chunkVolumeMultiLOD(
    levelDims,
    {
      center,
      radius,
      // A bounds reservation supersedes the centre branch (the planner ignores
      // reserveCenter when bounds are present), so skip the dead work.
      reserveCenter: focusBounds?.length ? undefined : reserveCenter,
      reserveBounds: focusBounds,
    },
    o.deviceLimit,
    {
      cellEdge: o.cellEdge,
      gridDims: o.gridDims,
      haloSize: o.halo,
      detail: o.detail,
      minLevel: o.minLevel,
      budgetBytes: o.budgetBytes,
      bytesPerVoxel,
      maxBricks: o.maxBricks,
    },
  )
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Base of withRetry's exponential backoff: 80, 160, 320 ms, ... */
const RETRY_BASE_DELAY_MS = 80

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs = RETRY_BASE_DELAY_MS,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // An abort is the caller saying it no longer wants the bytes. Retrying
      // it would re-issue a read nobody is waiting for.
      if (err instanceof Error && err.name === 'AbortError') throw err
      // A refused/dropped connection under load ("Failed to fetch" / TypeError)
      // is transient; a real error (bad range, decode, 404-as-throw) is not.
      const transient =
        err instanceof TypeError ||
        (err instanceof Error && /failed to fetch/i.test(err.message))
      if (!transient || i === attempts - 1) throw err
      await delay(baseDelayMs * 2 ** i)
    }
  }
  throw lastErr
}

/**
 * Coerce a caller-supplied count option to a finite positive integer.
 *
 * Both consumers are safety limits, so every unusable input has to land on a
 * value that still makes progress and still bounds the work:
 *  - 0, negative, NaN, fractional: a 0 concurrency cap would deadlock
 *    acquire() — no slot ever frees, so no fetch ever starts — and 0 attempts
 *    would fetch nothing at all.
 *  - Infinity: it survives both Math.floor and Math.max, and would defeat the
 *    very limit it is asked to impose — an unbounded concurrency cap floods
 *    the connection pool, and unbounded attempts retry a transient failure
 *    forever on a backoff that overflows to Infinity (a delay that never
 *    resolves, hanging that read for good).
 */
function positiveIntOption(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.floor(value) || 1)
}

/** One region read of a {@link ChunkedVolumeSource}: level, region and frame. */
export interface SourceRegionRead {
  levelIndex: number
  texOrigin: Vec3i
  texDims: Vec3i
  bytesPerVoxel: number
  frame: number
  signal?: AbortSignal
}

interface SourceReaderOptions {
  maxConcurrentLoads: number
  retryAttempts: number
  /**
   * Base of the retry backoff in ms (default RETRY_BASE_DELAY_MS). Only
   * tests pass it, so a retry does not wait out the real backoff.
   */
  retryDelayMs?: number
  /** Called once per decoded region, however many requests share it. */
  onChunk?: (bytes: Uint8Array, req: SourceRegionRead) => void
}

/**
 * Read regions of a {@link ChunkedVolumeSource}: bound in-flight fetches to
 * `maxConcurrentLoads` (so a big focus never floods the connection pool),
 * retry transient failures, and dedup concurrent requests for the same region
 * and frame. In-flight entries are dropped on settle so resolved buffers are
 * not retained (residency/eviction is the renderer's job). One reader serves
 * every frame, so the bound holds across a time scrub.
 */
export function createSourceRegionReader(
  source: ChunkedVolumeSource,
  opts: SourceReaderOptions,
): (req: SourceRegionRead) => Promise<Uint8Array> {
  // Clamp at the point the options are consumed; see positiveIntOption.
  const maxConcurrent = positiveIntOption(opts.maxConcurrentLoads)
  const totalAttempts = positiveIntOption(opts.retryAttempts)
  // One entry per in-flight REGION, which several chunk requests may share (a
  // plan swap changes the chunk index but not the region). `waiters` counts
  // the callers still interested: the underlying read is aborted only when the
  // last of them gives up, so one cancelled chunk cannot cancel its twin.
  const inflight = new Map<string, InflightRead>()
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = (): Promise<void> => {
    if (active < maxConcurrent) {
      active++
      return Promise.resolve()
    }
    // At capacity: queue WITHOUT incrementing. release() hands a waiter the freed
    // slot directly (active unchanged on hand-off), so `active` can never exceed
    // the cap through a deferred increment.
    return new Promise<void>((resolve) => waiters.push(resolve))
  }
  const release = (): void => {
    const nextWaiter = waiters.shift()
    if (nextWaiter) nextWaiter()
    else active--
  }

  return (req) => {
    const { levelIndex, texOrigin, texDims, bytesPerVoxel, frame, signal } = req
    // Content key (frame + level + region), stable across plan swaps where
    // the chunk INDEX changes but the fetched region does not.
    const key = `${frame}|${levelIndex}|${texOrigin.join(',')}|${texDims.join(',')}`
    const cached = inflight.get(key)
    // An aborted read only settles to its AbortError: start a fresh one.
    if (cached && !cached.controller.signal.aborted) {
      cached.waiters++
      return joinRead(cached, signal)
    }
    const controller = new AbortController()
    const promise = acquire()
      .then(() => {
        // Withdrawn while queued: give the slot back without fetching.
        if (controller.signal.aborted) throw controller.signal.reason
        return withRetry(
          () =>
            source.fetchChunk({
              levelIndex,
              texOrigin,
              texDims,
              bytesPerVoxel,
              signal: controller.signal,
              ...(frame !== 0 && { frame }),
            }),
          totalAttempts,
          opts.retryDelayMs,
        )
      })
      .finally(() => release())
    const entry: InflightRead = { promise, controller, waiters: 1 }
    inflight.set(key, entry)
    const joined = joinRead(entry, signal)
    // Drop the in-flight entry on settle. Attach cleanup as BOTH handlers of a
    // .then so the derived promise resolves even when `promise` rejects (a
    // brick that exhausts retries) — a bare `.finally` here would re-raise into
    // an unobserved promise. Callers still receive the original promise (and
    // its rejection); this derived promise is intentionally not returned.
    const cleanup = (): void => {
      if (inflight.get(key) === entry) inflight.delete(key)
    }
    promise.then(cleanup, cleanup)
    const onChunk = opts.onChunk
    if (onChunk)
      promise.then(
        (bytes) => onChunk(bytes, req),
        () => {},
      )
    return joined
  }
}

/**
 * The renderer `VolumeChunkSource` for one frame: dispatch each brick to its
 * own pyramid level (`desc.sourceLevel`) through `read`. `staged` holds bricks
 * a frame switch fetched before it committed; each is handed out once.
 */
function frameChunkLoader(
  read: (req: SourceRegionRead) => Promise<Uint8Array>,
  frame: number,
  staged?: Map<string, Uint8Array>,
): VolumeChunkSource {
  return (request) => {
    const levelIndex = request.desc.sourceLevel ?? 0
    const { texOrigin, texDims } = request.desc
    if (staged?.size) {
      const key = regionKey(levelIndex, texOrigin, texDims)
      const bytes = staged.get(key)
      if (bytes) {
        staged.delete(key)
        return Promise.resolve(bytes)
      }
    }
    return read({
      levelIndex,
      texOrigin,
      texDims,
      bytesPerVoxel: request.bytesPerVoxel,
      frame,
      signal: request.signal,
    })
  }
}

function regionKey(levelIndex: number, origin: Vec3i, dims: Vec3i): string {
  return `${levelIndex}|${origin.join(',')}|${dims.join(',')}`
}

function chunkRegionKeys(plan: ChunkPlan): string[] {
  return plan.chunks.map((c) =>
    regionKey(c.sourceLevel ?? 0, c.texOrigin, c.texDims),
  )
}

/**
 * Wrap a {@link ChunkedVolumeSource} as a renderer `VolumeChunkSource` for
 * `opts.frame` (default 0); see {@link createSourceRegionReader}.
 */
export function createSourceChunkLoader(
  source: ChunkedVolumeSource,
  opts: SourceReaderOptions & { frame?: number },
): VolumeChunkSource {
  return frameChunkLoader(
    createSourceRegionReader(source, opts),
    opts.frame ?? 0,
  )
}

/** One in-flight region read, shared by every caller that asked for it. */
interface InflightRead {
  promise: Promise<Uint8Array>
  controller: AbortController
  waiters: number
}

/**
 * Register one caller's interest in an in-flight read, and abort the read once
 * every caller has withdrawn. A caller with no signal never withdraws, so a
 * renderer that supplies none behaves exactly as it did before. Returns the
 * read as this caller sees it.
 */
function joinRead(
  entry: InflightRead,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (!signal) return entry.promise
  const withdraw = (): void => {
    entry.waiters--
    if (entry.waiters <= 0) entry.controller.abort(signal.reason)
  }
  if (signal.aborted) {
    withdraw()
    return Promise.reject(signal.reason)
  }
  // The caller's own abort rejects its read at once; the shared read goes on
  // while another caller still wants it.
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      withdraw()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    entry.promise.then(
      (bytes) => {
        signal.removeEventListener('abort', onAbort)
        resolve(bytes)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

// --- the manager ------------------------------------------------------------

/**
 * A crosshair-focused multi-resolution (multi-LOD) streamed volume. Built by
 * {@link NiiVue.loadChunkedVolume}. Owns the octree plan, per-level fetch
 * dispatch (bounded/retried/deduped), and — for `focus: 'crosshair'` — rebuilds
 * and swaps the plan in place as the crosshair moves, so the finest bricks track
 * where the user is looking while resident VRAM stays bounded by the budget.
 */
export class NVChunkedVolume {
  readonly volume: NVImage

  private volumeId: string
  private readonly host: NiiVue
  private readonly source: ChunkedVolumeSource
  private readonly o: ResolvedOptions
  /** The options this volume was loaded with; re-folded by {@link setBudgetPlan}. */
  private readonly loadOptions: ChunkedVolumeOptions
  private followCrosshair: boolean
  private subscribedToCrosshair = false
  private subscribedToView = false
  private readonly onLocationChange: () => void
  private readonly onViewChange: (e: Event) => void
  /** The radius the current plan was built with; see {@link handleViewChange}. */
  private planRadius: number | Vec3f = 0
  private readonly onLightingChange: (e: Event) => void
  /** Whether the current plan was priced lit (8 B/voxel) or unlit (4). */
  private planLit = false
  private readonly onViewDestroyed: () => void

  private focusFrac: Vec3f
  /** Regions pinned to one uniform level; see {@link ChunkedVolumeOptions.focusBounds}. */
  private focusBounds: MultiLodBounds[]
  private plan: ChunkPlan
  private disposed = false
  private refocusHandle: ReturnType<typeof setTimeout> | null = null
  /**
   * The promise handed to every caller of the CURRENTLY debounced refocus. A
   * newer request that supersedes it before the timer fires reuses the same
   * deferred, so each caller resolves once the swap that absorbed its request
   * has applied (or on dispose): never earlier, and never left hanging.
   */
  private pendingRefocus: RefocusDeferred | null = null
  private swapChain: Promise<void> = Promise.resolve()
  /** Swaps queued on `swapChain` that have not yet applied. */
  private inFlightSwaps = 0
  /**
   * Resolved by {@link dispose}. Raced against the swap chain wherever a caller
   * awaits it ({@link whenRefocusIdle}, {@link doRefocus}), because the chain can
   * only advance when the host swap settles: a host whose swap never settles
   * (a torn-down renderer, a wedged upload) would otherwise leave every such
   * caller hanging forever after disposal.
   */
  private readonly disposedDeferred: RefocusDeferred = createRefocusDeferred()
  // Built once, on the first applyCoarseFloor; null once `floorBuilt` is set
  // means "tried and cannot" (too large, or an unsupported datatype), so a
  // repeat call does not re-fetch the coarse level.
  private floorVolume: NVImage | null = null
  private floorBuilt = false
  /** The first floor build, while in flight: a frame switch waits for it. */
  private floorPending: Promise<NVImage | null> | null = null
  // The last floor this manager got onto the view, and the floor it replaced.
  private floorSet: { set: number; replaced: NVImage | null } | null = null
  /**
   * False only when the caller passed both `calMin` and `calMax` as finite
   * numbers; otherwise the data is sampled for robust/global and for any bound
   * neither given nor filled by a CT colormap.
   */
  private readonly wantsAutoWindow: boolean
  private windowResolved = false
  /**
   * Finite value range (calibrated) of every brick decoded so far, whatever
   * the colormap. Kept because the renderer's decoded tier serves bricks
   * again without a new decode, so a palette generated later has only this.
   */
  private observedLabelRange: [number, number] | null = null
  private labelGrowHandle: ReturnType<typeof setTimeout> | null = null
  /** Shared by every frame's loader, so the fetch bound holds across a scrub. */
  private readonly read: (req: SourceRegionRead) => Promise<Uint8Array>
  private shownFrame: number
  /** The staged bricks the shown frame's loader still hands out. */
  private servedBricks = new Map<string, Uint8Array>()
  /** The frame `load` fetched, waiting for `commit`; one slot, newest wins. */
  private staged: (StagedFrame & { t: number }) | null = null
  /** Recently decoded bricks, for the exact voxel readout. */
  private readonly readout: BrickReadout
  /** The window probe, kept as the histogram sample when there is no floor. */
  private probe: { image: NVImage; frame: number } | null = null

  constructor(
    host: NiiVue,
    source: ChunkedVolumeSource,
    options: ChunkedVolumeOptions = {},
  ) {
    if (source.levels.length < 1) {
      throw new Error('ChunkedVolumeSource has no levels')
    }
    this.host = host
    this.source = source
    // Integer label textures hold uint32/int32 IDs exactly; 64-bit types do
    // not reach the GPU as integers, so an ID past 2^24 would blend (Q10).
    if (
      NVCmaps.isLabelColormap(options.colormap) &&
      WIDE_LABEL_TYPES.has(source.datatypeCode)
    )
      throw new Error(
        `label channel datatype ${source.datatypeCode} can hold IDs above 2^24, which do not read back exactly`,
      )
    const readoutBytes = options.readoutBytes ?? READOUT_BYTES
    this.readout = new BrickReadout(
      source,
      () => this.shownFrame,
      () => readoutBytes / Math.max(1, host._chunkedVolumeCount),
    )
    // Decided before the colormap fills the bounds: a CT window sets the
    // display, not the robust/global range a reset or a contrast drag needs.
    this.wantsAutoWindow =
      !Number.isFinite(options.calMin) || !Number.isFinite(options.calMax)
    // A CT colormap brings its window, as for a URL load (#395).
    options = NVCmaps.withColormapWindow(options)
    this.loadOptions = options
    // The plan-shaping options are folded by resolveBudgetPlan, so a preset, an
    // explicit plan, and the individual knobs all land in one place with one
    // precedence rule (knobs win). Passing no plan reproduces the pre-plan
    // defaults exactly.
    this.o = resolveBudgetPlan(options, this.planContext())
    this.followCrosshair = this.o.focus === 'crosshair'
    this.focusFrac = Array.isArray(this.o.focus)
      ? [this.o.focus[0], this.o.focus[1], this.o.focus[2]]
      : [0.5, 0.5, 0.5]
    this.focusBounds = cloneBounds(options.focusBounds)
    host._registerChunkedVolume(this)
    this.onLocationChange = () => this.handleLocationChange()
    this.onViewChange = (e) => this.handleViewChange(e)
    this.onLightingChange = (e) => this.handleLightingChange(e)
    // Only self-dispose on a REAL controller teardown. `viewDestroyed` also fires
    // on a transient view recreation (backend switch / init fallback), where the
    // controller and this volume stay alive and the locationChange listener (on
    // the controller, not the view) keeps working — disposing there would
    // permanently freeze crosshair-follow streaming.
    this.onViewDestroyed = () => {
      if (this.host.isDestroyed) this.dispose()
    }

    const finest = source.levels[0]
    this.plan = this.buildPlan()
    this.readout.keep(this.plan)
    this.volume = createStreamingNVImage({
      shape: finest.shape,
      spacing: finest.spacing,
      datatypeCode: source.datatypeCode,
      xyztUnits: source.xyztUnits,
      calMin: windowOr(options.calMin, 0),
      calMax: windowOr(options.calMax, 1),
      colormap: options.colormap,
      opacity: options.opacity,
      isTransparentBelowCalMin: options.isTransparentBelowCalMin,
      name: options.name,
      id: options.id,
    })
    // createStreamingNVImage always assigns a non-null id (explicit or generated);
    // capture it so `get id()` needs no fallback. The guard makes that contract
    // explicit without a non-null assertion.
    const volumeId = this.volume.id
    if (volumeId === undefined) {
      throw new Error('createStreamingNVImage did not assign an id')
    }
    this.volumeId = volumeId
    this.volume.chunkPlan = this.plan
    this.volume.pickSampler = this.buildPickSampler()
    this.read = createSourceRegionReader(source, {
      maxConcurrentLoads: options.maxConcurrentLoads ?? 6,
      retryAttempts: options.retryAttempts ?? 3,
      onChunk: (bytes, req) => {
        // A staged frame grows the palette on commit, never if it is aborted.
        if (req.frame === this.shownFrame)
          this.growLabelsFromChunk(bytes, req.bytesPerVoxel)
        this.readout.add(bytes, req)
      },
    })
    this.volume.voxelValue = (x, y, z) => this.voxelSample(x, y, z)
    const frames = Math.max(1, source.frames ?? 1)
    this.shownFrame = Math.min(
      frames - 1,
      Math.max(0, Math.round(options.frame ?? 0) || 0),
    )
    this.volume.chunkSource = frameChunkLoader(this.read, this.shownFrame)
    this.stagingBytes = options.frameStagingBytes ?? FRAME_STAGING_BYTES
    this.volume.frameSource = {
      count: frames,
      frame: this.shownFrame,
      group: options.frameGroup ?? this,
      load: async (t, signal) => {
        this.staged = null
        // A sibling failing aborts the group after this member staged.
        signal.addEventListener(
          'abort',
          () => {
            if (this.staged?.t === t) this.staged = null
          },
          { once: true },
        )
        const staged = await this.stageFrame(t, this.stagingShare(), signal)
        // An abort can land after the reads resolve: never keep its bytes.
        if (!signal.aborted) this.staged = { ...staged, t }
        return []
      },
      commit: (t, scene) => this.commitFrame(t, scene),
      descriptor: options.descriptor && {
        ...options.descriptor,
        revision: options.descriptor.revision ?? source.revision,
      },
      revision: source.revision,
    }
  }

  /**
   * The in-memory sample a histogram or auto window of this volume reads: the
   * coarse floor (the whole coarsest level, shown frame), else the window
   * probe (a centred crop of it, `level` and `frame` as fetched). Null when
   * neither was fetched.
   */
  get histogramSample(): {
    image: NVImage
    coverage: 'level' | 'sample'
    level: number
    frame: number
  } | null {
    const level = this.source.levels.length - 1
    if (this.floorVolume?.img)
      return {
        image: this.floorVolume,
        coverage: 'level',
        level,
        frame: this.shownFrame,
      }
    return this.probe && { ...this.probe, coverage: 'sample', level }
  }

  /**
   * Value at common-grid voxel [x, y, z]: exact from the finest decoded brick
   * of the shown frame; else the coarse floor's (`exact` false); NaN where
   * neither holds data.
   */
  private voxelSample(
    x: number,
    y: number,
    z: number,
  ): { value: number; exact: boolean } {
    const hdr = this.volume.hdr
    const calibrate = (v: number) => v * hdr.scl_slope + hdr.scl_inter
    const raw = this.readout.value(x, y, z)
    if (!Number.isNaN(raw)) return { value: calibrate(raw), exact: true }
    const floor = this.floorVolume
    const common = this.source.levels[0].shape
    const dims = floor?.hdr.dims
    if (!floor?.img || !dims) return { value: Number.NaN, exact: false }
    const at = [x, y, z].map((v, i) =>
      Math.min(dims[i + 1] - 1, Math.floor((v * dims[i + 1]) / common[i])),
    )
    if (at.some((v) => v < 0)) return { value: Number.NaN, exact: false }
    const idx = at[0] + dims[1] * (at[1] + dims[2] * at[2])
    return { value: calibrate(floor.img[idx]), exact: false }
  }

  /** @internal Re-fit the readout to its share of the cap (the handle count moved). */
  _trimReadout(): void {
    this.readout.trim()
  }

  /** Time points the source holds (1 without a time axis). */
  get frames(): number {
    return this.volume.frameSource?.count ?? 1
  }

  /** The time point shown. */
  get frame(): number {
    return this.shownFrame
  }

  /**
   * Show time point `frame` (clamped) on this volume and every volume of its
   * frame group, as `setFrame4D` does: the current plan's bricks nearest the
   * focus (up to `frameStagingBytes`) and the coarse floor are fetched first,
   * then the whole group commits in one update, so no view mixes two time
   * points. A newer call aborts a pending one, which resolves unchanged; a
   * failed fetch rejects and keeps the shown frame.
   */
  setFrame(frame: number): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.host.setFrame4D(this.id, frame)
  }

  private readonly stagingBytes: number

  /**
   * This volume's part of the staging budget: `frameStagingBytes` is for the
   * whole frame group (floors included), split evenly across its streamed
   * members.
   */
  private stagingShare(): number {
    const group = this.volume.frameSource?.group
    return this.stagingBytes / Math.max(1, this.host._chunkedVolumesIn(group))
  }

  /** Fetch what time point `t` needs before it can be shown. */
  private async stageFrame(
    t: number,
    budgetBytes: number,
    signal: AbortSignal,
  ): Promise<StagedFrame> {
    const bpv = getBitsPerVoxel(this.source.datatypeCode) / 8
    const common = this.source.levels[0].shape
    const focus = this.focusFrac.map((f, i) => f * common[i])
    const dist = (c: ChunkPlan['chunks'][number]): number => {
      let d = 0
      for (let i = 0; i < 3; i++) {
        const mid = c.voxelOrigin[i] + c.voxelDims[i] / 2 - focus[i]
        d += mid * mid
      }
      return d
    }
    const chunks = [...this.plan.chunks].sort((a, b) => dist(a) - dist(b))
    const picks: typeof chunks = []
    // The first floor may still be building for the old frame: stage frame
    // t's own instead of letting that one land under t's bricks.
    const hasFloor = this.floorBuilt
      ? this.floorVolume !== null
      : (await this.floorPending) != null
    signal.throwIfAborted()
    // The floor (or else the probe) is required, so it counts first.
    const coarse = this.source.levels[this.source.levels.length - 1].shape
    let bytes = hasFloor
      ? coarse[0] * coarse[1] * coarse[2] * bpv
      : (this.probe?.image.img?.byteLength ?? 0)
    for (const c of chunks) {
      const n = c.texDims[0] * c.texDims[1] * c.texDims[2] * bpv
      if (picks.length && bytes + n > budgetBytes) break
      picks.push(c)
      bytes += n
    }
    const bricks = new Map<string, Uint8Array>()
    const reads = picks.map(async (c) => {
      const level = c.sourceLevel ?? 0
      const data = await this.read({
        levelIndex: level,
        texOrigin: c.texOrigin,
        texDims: c.texDims,
        bytesPerVoxel: bpv,
        frame: t,
        signal,
      })
      bricks.set(regionKey(level, c.texOrigin, c.texDims), data)
    })
    const floor = hasFloor
      ? this.buildCoarseFloor(t, signal)
      : Promise.resolve(null)
    // Without a floor the histogram reads the probe: keep it on the frame.
    const probe =
      !hasFloor && this.probe
        ? this.readProbe(t, signal)
        : Promise.resolve(null)
    const [built, probed] = await Promise.all([floor, probe, ...reads])
    signal.throwIfAborted()
    return { bricks, floor: built, probe: probed }
  }

  /**
   * Show the staged time point `t` on `scene` (the host's copy of the
   * volume): swap in its loader and queue its floor into the group's GPU
   * update, which installs the floor before it rebuilds the bricks, so no
   * frame shows one time point's floor under the other's bricks.
   */
  private commitFrame(t: number, scene: NVImage): void {
    const staged = this.staged
    this.staged = null
    if (!staged || staged.t !== t || this.disposed) return
    // A new loader identity is what makes the renderer drop the old frame's
    // resident and decoded bricks (volumeSourceKey).
    this.servedBricks = staged.bricks
    const loader = frameChunkLoader(this.read, t, staged.bricks)
    this.volume.chunkSource = loader
    scene.chunkSource = loader
    this.shownFrame = t
    this.readout.reset(staged.bricks, t)
    if (this.volume.frameSource) this.volume.frameSource.frame = t
    const bpv = getBitsPerVoxel(this.source.datatypeCode) / 8
    for (const bytes of staged.bricks.values())
      this.growLabelsFromChunk(bytes, bpv)
    if (staged.probe) this.probe = { image: staged.probe, frame: t }
    const old = this.floorVolume
    if (!staged.floor) return
    const img = staged.floor.img
    if (img)
      this.growLabelsFromChunk(
        new Uint8Array(img.buffer, img.byteOffset, img.byteLength),
        bpv,
      )
    this.floorVolume = staged.floor
    if (!old) return
    // Only the floor this volume owns on the view (or has queued for it);
    // another base keeps its own.
    if (
      this.host._baseCoarseFloor === old ||
      this.host._queuedCoarseFloor?.floor === old
    )
      this.host._queueBaseCoarseFloor(staged.floor, (set, replaced) => {
        this.floorSet = { set, replaced }
      })
  }

  /**
   * ADD the streamed volume to the scene (does NOT replace existing volumes)
   * and — for crosshair focus — start following the crosshair. The caller owns
   * removing a previously streamed volume before reloading.
   */
  async init(): Promise<void> {
    try {
      await this.host.addVolume(this.volume)
      this.adoptSceneId()
      this.syncCrosshairSubscription()
      this.syncViewSubscription()
      // Self-dispose if the controller is destroyed without the caller disposing
      // this handle, so the locationChange listener + host reference don't leak
      // (and can't fire against a torn-down view).
      this.host.addEventListener('viewDestroyed', this.onViewDestroyed)
      this.host.addEventListener('change', this.onLightingChange)
      this.applyRenderCentering()
      await this.applyCoarseFloor()
      // The floor path resolves the window for free when a floor was built. When
      // it was not, fall back to a bounded probe so a streamed volume still opens
      // on a window that shows the data rather than on the 0..1 placeholder.
      if (this.wantsAutoWindow && !this.windowResolved) await this.probeWindow()
      if (this.windowResolved && !this.disposed)
        await this.host._updateGLChanged()
    } catch (err) {
      // A failed init hands the caller no handle, so nothing else could release
      // this manager or the volume it added (addVolume adds before it can throw).
      this.dispose()
      // Put back the floor this init replaced (an additive reload's, or none):
      // ours would keep its textures and draw behind a later load. Only while
      // our set is still the latest: a newer caller's floor is not ours to undo.
      const ours = this.floorSet
      if (ours && (this.host._baseCoarseFloorSets ?? 0) === ours.set)
        await this.host
          .setBaseCoarseFloor(ours.replaced)
          .catch((e) => log.warn('NVChunkedVolume: floor cleanup failed', e))
      const index = this.host.volumes.findLastIndex(
        (v) => v.chunkSource === this.volume.chunkSource,
      )
      if (index >= 0)
        await this.host
          .removeVolume(index)
          .catch((e) => log.warn('NVChunkedVolume: cleanup failed', e))
      throw err
    }
  }

  /**
   * Install this volume's coarse floor as the host's base floor (fetching and
   * building it on first call, then reusing it), and return whether a floor is
   * now installed. Called by {@link init}; call it again after an ADDITIVE
   * reload has removed the outgoing volume, since the floor belongs to whichever
   * streamed volume is the base and `init` runs while the old one still is.
   *
   * When the `coarseFloor` option is on but no floor can be built, the host's
   * floor is CLEARED rather than left alone: a floor from a previously loaded
   * volume would otherwise keep drawing behind this one's bricks, on the wrong
   * grid. No-op when the option is off, so an app supplying its own floor via
   * {@link NiiVue.setBaseCoarseFloor} keeps it.
   */
  async applyCoarseFloor(): Promise<boolean> {
    if (!this.o.coarseFloor || this.disposed) return false
    if (!this.floorBuilt) {
      this.floorPending ??= this.buildCoarseFloor()
      const built = await this.floorPending
      this.floorBuilt = true
      // A frame switch committed meanwhile already brought its own floor.
      this.floorVolume ??= built
      this.floorPending = null
    }
    if (this.disposed) return false
    // A frame switch commits only between installs (see _setSourceFrame).
    await this.host._setBaseCoarseFloor(this.floorVolume, (set, replaced) => {
      this.floorSet = { set, replaced }
    })
    return this.floorVolume !== null
  }

  /**
   * Give the depth picker something to sample. A chunked volume has no single
   * whole-volume texture, so the GPU depth pass cannot see it and the views fall
   * back to CPU ray math; without a sampler that math can only land on the
   * bounding box (or the clip surface), which puts the crosshair in mid-air in
   * front of the tissue and makes a cavity opened by the clip plane unpickable.
   * The coarse floor is a whole-volume image already in memory, so it is exactly
   * the right lookup: low resolution, but enough to find the first voxel above
   * the display window along the ray.
   *
   * Installed in the constructor, BEFORE `init` adds the volume — the host takes
   * a shallow copy on add, so a sampler attached later would never reach the
   * mounted volume. The floor is therefore resolved lazily (it is fetched after
   * the add, and may never arrive): until then, and when no floor can be built at
   * all, this returns 0 everywhere and the views fall back to the box entry.
   */
  private buildPickSampler(): (x: number, y: number, z: number) => number {
    const vol = this.volume
    let cachedFloor: NVImage | null = null
    let img: TypedVoxelArray | null = null
    let dims: Vec3i = [0, 0, 0]
    let slope = 1
    let inter = 0
    return (x: number, y: number, z: number): number => {
      const floor = this.floorVolume
      if (!floor?.img) return 0
      if (floor !== cachedFloor) {
        cachedFloor = floor
        img = floor.img
        dims = [floor.hdr.dims[1], floor.hdr.dims[2], floor.hdr.dims[3]]
        slope = floor.hdr.scl_slope || 1
        inter = floor.hdr.scl_inter || 0
      }
      const min = vol.extentsMin
      const max = vol.extentsMax
      if (!img || !min || !max) return 0
      // The floor is drawn stretched over the streamed volume's box (both
      // renderers sample it with the volume's own texture coordinates), so
      // normalize mm the same way rather than by the coarse level's own extents.
      // The streaming affine is diag(spacing) in RAS, so the stored voxel order
      // is already RAS: index straight into the fetched coarse level.
      const mm = [x, y, z]
      let idx = 0
      let stride = 1
      for (let i = 0; i < 3; i++) {
        if (dims[i] < 1) return 0
        const f = (mm[i] - min[i]) / (max[i] - min[i] || 1)
        if (!(f >= 0 && f <= 1)) return 0
        idx += Math.min(dims[i] - 1, Math.floor(f * dims[i])) * stride
        stride *= dims[i]
      }
      const value = img[idx] * slope + inter
      // Read the window live: the app may re-window the volume after load.
      const calMin = vol.calMin ?? 0
      return value > calMin ? value - calMin : 0
    }
  }

  /**
   * The scene keeps volume ids unique, so an explicit `options.id` already used
   * by another volume is stored with a `-2`, `-3`, ... suffix. Follow it, or
   * every find-by-id here would hit the other volume. The scene holds a shallow
   * copy of `volume`, recognised by the `chunkSource` it shares.
   */
  private adoptSceneId(): void {
    const scene = this.host.volumes?.find(
      (v) => v.chunkSource === this.volume.chunkSource,
    )
    if (!scene?.id || scene.id === this.volumeId) return
    this.volumeId = scene.id
    this.volume.id = scene.id
  }

  /** The volume's stable id (used to target plan swaps). */
  get id(): string {
    return this.volumeId
  }

  /** Current focus as a [0,1] fraction of the common grid. */
  get focus(): Vec3f {
    return [this.focusFrac[0], this.focusFrac[1], this.focusFrac[2]]
  }

  /** The current multi-LOD plan (read-only; useful for debugging/telemetry). */
  get currentPlan(): ChunkPlan {
    return this.plan
  }

  /**
   * Move the focus and rebuild+swap the plan (debounced). Pass `focusBounds`
   * to replace the regions pinned to one uniform level (an empty array clears
   * them); omit it to keep the current bounds. Resolves when the swap has
   * applied; see {@link refocus}. On a disposed manager it resolves
   * immediately and changes nothing.
   */
  setFocus(frac: Vec3f, focusBounds?: MultiLodBounds[]): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.focusFrac = [frac[0], frac[1], frac[2]]
    if (focusBounds !== undefined) this.focusBounds = cloneBounds(focusBounds)
    return this.refocus()
  }

  /**
   * Cap the finest level the octree may use (index into `source.levels`).
   * Resolves when the swap has applied; see {@link refocus}. On a disposed
   * manager it resolves immediately and changes nothing.
   */
  setMaxDetail(levelIndex: number): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.o.minLevel = clampLevel(levelIndex, this.source)
    return this.refocus()
  }

  /**
   * Change the plan's GPU byte budget. Resolves when the swap has applied; see
   * {@link refocus}. On a disposed manager it resolves immediately and changes
   * nothing.
   */
  setBudget(bytes: number): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.o.budgetBytes = bytes
    return this.refocus()
  }

  /** The budget plan currently in force, as resolved values. */
  get budgetPlan(): BudgetPlan {
    return {
      focus: Array.isArray(this.o.focus)
        ? [this.o.focus[0], this.o.focus[1], this.o.focus[2]]
        : this.o.focus,
      radius: Array.isArray(this.o.radius)
        ? [this.o.radius[0], this.o.radius[1], this.o.radius[2]]
        : this.o.radius,
      detail: this.o.detail,
      budgetBytes: this.o.budgetBytes,
      maxBricks: this.o.maxBricks,
      targetFrameMs: this.o.targetFrameMs,
      debounceMs: this.o.debounceMs,
    }
  }

  /**
   * Switch budget plan at runtime, and re-plan (debounced). The plan is folded
   * back over the options this volume was LOADED with, so any knob the caller
   * pinned then (a demo's VRAM ceiling, a pinned `radius`) still wins -- the
   * same precedence `loadChunkedVolume` applied. Switching to or away from a
   * crosshair focus subscribes/unsubscribes `locationChange` accordingly.
   *
   * `minLevel` is deliberately carried over from the CURRENT state rather than
   * re-read from the load options, so a plan switch does not silently undo a
   * {@link setMaxDetail} the app made in between.
   *
   * Resolves when the swap has applied; see {@link refocus}.
   */
  setBudgetPlan(plan: BudgetPlanSpec): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const next = resolveBudgetPlan(
      {
        ...this.loadOptions,
        budgetPlan: plan,
        minLevel: this.o.minLevel,
        swapPolicy: this.o.swapPolicy,
      },
      this.planContext(),
    )
    // The halo is raise-only (see raiseHaloTo): a plan switch must not undercut
    // a wider reconstruction kernel that was already streamed for.
    next.halo = raiseHalo(next.halo, Math.max(...this.o.halo))
    Object.assign(this.o, next)
    this.followCrosshair = this.o.focus === 'crosshair'
    if (Array.isArray(this.o.focus)) {
      this.focusFrac = [this.o.focus[0], this.o.focus[1], this.o.focus[2]]
    } else if (!this.followCrosshair) {
      this.focusFrac = [0.5, 0.5, 0.5]
    }
    this.syncCrosshairSubscription()
    this.syncViewSubscription()
    // Adopt the crosshair NOW rather than waiting for the next locationChange,
    // so switching back to a crosshair plan does not plan around a stale focus.
    if (this.followCrosshair) this.handleLocationChange()
    return this.refocus()
  }

  /** What a refocus does with replaced bricks; see {@link setSwapPolicy}. */
  get swapPolicy(): SwapPolicy {
    return this.o.swapPolicy
  }

  /**
   * Choose what the next refocus does with bricks the new plan replaces (see
   * {@link BudgetPlanOptions.swapPolicy}). Takes effect at the next swap; no
   * re-plan.
   */
  setSwapPolicy(policy: SwapPolicy): void {
    this.o.swapPolicy = policy
  }

  /** The halo the current plan is being built with. */
  get halo(): Vec3i {
    return [this.o.halo[0], this.o.halo[1], this.o.halo[2]]
  }

  /**
   * Raise the per-axis brick halo to at least `minHalo` and re-plan (debounced),
   * so the next stream carries enough neighbour data for a wider reconstruction
   * kernel. Raise-only: it never shrinks an existing halo, so two callers with
   * different requirements cannot undercut each other. A no-op (and no re-plan)
   * when the halo already satisfies the request.
   *
   * Note that a larger halo makes each brick bigger, so the same GPU budget
   * buys fewer/coarser bricks -- that is the cost of a seam-free cubic filter.
   *
   * Resolves when the swap has applied (immediately for the no-op case, and
   * immediately with no state change on a disposed manager); see
   * {@link refocus}.
   */
  raiseHaloTo(minHalo: number): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const next = raiseHalo(this.o.halo, minHalo)
    if (
      next[0] === this.o.halo[0] &&
      next[1] === this.o.halo[1] &&
      next[2] === this.o.halo[2]
    ) {
      return Promise.resolve()
    }
    this.o.halo = next
    return this.refocus()
  }

  /** Streaming residency counters (delegates to the controller). */
  stats(): ReturnType<NiiVue['chunkStreamStats']> {
    return this.host.chunkStreamStats()
  }

  /**
   * Debounced rebuild + in-place plan swap. Resolves once the host swap this
   * request ended up in has COMPLETED -- applied, or failed and logged. The
   * promise does not signal success either way, and {@link currentPlan} is not
   * a liveness signal: {@link doRefocus} commits it (and `volume.chunkPlan`)
   * BEFORE awaiting the host swap, and the assignment stands even if that swap
   * throws, so `currentPlan` is only ever the last REQUESTED plan, not a
   * confirmed-resident one. That swap is the plan built
   * when the debounce timer fires, which absorbs every request made while the
   * timer was pending. A
   * newer request therefore never leaves an older one hanging -- both settle
   * together, after the newest plan is on the GPU -- and a swap that fails is
   * logged (as before) rather than rejecting, so an app can await the sequence
   * without guarding every step. Resolves immediately on a disposed manager;
   * {@link dispose} also settles every request still outstanding, whether its
   * timer had not fired yet or its swap was queued behind one the host will
   * now never complete.
   */
  refocus(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.refocusHandle) clearTimeout(this.refocusHandle)
    const pending = this.pendingRefocus ?? createRefocusDeferred()
    this.pendingRefocus = pending
    this.refocusHandle = setTimeout(() => {
      this.refocusHandle = null
      this.pendingRefocus = null
      // doRefocus already swallows a failed host swap; settle on either path
      // so a caller awaiting the swap can never be left hanging.
      this.doRefocus().then(pending.resolve, pending.resolve)
    }, this.o.debounceMs)
    return pending.promise
  }

  /**
   * A barrier: resolves when no refocus is pending (debounced) or in flight
   * (queued on the swap chain), immediately when the manager is idle. Under a
   * continuous stream of requests (a crosshair drag) it waits for the stream
   * to pause, which is the moment the GPU brick set matches the handle. Also
   * resolves on {@link dispose} — raced explicitly, because a swap already
   * with the host when dispose runs may simply never settle, and the swap
   * chain (which this otherwise awaits) would hang with it.
   */
  async whenRefocusIdle(): Promise<void> {
    while (!this.disposed && (this.pendingRefocus || this.inFlightSwaps > 0)) {
      await Promise.race([
        this.pendingRefocus?.promise ?? this.swapChain,
        this.disposedDeferred.promise,
      ])
    }
  }

  /** Stop following the crosshair and release the manager (leaves the volume loaded). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.host._unregisterChunkedVolume(this)
    if (this.refocusHandle) {
      clearTimeout(this.refocusHandle)
      this.refocusHandle = null
    }
    if (this.labelGrowHandle) {
      clearTimeout(this.labelGrowHandle)
      this.labelGrowHandle = null
    }
    // A cancelled refocus never applies, so release anyone awaiting it now.
    const pending = this.pendingRefocus
    this.pendingRefocus = null
    pending?.resolve()
    // Release everyone racing on the swap chain (whenRefocusIdle, a doRefocus
    // queued behind an in-flight swap): a swap the host is still holding may
    // never settle now, and nothing further will be applied regardless.
    this.disposedDeferred.resolve()
    this.followCrosshair = false
    this.syncCrosshairSubscription()
    this.syncViewSubscription()
    this.host.removeEventListener('viewDestroyed', this.onViewDestroyed)
    this.host.removeEventListener('change', this.onLightingChange)
  }

  /**
   * Add or drop the `locationChange` listener so it is subscribed exactly when
   * the focus follows the crosshair. Idempotent: `subscribedToCrosshair` tracks
   * the real state, so repeated calls (init, a plan switch, dispose) can never
   * double-subscribe or leak a listener.
   */
  private syncCrosshairSubscription(): void {
    const want = this.followCrosshair && !this.disposed
    if (want === this.subscribedToCrosshair) return
    this.subscribedToCrosshair = want
    if (want) {
      this.host.addEventListener('locationChange', this.onLocationChange)
    } else {
      this.host.removeEventListener('locationChange', this.onLocationChange)
    }
  }

  /**
   * Add or drop the host `change` listener that re-plans an `'auto'` radius
   * when the view it is derived from moves: the 2D zoom (`pan2Dxyzmm[3]`) and
   * the slice type (render core vs 2D ellipsoid). Subscribed exactly when the
   * radius is `'auto'`: a pinned or `'volume'` radius never depends on the
   * view, and without this a pinned or `'none'` focus has no subscription at
   * all, so a wheel zoom would keep the plan at the old radius until some
   * unrelated refocus. Idempotent, like {@link syncCrosshairSubscription}.
   */
  private syncViewSubscription(): void {
    const want = this.o.radius === 'auto' && !this.disposed
    if (want === this.subscribedToView) return
    this.subscribedToView = want
    if (want) {
      this.host.addEventListener('change', this.onViewChange)
    } else {
      this.host.removeEventListener('change', this.onViewChange)
    }
  }

  private handleViewChange(e: Event): void {
    const property = (e as CustomEvent<PropertyChangeDetail>).detail?.property
    if (property !== 'pan2Dxyzmm' && property !== 'sliceType') return
    // The host emits pan2Dxyzmm for a pure pan as well (and a deep-zoom viewer
    // writes it every frame), so only a radius the current plan was NOT built
    // with earns a re-plan. The refocus itself is debounced.
    if (sameRadius(this.currentRadius(), this.planRadius)) return
    void this.refocus()
  }

  private handleLocationChange(): void {
    // Map the crosshair (world mm) to THIS volume's texture fraction via the
    // inverse frac2mm. Correct even when the volume doesn't span the scene AABB
    // or sits on a non-identity grid. This mm -> texture-fraction conversion is
    // the ONLY correct focus: `host.crosshairPos` is a SCENE fraction (within the
    // scene AABB), a distinct [0,1] space that must not be assigned as a volume
    // texture fraction. When frac2mm is missing or singular the conversion is
    // unreachable (the scene fallback would need the very matrix that's absent),
    // so leave the focus unchanged rather than apply wrong coordinates.
    const f2m = this.volume.frac2mm
    if (!f2m) return
    const mm = this.host.getCrosshairPos()
    const frac = mmToVolumeFraction(f2m, [mm[0], mm[1], mm[2]])
    if (!frac) return
    this.focusFrac = frac
    void this.refocus()
  }

  /**
   * Host/source facts the budget plan cannot know on its own. The public halo
   * default stays [1,1,1] (trilinear's requirement, and the cheapest brick);
   * cubic reads two voxels past a face, so an already-cubic host gets the larger
   * halo from the FIRST plan rather than a re-stream.
   */
  private planContext(): BudgetPlanContext {
    return {
      levelCount: this.source.levels.length,
      minHalo: this.host.volumeIsCubicInterpolation ? CUBIC_MIN_HALO : 0,
      deviceLimit: hostDeviceLimit(this.host) ?? 256,
    }
  }

  private buildPlan(): ChunkPlan {
    const radius = this.currentRadius()
    this.planRadius = radius
    this.planLit = this.hostNeedsGradient()
    return planForFocus(
      this.source,
      this.focusFrac,
      radius,
      this.o,
      this.focusBounds,
      this.planLit ? 8 : 4,
    )
  }

  /** The renderers' `_needsGradient` test, read from the host's settings. */
  private hostNeedsGradient(): boolean {
    const h = this.host
    return (
      h.volumeIllumination > 0 ||
      h.volumeGradientOpacity > 0 ||
      h.volumeSilhouette > 0
    )
  }

  /** Re-plan when lighting flips, so the plan is priced as the GPU holds it. */
  private handleLightingChange(e: Event): void {
    const property = (e as CustomEvent<PropertyChangeDetail>).detail?.property
    if (!property || !LIGHTING_PROPERTIES.has(property)) return
    if (this.hostNeedsGradient() === this.planLit) return
    void this.refocus()
  }

  private currentRadius(): number | Vec3f {
    const radius = this.o.radius
    // A pinned per-axis radius passes straight through. `resolveBudgetPlan`
    // already copied it out of the caller's array; this copy keeps the plan
    // input independent of `this.o` as well.
    if (Array.isArray(radius)) return [radius[0], radius[1], radius[2]]
    if (typeof radius === 'number') return radius
    const common = this.source.levels[0].shape
    // 'volume': a ball that swallows every brick, so nothing is outside the
    // finest shell and the plan comes back uniform -- the budget/maxBricks pass
    // then coarsens it as a whole to the finest level that fits.
    if (radius === 'volume') {
      return Math.hypot(common[0], common[1], common[2]) / 2
    }
    // Render view: a finest CORE around the crosshair, roughly one cell in
    // radius. A too-tight radius leaves coarse (mean-downsampled, so thin
    // structure washes out) bricks right at the focus; a full-cell radius keeps
    // the region you're looking at at the finest level (the budget/maxBricks
    // pass still bounds the overall plan).
    if (this.host.sliceType === SLICE_TYPE.RENDER) return this.o.cellEdge
    // 2D slice views: PER-AXIS sqrt(3) * half-extents over zoom, so the finest
    // region is the ellipsoid with the volume's own aspect. The old scalar was
    // the half-DIAGONAL over zoom, which starves long thin volumes (the
    // motivating case: a 16821 x 7494 x 2070 slide): a single ball wide enough
    // for the long axis over-covers the short axes several times over, the
    // budget/maxBricks pass then coarsens the whole plan uniformly to pay for
    // those wasted bricks, and the long axis — the one the user is actually
    // panning along — ends up coarser than the budget could have afforded.
    // The sqrt(3) keeps this a superset of the old ball: for a cube the two
    // are the same radius (half-diagonal = sqrt(3) * half-edge), so the plan
    // is unchanged bit for bit; for a slab the ellipsoid circumscribes the
    // volume the way the ball did, so at zoom 1 the whole volume is inside
    // the finest shell and the budget pass coarsens it uniformly, as before.
    // Without it the ellipsoid is inscribed, the corners fall outside, and
    // every budget candidate is a mixed-level plan whose 2:1 balance pass is
    // quadratic in bricks (hundreds of seconds on a slide-sized pyramid).
    const zoom = Math.max(1, this.host.pan2Dxyzmm[3] || 1)
    const k = Math.sqrt(3) / (2 * zoom)
    return [common[0] * k, common[1] * k, common[2] * k]
  }

  private async doRefocus(): Promise<void> {
    if (this.disposed) return
    // Build the plan for the CURRENT focus now, but commit it (this.plan /
    // volume.chunkPlan) and apply the host swap inside a single serialized queue.
    // Two concurrent refocuses could otherwise complete out of order and leave
    // the GPU brick set on an older focus while the handle/HUD report the newer
    // one; chaining guarantees swaps apply in call order, newest last.
    const plan = this.buildPlan()
    this.inFlightSwaps++
    const applied = this.swapChain.then(async () => {
      if (this.disposed) return
      this.plan = plan
      this.volume.chunkPlan = plan
      this.readout.keep(plan)
      // Staged bricks the new plan does not request would wait forever.
      const kept = new Set(chunkRegionKeys(plan))
      for (const key of this.servedBricks.keys())
        if (!kept.has(key)) this.servedBricks.delete(key)
      try {
        await this.host.swapVolumeChunkPlan(this.id, plan, {
          keepUntilCovered: this.o.swapPolicy === 'keepUntilCovered',
        })
      } catch (err) {
        log.warn('NVChunkedVolume: refocus swap failed', err)
      }
      // dispose() may have run while the host held the swap; the pivot write
      // would redraw a torn-down host.
      if (this.disposed) return
      this.applyRenderCentering()
    })
    // Keep the shared chain resolved so a later throw cannot break the queue,
    // but say so: the swap itself already logs its own failures, so anything
    // landing here (applyRenderCentering, the commit) is unexpected.
    // The count drops on the chain (before any awaiting caller resumes), so
    // whenRefocusIdle never observes a swap as in flight after it has applied.
    this.swapChain = applied
      .catch((err) => log.warn('NVChunkedVolume: swap chain error', err))
      .then(() => {
        this.inFlightSwaps--
      })
    // Race dispose: this swap is queued behind every earlier one, and an
    // earlier swap the host never settles would otherwise pin this caller's
    // promise open forever.
    await Promise.race([this.swapChain, this.disposedDeferred.promise])
  }

  /**
   * Fetch the coarsest pyramid level whole and wrap it as an in-memory NVImage
   * on the same mm box as the streamed volume, for the renderer to orient into
   * the single floor texture. Unlike the streamed volume this one carries CPU
   * voxels (`img`) and no `chunkSource`. Returns null (with a warning) when the
   * level is too large to upload as one texture, when the datatype has no
   * per-voxel intensity, or when the fetch fails — a missing floor degrades to
   * today's behavior, so it must never fail the load.
   */
  private async buildCoarseFloor(
    frame = this.shownFrame,
    signal?: AbortSignal,
  ): Promise<NVImage | null> {
    const levelIndex = this.source.levels.length - 1
    const coarse = this.source.levels[levelIndex]
    const dims: Vec3i = [coarse.shape[0], coarse.shape[1], coarse.shape[2]]
    const voxels = dims[0] * dims[1] * dims[2]
    if (
      voxels > COARSE_FLOOR_MAX_VOXELS ||
      Math.max(dims[0], dims[1], dims[2]) > COARSE_FLOOR_MAX_EDGE
    ) {
      log.warn(
        `NVChunkedVolume: no coarse floor, coarsest level ${dims.join('x')} exceeds the floor size cap`,
      )
      return null
    }
    const Ctor = getTypedArrayConstructor(this.source.datatypeCode)
    if (!Ctor) {
      log.warn(
        `NVChunkedVolume: no coarse floor, unsupported datatype ${this.source.datatypeCode}`,
      )
      return null
    }
    try {
      const bytesPerVoxel = getBitsPerVoxel(this.source.datatypeCode) / 8
      const bytes = await this.read({
        levelIndex,
        texOrigin: [0, 0, 0],
        texDims: dims,
        bytesPerVoxel,
        frame,
        signal,
      })
      const floor = createStreamingNVImage({
        shape: dims,
        spacing: coarse.spacing,
        datatypeCode: this.source.datatypeCode,
        xyztUnits: this.source.xyztUnits,
        calMin: this.volume.calMin ?? 0,
        calMax: this.volume.calMax ?? 1,
        colormap: this.volume.colormap,
        isTransparentBelowCalMin: this.volume.isTransparentBelowCalMin,
        name: `${this.volume.name} floor`,
        id: `${this.volumeId}:floor`,
      })
      floor.img = toVoxelView(bytes, Ctor, bytesPerVoxel, voxels)
      // The floor IS the whole volume at its coarsest level, so it is the best
      // window sample available and it costs no extra fetch.
      this.applyAutoWindow(floor)
      // Drawn like the bricks: a label colormap needs a label LUT, built
      // after the window so Random spans the real range.
      floor.colormapLabel = NVCmaps.labelLutFor(floor.colormap, [
        floor.globalMin,
        floor.globalMax,
      ])
      return floor
    } catch (err) {
      // A frame switch's floor must fail the switch, not degrade silently.
      if (signal) throw err
      log.warn('NVChunkedVolume: coarse floor unavailable', err)
      return null
    }
  }

  /**
   * Adopt a 2%-98% display window derived from `sample`, when the caller did
   * not supply one.
   *
   * A streamed volume is constructed before a single voxel has been read, so
   * the window it starts with can only be a placeholder (`calMin` 0 /
   * `calMax` 1). That is meaningless for real data — a uint8 store renders
   * saturated white, a uint16 store nearly black — which is why every consumer
   * has had to hand-tune a window per store. Deriving it here removes that
   * from the callers.
   *
   * `robustMin`/`robustMax` are set from the same pair deliberately: contrast
   * dragging scales by `robustMax - robustMin` (`control/dragModes.ts`), which
   * on the placeholder window is a range of 1, making the drag useless on a
   * streamed volume.
   */
  private applyAutoWindow(sample: NVImage): void {
    if (!this.wantsAutoWindow || this.windowResolved || !sample.img) return
    let derived: [number, number, number, number]
    try {
      derived = robustDisplayWindow(sample.hdr, sample.img)
    } catch (err) {
      // calMinMax throws only for an all-non-finite sample. Keep the
      // placeholder rather than installing a NaN window.
      log.warn(
        'NVChunkedVolume: no automatic window, sample has no finite voxels',
        err,
      )
      return
    }
    const [lo, hi, globalMin, globalMax] = derived
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
      log.warn(
        `NVChunkedVolume: no automatic window, sample is flat (${lo}..${hi})`,
      )
      return
    }
    // `addVolume` stores a SHALLOW COPY of the NVImage
    // (`NVModel.prepareVolume`), and `init` has already added this volume by the
    // time a window can be derived, so the object the scene renders is NOT
    // `this.volume`. Address it by id the way `swapVolumeChunkPlan` does, or the
    // derived window reaches this handle and nothing the user can see.
    const scene = this.host.volumes?.find((v) => v.id === this.volumeId)
    const targets = new Set<NVImage>([this.volume, sample])
    if (scene) targets.add(scene)
    const { calMin, calMax } = this.loadOptions
    const windowLo = windowOr(calMin, lo)
    const windowHi = windowOr(calMax, hi)
    // A scene window that left the placeholder was set while the sample was
    // in flight (setVolume, UIKit, nv-mcp); keep it (#489), and give it to the
    // floor and the handle too, or the floor bakes the auto window into its
    // texture and the shared hdr saves it.
    const userSet =
      scene &&
      (scene.calMin !== windowOr(calMin, 0) ||
        scene.calMax !== windowOr(calMax, 1))
    const keepLo = userSet ? windowOr(scene.calMin, windowLo) : windowLo
    const keepHi = userSet ? windowOr(scene.calMax, windowHi) : windowHi
    for (const vol of targets) {
      vol.calMin = keepLo
      vol.calMax = keepHi
      vol.hdr.cal_min = keepLo
      vol.hdr.cal_max = keepHi
      vol.robustMin = lo
      vol.robustMax = hi
      vol.globalMin = globalMin
      vol.globalMax = globalMax
      // The generated label palette was sized to the placeholder range.
      const grown = NVCmaps.grownLabelLut(vol.colormap, vol.colormapLabel, [
        globalMin,
        globalMax,
      ])
      if (grown) vol.colormapLabel = grown
    }
    this.windowResolved = true
    log.debug(
      `NVChunkedVolume: auto window ${lo}..${hi} (global ${globalMin}..${globalMax})`,
    )
  }

  /**
   * Record a decoded brick's value range and widen the generated label
   * palette to it. The coarse floor (or window probe) only samples the
   * coarsest level, so an ID present only at finer levels would otherwise
   * take the palette's end colour. Independent of the display window: it
   * runs with explicit bounds too. The range is recorded under any colormap,
   * so switching to the generated palette later covers bricks already
   * decoded ({@link growLabelsToObserved}). Bricks arriving together are
   * applied once, and the new LUT changes `chunkedDisplayKey`, so the
   * renderer re-streams the resident bricks with it; re-streamed bricks are
   * covered and do not grow it again.
   */
  private growLabelsFromChunk(bytes: Uint8Array, bytesPerVoxel: number): void {
    if (this.disposed) return
    const Ctor = getTypedArrayConstructor(this.source.datatypeCode)
    if (!Ctor || bytesPerVoxel <= 0) return
    const voxels = Math.floor(bytes.byteLength / bytesPerVoxel)
    const range = NVCmaps.finiteLabelRange(
      toVoxelView(bytes, Ctor, bytesPerVoxel, voxels),
      this.volume.hdr.scl_slope,
      this.volume.hdr.scl_inter,
    )
    if (!range) return
    const seen = this.observedLabelRange
    this.observedLabelRange = seen
      ? [Math.min(seen[0], range[0]), Math.max(seen[1], range[1])]
      : range
    const scene = this.host.volumes?.find((v) => v.id === this.volumeId)
    const shown = scene ?? this.volume
    if (!NVCmaps.isGeneratedLabelColormap(shown.colormap)) return
    const lut = shown.colormapLabel
    if (!lut) return
    if (range[0] >= (lut.min ?? 0) && range[1] <= (lut.max ?? 0)) return
    if (this.labelGrowHandle) return
    this.labelGrowHandle = setTimeout(() => this.applyLabelGrowth(), 0)
  }

  private applyLabelGrowth(): void {
    this.labelGrowHandle = null
    if (this.growLabelsToObserved())
      this.host
        ._updateGLChanged()
        .catch((err) => log.warn('NVChunkedVolume: label palette growth', err))
  }

  /**
   * Widen a generated label palette to every value decoded so far. Called
   * after a colormap change (`setVolume`), since bricks the renderer already
   * holds are not decoded again. Returns whether a LUT grew; the caller
   * updates the renderer.
   */
  growLabelsToObserved(): boolean {
    const range = this.observedLabelRange
    if (!range || this.disposed) return false
    const scene = this.host.volumes?.find((v) => v.id === this.volumeId)
    const targets = new Set<NVImage>([this.volume])
    if (scene) targets.add(scene)
    let grew = false
    for (const vol of targets) {
      const grown = NVCmaps.grownLabelLut(
        vol.colormap,
        vol.colormapLabel,
        range,
      )
      if (grown) {
        vol.colormapLabel = grown
        grew = true
      }
    }
    return grew
  }

  /**
   * Read a bounded centred crop of the coarsest level purely to place the
   * window. Only used when no coarse floor exists to read instead.
   */
  private async probeWindow(): Promise<void> {
    if (!getTypedArrayConstructor(this.source.datatypeCode) || this.disposed)
      return
    const frame = this.shownFrame
    try {
      const probe = await this.readProbe(frame)
      if (this.disposed) return
      // A switch committed meanwhile: the window still fits, the sample does not.
      if (frame === this.shownFrame) this.probe = { image: probe, frame }
      this.applyAutoWindow(probe)
    } catch (err) {
      log.warn('NVChunkedVolume: window probe unavailable', err)
    }
  }

  /** The window probe's crop of the coarsest level at `frame`. */
  private async readProbe(
    frame: number,
    signal?: AbortSignal,
  ): Promise<NVImage> {
    const levelIndex = this.source.levels.length - 1
    const level = this.source.levels[levelIndex]
    const Ctor = getTypedArrayConstructor(this.source.datatypeCode)
    if (!Ctor) throw new TypeError('no typed array for the datatype')
    const texDims: Vec3i = [
      Math.min(level.shape[0], WINDOW_PROBE_MAX_EDGE),
      Math.min(level.shape[1], WINDOW_PROBE_MAX_EDGE),
      Math.min(level.shape[2], WINDOW_PROBE_MAX_EDGE),
    ]
    const texOrigin: Vec3i = [
      Math.floor((level.shape[0] - texDims[0]) / 2),
      Math.floor((level.shape[1] - texDims[1]) / 2),
      Math.floor((level.shape[2] - texDims[2]) / 2),
    ]
    const bytesPerVoxel = getBitsPerVoxel(this.source.datatypeCode) / 8
    const bytes = await this.read({
      levelIndex,
      texOrigin,
      texDims,
      bytesPerVoxel,
      frame,
      signal,
    })
    const probe = createStreamingNVImage({
      shape: texDims,
      spacing: level.spacing,
      datatypeCode: this.source.datatypeCode,
      xyztUnits: this.source.xyztUnits,
      calMin: 0,
      calMax: 1,
      name: `${this.volume.name} window probe`,
      id: `${this.volumeId}:window-probe`,
    })
    probe.img = toVoxelView(
      bytes,
      Ctor,
      bytesPerVoxel,
      texDims[0] * texDims[1] * texDims[2],
    )
    return probe
  }

  private applyRenderCentering(): void {
    if (this.o.renderCentering !== 'pivot') return
    const min = this.volume.extentsMin
    const max = this.volume.extentsMax
    if (!min || !max) return
    this.host.renderPivotMM = vec3.fromValues(
      min[0] + this.focusFrac[0] * (max[0] - min[0]),
      min[1] + this.focusFrac[1] * (max[1] - min[1]),
      min[2] + this.focusFrac[2] * (max[2] - min[2]),
    )
  }
}

/**
 * Reinterpret the coarse level's raw bytes as the source's voxel type. The
 * fetched `Uint8Array` may be a view into a larger buffer at a byte offset the
 * wider element type cannot address, which a typed-array view would reject, so
 * copy in that (rare) case rather than throw.
 */
function toVoxelView(
  bytes: Uint8Array,
  Ctor: NonNullable<ReturnType<typeof getTypedArrayConstructor>>,
  bytesPerVoxel: number,
  voxels: number,
): TypedVoxelArray {
  const aligned =
    bytes.byteOffset % bytesPerVoxel === 0 ? bytes : new Uint8Array(bytes)
  // `buffer` is typed ArrayBufferLike (it may be a SharedArrayBuffer); every
  // typed-array constructor accepts either, so narrow for the signature.
  return new Ctor(aligned.buffer as ArrayBuffer, aligned.byteOffset, voxels)
}

/** NIfTI types whose IDs reach the GPU as floats: FLOAT64, INT64, UINT64. */
const WIDE_LABEL_TYPES = new Set([64, 1024, 1280])

/**
 * Cap on the bytes the voxel readout keeps, the decoded tier's own cap: its
 * bricks are the very buffers the renderer's tier holds for the same plan, so
 * below the cap they cost no extra memory.
 */
const READOUT_BYTES = 384 * 1024 ** 2

type ReadoutBrick = {
  level: number
  origin: Vec3i
  dims: Vec3i
  view: TypedVoxelArray
}

/**
 * The decoded bricks of the shown frame's current plan, so a hover readout
 * is exact (source values, labels as integer IDs) at the finest level held.
 * Like the renderer's decoded tier it shadows the plan (a refocus drops the
 * bricks the new plan left), and a frame switch starts it over from the
 * bricks that switch staged; bricks of a frame not yet shown never enter.
 * ponytail: linear scan per read; a few hundred bricks at hover rate.
 */
class BrickReadout {
  private bricks = new Map<string, ReadoutBrick>()
  private bytes = 0
  constructor(
    private readonly source: ChunkedVolumeSource,
    private readonly frame: () => number,
    private readonly cap: () => number,
  ) {}

  /** Regions of the current plan: only its bricks are on screen to read. */
  private planKeys = new Set<string>()

  add(bytes: Uint8Array, req: SourceRegionRead): void {
    const key = regionKey(req.levelIndex, req.texOrigin, req.texDims)
    if (req.frame === this.frame() && this.planKeys.has(key))
      this.put(key, bytes)
  }

  /** Start over on frame `t` with the bricks its switch staged. */
  reset(staged: ReadonlyMap<string, Uint8Array>, _t: number): void {
    this.bricks.clear()
    this.bytes = 0
    for (const [key, bytes] of staged) this.put(key, bytes)
  }

  /** Drop the bricks a new plan no longer holds. */
  keep(plan: ChunkPlan): void {
    const kept = new Set(chunkRegionKeys(plan))
    this.planKeys = kept
    for (const [key, b] of this.bricks)
      if (!kept.has(key)) {
        this.bricks.delete(key)
        this.bytes -= b.view.byteLength
      }
  }

  private put(key: string, bytes: Uint8Array): void {
    const Ctor = getTypedArrayConstructor(this.source.datatypeCode)
    const bpv = getBitsPerVoxel(this.source.datatypeCode) / 8
    if (!Ctor || !(bpv > 0)) return
    const [level, origin, dims] = key
      .split('|')
      .map((p, i) => (i ? (p.split(',').map(Number) as Vec3i) : Number(p))) as [
      number,
      Vec3i,
      Vec3i,
    ]
    const voxels = dims[0] * dims[1] * dims[2]
    // A short reply fails its upload; it never reaches the readout either.
    if (bytes.byteLength < voxels * bpv) return
    const old = this.bricks.get(key)
    if (old) this.bytes -= old.view.byteLength
    this.bricks.delete(key)
    const view = toVoxelView(bytes, Ctor, bpv, voxels)
    this.bricks.set(key, { level, origin, dims, view })
    this.bytes += view.byteLength
    this.trim()
  }

  /** Evict the oldest bricks down to the current share of the cap. */
  trim(): void {
    for (const [k, b] of this.bricks) {
      if (this.bytes <= this.cap() || this.bricks.size === 1) break
      this.bricks.delete(k)
      this.bytes -= b.view.byteLength
    }
  }

  /** Raw value at common-grid voxel [x, y, z], NaN when no brick holds it. */
  value(x: number, y: number, z: number): number {
    const levels = this.source.levels
    const common = levels[0].shape
    let best = Number.NaN
    let bestLevel = Number.POSITIVE_INFINITY
    for (const { level, origin: o, dims, view } of this.bricks.values()) {
      if (level >= bestLevel) continue
      const shape = levels[level].shape
      const [w, h, d] = dims
      const lx = Math.floor((x * shape[0]) / common[0]) - o[0]
      const ly = Math.floor((y * shape[1]) / common[1]) - o[1]
      const lz = Math.floor((z * shape[2]) / common[2]) - o[2]
      if (lx < 0 || ly < 0 || lz < 0 || lx >= w || ly >= h || lz >= d) continue
      best = view[lx + w * (ly + h * lz)]
      bestLevel = level
    }
    return best
  }
}

/** Per-axis max of `halo` and `minHalo`; never shrinks an axis. */
function raiseHalo(halo: Vec3i, minHalo: number): Vec3i {
  return [
    Math.max(halo[0], minHalo),
    Math.max(halo[1], minHalo),
    Math.max(halo[2], minHalo),
  ]
}

/** A refocus request's completion, resolved by whichever swap absorbs it. */
interface RefocusDeferred {
  promise: Promise<void>
  resolve: () => void
}

function createRefocusDeferred(): RefocusDeferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function clampLevel(levelIndex: number, source: ChunkedVolumeSource): number {
  return Math.min(Math.max(0, Math.floor(levelIndex)), source.levels.length - 1)
}

/**
 * The host's configured 3D-texture cap (the `maxTextureDimension3D` NiiVue
 * option), when set. `deviceLimit` defaults to this so planned bricks never
 * exceed what the renderer will upload.
 */
function hostDeviceLimit(host: NiiVue): number | undefined {
  const limit = host.opts?.maxTextureDimension3D
  return typeof limit === 'number' && limit > 0 ? limit : undefined
}
