import { mat4, vec3 } from 'gl-matrix'
import { log } from '@/logger'
import { SLICE_TYPE } from '@/NVConstants'
import type NiiVue from '@/NVControlBase'
import type { NVImage, TypedVoxelArray, VolumeChunkSource } from '@/NVTypes'
import type {
  BudgetPlan,
  BudgetPlanContext,
  BudgetPlanOptions,
  BudgetPlanSpec,
  PlanShapeOptions,
  ResolvedOptions,
} from './budgetPlans'
import { resolveBudgetPlan } from './budgetPlans'
import type { ChunkedVolumeSource } from './ChunkedVolumeSource'
import {
  type ChunkPlan,
  CUBIC_MIN_HALO,
  chunkVolumeMultiLOD,
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
export interface ChunkedVolumeOptions extends BudgetPlanOptions {
  /** Display window minimum (default 0). */
  calMin?: number
  /** Display window maximum (default 1). */
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
  /** Max concurrent source fetches (default 6; bounds the request flood). */
  maxConcurrentLoads?: number
  /** Retry attempts for a transient fetch failure (default 3, exp backoff). */
  retryAttempts?: number
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

/**
 * Build a crosshair-focused multi-LOD plan for a source at a focus + radius.
 * Takes only the plan-shaping options: the coarse floor is a display backdrop,
 * not an input to the octree.
 */
export function planForFocus(
  source: ChunkedVolumeSource,
  focusFrac: Vec3f,
  radius: number,
  o: PlanShapeOptions,
): ChunkPlan {
  const levelDims = source.levels.map((l) => l.shape)
  const center = focusCenterBiased(levelDims[0], focusFrac, o.cellEdge)
  return chunkVolumeMultiLOD(levelDims, { center, radius }, o.deviceLimit, {
    cellEdge: o.cellEdge,
    gridDims: o.gridDims,
    haloSize: o.halo,
    detail: o.detail,
    minLevel: o.minLevel,
    budgetBytes: o.budgetBytes,
    maxBricks: o.maxBricks,
  })
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
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
      await delay(80 * 2 ** i)
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

/**
 * Wrap a {@link ChunkedVolumeSource} as a renderer `VolumeChunkSource`: dispatch
 * each brick to its own pyramid level (`desc.sourceLevel`), bound in-flight
 * fetches to `maxConcurrentLoads` (so a big focus never floods the connection
 * pool), retry transient failures, and dedup concurrent requests for the same
 * region. In-flight entries are dropped on settle so resolved buffers are not
 * retained (residency/eviction is the renderer's job).
 */
export function createSourceChunkLoader(
  source: ChunkedVolumeSource,
  opts: { maxConcurrentLoads: number; retryAttempts: number },
): VolumeChunkSource {
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

  return (request) => {
    const levelIndex = request.desc.sourceLevel ?? 0
    const texOrigin = request.desc.texOrigin
    const texDims = request.desc.texDims
    const signal = request.signal
    // Content key (level + region), stable across plan swaps where the chunk
    // INDEX changes but the fetched region does not.
    const key = `${levelIndex}|${texOrigin.join(',')}|${texDims.join(',')}`
    const cached = inflight.get(key)
    if (cached) {
      cached.waiters++
      joinRead(cached, signal)
      return cached.promise
    }
    const controller = new AbortController()
    const promise = acquire()
      .then(() =>
        withRetry(
          () =>
            source.fetchChunk({
              levelIndex,
              texOrigin,
              texDims,
              bytesPerVoxel: request.bytesPerVoxel,
              signal: controller.signal,
            }),
          totalAttempts,
        ),
      )
      .finally(() => release())
    const entry: InflightRead = { promise, controller, waiters: 1 }
    inflight.set(key, entry)
    joinRead(entry, signal)
    // Drop the in-flight entry on settle. Attach cleanup as BOTH handlers of a
    // .then so the derived promise resolves even when `promise` rejects (a
    // brick that exhausts retries) — a bare `.finally` here would re-raise into
    // an unobserved promise. Callers still receive the original promise (and
    // its rejection); this derived promise is intentionally not returned.
    const cleanup = (): void => {
      if (inflight.get(key) === entry) inflight.delete(key)
    }
    promise.then(cleanup, cleanup)
    return promise
  }
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
 * renderer that supplies none behaves exactly as it did before.
 */
function joinRead(entry: InflightRead, signal: AbortSignal | undefined): void {
  if (!signal) return
  const withdraw = (): void => {
    entry.waiters--
    if (entry.waiters <= 0) entry.controller.abort(signal.reason)
  }
  if (signal.aborted) {
    withdraw()
    return
  }
  signal.addEventListener('abort', withdraw, { once: true })
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

  private readonly volumeId: string
  private readonly host: NiiVue
  private readonly source: ChunkedVolumeSource
  private readonly o: ResolvedOptions
  /** The options this volume was loaded with; re-folded by {@link setBudgetPlan}. */
  private readonly loadOptions: ChunkedVolumeOptions
  private followCrosshair: boolean
  private subscribedToCrosshair = false
  private readonly onLocationChange: () => void
  private readonly onViewDestroyed: () => void

  private focusFrac: Vec3f
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
   * awaits it ({@link whenSettled}, {@link doRefocus}), because the chain can
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
  /**
   * True when the caller passed NEITHER `calMin` nor `calMax`, so the window is
   * ours to derive from the data. Passing either one is taken as "I know this
   * store", and nothing is derived.
   */
  private readonly wantsAutoWindow: boolean
  private windowResolved = false

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
    this.loadOptions = options
    // The plan-shaping options are folded by resolveBudgetPlan, so a preset, an
    // explicit plan, and the individual knobs all land in one place with one
    // precedence rule (knobs win). Passing no plan reproduces the pre-plan
    // defaults exactly.
    this.o = resolveBudgetPlan(options, this.planContext())
    this.wantsAutoWindow =
      options.calMin === undefined && options.calMax === undefined
    this.followCrosshair = this.o.focus === 'crosshair'
    this.focusFrac = Array.isArray(this.o.focus)
      ? [this.o.focus[0], this.o.focus[1], this.o.focus[2]]
      : [0.5, 0.5, 0.5]
    host._registerChunkedVolume(this)
    this.onLocationChange = () => this.handleLocationChange()
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
    this.volume = createStreamingNVImage({
      shape: finest.shape,
      spacing: finest.spacing,
      datatypeCode: source.datatypeCode,
      calMin: options.calMin ?? 0,
      calMax: options.calMax ?? 1,
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
    this.volume.chunkSource = createSourceChunkLoader(source, {
      maxConcurrentLoads: options.maxConcurrentLoads ?? 6,
      retryAttempts: options.retryAttempts ?? 3,
    })
  }

  /**
   * ADD the streamed volume to the scene (does NOT replace existing volumes)
   * and — for crosshair focus — start following the crosshair. The caller owns
   * removing a previously streamed volume before reloading.
   */
  async init(): Promise<void> {
    await this.host.addVolume(this.volume)
    this.syncCrosshairSubscription()
    // Self-dispose if the controller is destroyed without the caller disposing
    // this handle, so the locationChange listener + host reference don't leak
    // (and can't fire against a torn-down view).
    this.host.addEventListener('viewDestroyed', this.onViewDestroyed)
    this.applyRenderCentering()
    await this.applyCoarseFloor()
    // The floor path resolves the window for free when a floor was built. When
    // it was not, fall back to a bounded probe so a streamed volume still opens
    // on a window that shows the data rather than on the 0..1 placeholder.
    if (this.wantsAutoWindow && !this.windowResolved) await this.probeWindow()
    if (this.windowResolved && !this.disposed) await this.host.updateGLVolume()
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
      this.floorVolume = await this.buildCoarseFloor()
      this.floorBuilt = true
    }
    if (this.disposed) return false
    await this.host.setBaseCoarseFloor(this.floorVolume)
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
   * Move the focus and rebuild+swap the plan (debounced). Resolves when the
   * swap has applied; see {@link refocus}. On a disposed manager it resolves
   * immediately and changes nothing.
   */
  setFocus(frac: Vec3f): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.focusFrac = [frac[0], frac[1], frac[2]]
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
      radius: this.o.radius,
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
      { ...this.loadOptions, budgetPlan: plan, minLevel: this.o.minLevel },
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
    // Adopt the crosshair NOW rather than waiting for the next locationChange,
    // so switching back to a crosshair plan does not plan around a stale focus.
    if (this.followCrosshair) this.handleLocationChange()
    return this.refocus()
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
  async whenSettled(): Promise<void> {
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
    // A cancelled refocus never applies, so release anyone awaiting it now.
    const pending = this.pendingRefocus
    this.pendingRefocus = null
    pending?.resolve()
    // Release everyone racing on the swap chain (whenSettled, a doRefocus
    // queued behind an in-flight swap): a swap the host is still holding may
    // never settle now, and nothing further will be applied regardless.
    this.disposedDeferred.resolve()
    this.followCrosshair = false
    this.syncCrosshairSubscription()
    this.host.removeEventListener('viewDestroyed', this.onViewDestroyed)
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
    return planForFocus(
      this.source,
      this.focusFrac,
      this.currentRadius(),
      this.o,
    )
  }

  private currentRadius(): number {
    const radius = this.o.radius
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
    const zoom = Math.max(1, this.host.pan2Dxyzmm[3] || 1)
    return Math.hypot(common[0], common[1], common[2]) / (2 * zoom)
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
      try {
        await this.host.swapVolumeChunkPlan(this.id, plan)
      } catch (err) {
        log.warn('NVChunkedVolume: refocus swap failed', err)
      }
      this.applyRenderCentering()
    })
    // Keep the shared chain resolved so a later throw cannot break the queue,
    // but say so: the swap itself already logs its own failures, so anything
    // landing here (applyRenderCentering, the commit) is unexpected.
    // The count drops on the chain (before any awaiting caller resumes), so
    // whenSettled never observes a swap as in flight after it has applied.
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
  private async buildCoarseFloor(): Promise<NVImage | null> {
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
      const bytes = await this.source.fetchChunk({
        levelIndex,
        texOrigin: [0, 0, 0],
        texDims: dims,
        bytesPerVoxel,
      })
      const floor = createStreamingNVImage({
        shape: dims,
        spacing: coarse.spacing,
        datatypeCode: this.source.datatypeCode,
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
      return floor
    } catch (err) {
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
    for (const vol of targets) {
      vol.calMin = lo
      vol.calMax = hi
      vol.robustMin = lo
      vol.robustMax = hi
      vol.globalMin = globalMin
      vol.globalMax = globalMax
      vol.hdr.cal_min = lo
      vol.hdr.cal_max = hi
    }
    this.windowResolved = true
    log.debug(
      `NVChunkedVolume: auto window ${lo}..${hi} (global ${globalMin}..${globalMax})`,
    )
  }

  /**
   * Read a bounded centred crop of the coarsest level purely to place the
   * window. Only used when no coarse floor exists to read instead.
   */
  private async probeWindow(): Promise<void> {
    const levelIndex = this.source.levels.length - 1
    const level = this.source.levels[levelIndex]
    const Ctor = getTypedArrayConstructor(this.source.datatypeCode)
    if (!Ctor || this.disposed) return
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
    try {
      const bytesPerVoxel = getBitsPerVoxel(this.source.datatypeCode) / 8
      const bytes = await this.source.fetchChunk({
        levelIndex,
        texOrigin,
        texDims,
        bytesPerVoxel,
      })
      if (this.disposed) return
      const probe = createStreamingNVImage({
        shape: texDims,
        spacing: level.spacing,
        datatypeCode: this.source.datatypeCode,
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
      this.applyAutoWindow(probe)
    } catch (err) {
      log.warn('NVChunkedVolume: window probe unavailable', err)
    }
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
