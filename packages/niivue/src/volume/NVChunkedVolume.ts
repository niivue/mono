import { mat4, vec3 } from 'gl-matrix'
import { log } from '@/logger'
import { SLICE_TYPE } from '@/NVConstants'
import type NiiVueGPU from '@/NVControlBase'
import type { NVImage, VolumeChunkSource } from '@/NVTypes'
import type { ChunkedVolumeSource } from './ChunkedVolumeSource'
import {
  type ChunkPlan,
  chunkVolumeMultiLOD,
  type Vec3f,
  type Vec3i,
} from './chunking'
import { createStreamingNVImage } from './streamingVolume'

/** Options for {@link NiiVueGPU.loadChunkedVolume}. */
export interface ChunkedVolumeOptions {
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
  /**
   * Focus that drives the octree. `'crosshair'` (default) makes the finest
   * bricks follow the crosshair (auto-subscribes `locationChange`); a `[x,y,z]`
   * fraction pins a static focus.
   */
  focus?: 'crosshair' | Vec3f
  /**
   * Finest-LOD radius in common-grid voxels. `'auto'` (default) derives it from
   * the view: tight in the 3D render view, the visible-slice box in multiplanar
   * (shrinking with 2D zoom). A number pins it.
   */
  radius?: 'auto' | number
  /** GPU byte budget for the planned brick set (default 1.5 GB). */
  budgetBytes?: number
  /** Max bricks in the plan (default 240; must stay < the renderer's per-tile cap). */
  maxBricks?: number
  /** Brick texture edge in level voxels (default 128). */
  cellEdge?: number
  /** Per-axis halo in level voxels (default [1,1,1]). */
  halo?: Vec3i
  /** LOD falloff factor (default 1 = 2:1-balanced octree). */
  detail?: number
  /** Finest level index (max-detail cap; 0 = finest, default 0). */
  minLevel?: number
  /**
   * Max brick texture edge the renderer will upload. MUST match the NiiVue
   * `maxTextureDimension3D` option (default 256).
   */
  deviceLimit?: number
  /** Max concurrent source fetches (default 6; bounds the request flood). */
  maxConcurrentLoads?: number
  /** Retry attempts for a transient fetch failure (default 3, exp backoff). */
  retryAttempts?: number
  /** Center the 3D render on the crosshair: 'pivot' (orbit about it) or 'none' (default). */
  renderCentering?: 'pivot' | 'none'
  /** Debounce for focus-follow rebuilds, ms (default 150). */
  debounceMs?: number
}

interface ResolvedOptions {
  budgetBytes: number
  maxBricks: number
  cellEdge: number
  halo: Vec3i
  detail: number
  minLevel: number
  deviceLimit: number
  renderCentering: 'pivot' | 'none'
  debounceMs: number
}

const DEFAULT_BUDGET_BYTES = 1_500_000_000

// --- pure helpers (unit-tested; no controller needed) -----------------------

/**
 * Nudge a focus centre off exact octree cell boundaries. A focus ball straddling
 * a boundary forces the bricks on BOTH sides to the finest level, which can blow
 * the budget and collapse the whole plan to a coarse floor; the small asymmetric
 * bias keeps the finest core inside one cell so the brick count stays stable.
 */
export function focusCenterBiased(
  common: Vec3i,
  frac: Vec3f,
  cellEdge: number,
): Vec3f {
  const base: Vec3f = [
    frac[0] * common[0],
    frac[1] * common[1],
    frac[2] * common[2],
  ]
  const bias: Vec3f = [cellEdge * 0.31, cellEdge * 0.17, cellEdge * 0.23]
  return [
    Math.min(common[0] - bias[0], base[0] + bias[0]),
    Math.min(common[1] - bias[1], base[1] + bias[1]),
    Math.min(common[2] - bias[2], base[2] + bias[2]),
  ]
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

/** Build a crosshair-focused multi-LOD plan for a source at a focus + radius. */
export function planForFocus(
  source: ChunkedVolumeSource,
  focusFrac: Vec3f,
  radius: number,
  o: ResolvedOptions,
): ChunkPlan {
  const levelDims = source.levels.map((l) => l.shape)
  const center = focusCenterBiased(levelDims[0], focusFrac, o.cellEdge)
  return chunkVolumeMultiLOD(levelDims, { center, radius }, o.deviceLimit, {
    cellEdge: o.cellEdge,
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
  const inflight = new Map<string, Promise<Uint8Array>>()
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = (): Promise<void> => {
    if (active < opts.maxConcurrentLoads) {
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
    // Content key (level + region), stable across plan swaps where the chunk
    // INDEX changes but the fetched region does not.
    const key = `${levelIndex}|${texOrigin.join(',')}|${texDims.join(',')}`
    const cached = inflight.get(key)
    if (cached) return cached
    const next = acquire()
      .then(() =>
        withRetry(
          () =>
            source.fetchChunk({
              levelIndex,
              texOrigin,
              texDims,
              bytesPerVoxel: request.bytesPerVoxel,
            }),
          opts.retryAttempts,
        ),
      )
      .finally(() => release())
    inflight.set(key, next)
    // Drop the in-flight entry on settle. Attach cleanup as BOTH handlers of a
    // .then so the derived promise resolves even when `next` rejects (a brick
    // that exhausts retries) — a bare `.finally` here would re-raise into an
    // unobserved promise. Callers still receive the original `next` (and its
    // rejection); this derived promise is intentionally not returned.
    const cleanup = (): void => {
      if (inflight.get(key) === next) inflight.delete(key)
    }
    next.then(cleanup, cleanup)
    return next
  }
}

// --- the manager ------------------------------------------------------------

/**
 * A crosshair-focused multi-resolution (multi-LOD) streamed volume. Built by
 * {@link NiiVueGPU.loadChunkedVolume}. Owns the octree plan, per-level fetch
 * dispatch (bounded/retried/deduped), and — for `focus: 'crosshair'` — rebuilds
 * and swaps the plan in place as the crosshair moves, so the finest bricks track
 * where the user is looking while resident VRAM stays bounded by the budget.
 */
export class NVChunkedVolume {
  readonly volume: NVImage

  private readonly host: NiiVueGPU
  private readonly source: ChunkedVolumeSource
  private readonly o: ResolvedOptions
  private readonly followCrosshair: boolean
  private readonly radiusOpt: 'auto' | number
  private readonly onLocationChange: () => void

  private focusFrac: Vec3f
  private plan: ChunkPlan
  private disposed = false
  private refocusHandle: ReturnType<typeof setTimeout> | null = null
  private swapChain: Promise<void> = Promise.resolve()

  constructor(
    host: NiiVueGPU,
    source: ChunkedVolumeSource,
    options: ChunkedVolumeOptions = {},
  ) {
    if (source.levels.length < 1) {
      throw new Error('ChunkedVolumeSource has no levels')
    }
    this.host = host
    this.source = source
    this.o = {
      budgetBytes: options.budgetBytes ?? DEFAULT_BUDGET_BYTES,
      maxBricks: options.maxBricks ?? 240,
      cellEdge: options.cellEdge ?? 128,
      halo: options.halo ?? [1, 1, 1],
      detail: options.detail ?? 1,
      minLevel: clampLevel(options.minLevel ?? 0, source),
      deviceLimit: options.deviceLimit ?? 256,
      renderCentering: options.renderCentering ?? 'none',
      debounceMs: options.debounceMs ?? 150,
    }
    this.radiusOpt = options.radius ?? 'auto'
    const focus = options.focus ?? 'crosshair'
    this.followCrosshair = focus === 'crosshair'
    this.focusFrac = Array.isArray(focus)
      ? [focus[0], focus[1], focus[2]]
      : [0.5, 0.5, 0.5]
    this.onLocationChange = () => this.handleLocationChange()

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
    this.volume.chunkPlan = this.plan
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
    if (this.followCrosshair) {
      this.host.addEventListener('locationChange', this.onLocationChange)
    }
    this.applyRenderCentering()
  }

  /** The volume's stable id (used to target plan swaps). */
  get id(): string {
    return this.volume.id ?? this.volume.name
  }

  /** Current focus as a [0,1] fraction of the common grid. */
  get focus(): Vec3f {
    return [this.focusFrac[0], this.focusFrac[1], this.focusFrac[2]]
  }

  /** The current multi-LOD plan (read-only; useful for debugging/telemetry). */
  get currentPlan(): ChunkPlan {
    return this.plan
  }

  /** Move the focus and rebuild+swap the plan (debounced). */
  setFocus(frac: Vec3f): void {
    this.focusFrac = [frac[0], frac[1], frac[2]]
    this.refocus()
  }

  /** Cap the finest level the octree may use (index into `source.levels`). */
  setMaxDetail(levelIndex: number): void {
    this.o.minLevel = clampLevel(levelIndex, this.source)
    this.refocus()
  }

  /** Change the plan's GPU byte budget. */
  setBudget(bytes: number): void {
    this.o.budgetBytes = bytes
    this.refocus()
  }

  /** Streaming residency counters (delegates to the controller). */
  stats(): ReturnType<NiiVueGPU['chunkStreamStats']> {
    return this.host.chunkStreamStats()
  }

  /** Debounced rebuild + in-place plan swap. */
  refocus(): void {
    if (this.disposed) return
    if (this.refocusHandle) clearTimeout(this.refocusHandle)
    this.refocusHandle = setTimeout(() => {
      this.refocusHandle = null
      void this.doRefocus()
    }, this.o.debounceMs)
  }

  /** Stop following the crosshair and release the manager (leaves the volume loaded). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.refocusHandle) {
      clearTimeout(this.refocusHandle)
      this.refocusHandle = null
    }
    if (this.followCrosshair) {
      this.host.removeEventListener('locationChange', this.onLocationChange)
    }
  }

  private handleLocationChange(): void {
    // Map the crosshair (world mm) to THIS volume's texture fraction. Correct
    // even when the volume doesn't span the scene AABB or sits on a non-identity
    // grid; falls back to the raw scene fraction if frac2mm is unavailable (it
    // coincides with the volume fraction for a single axis-aligned volume).
    const f2m = this.volume.frac2mm
    if (f2m) {
      const mm = this.host.getCrosshairPos()
      const frac = mmToVolumeFraction(f2m, [mm[0], mm[1], mm[2]])
      if (frac) {
        this.focusFrac = frac
        this.refocus()
        return
      }
    }
    const cp = this.host.crosshairPos
    this.focusFrac = [cp[0], cp[1], cp[2]]
    this.refocus()
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
    if (typeof this.radiusOpt === 'number') return this.radiusOpt
    const common = this.source.levels[0].shape
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
    // Keep the shared chain resolved so a later throw cannot break the queue.
    this.swapChain = applied.catch(() => {})
    await applied
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

function clampLevel(levelIndex: number, source: ChunkedVolumeSource): number {
  return Math.min(Math.max(0, Math.floor(levelIndex)), source.levels.length - 1)
}
