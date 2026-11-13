// The chunk-streaming controller both volume renderers (gl/, wgpu/ render.ts)
// share: plan swaps, working-set requests, speculation, the upload pump and the
// streamed-overlay bookkeeping. A base class rather than a member object so the
// draw code keeps reading `this._activeChunked` and friends unchanged; the
// backends supply the GPU work through the abstract hooks at the end.
import type { ByteLru, ByteLruStats } from '@/byteLru'
import { log } from '@/logger'
import { VOLUME_DEFAULTS } from '@/NVConstants'
import type { ChunkStreamCounts, ChunkStreamDetail } from '@/NVEvents'
import type { NVImage } from '@/NVTypes'
import {
  type ChunkStackFuse,
  chunkRegions,
  stackGeneration,
  stackInputs,
  stackModes,
} from '@/view/chunkStackFuse'
import { NVRenderer } from '@/view/NVRenderer'
import { chunkExplodeEnabled } from './ChunkExplode'
import type { ChunkResidencyManager } from './ChunkResidency'
import {
  chunksInFrustum,
  chunksNotClippedOut,
  orderByViewCenter,
} from './ChunkVisibility'
import { chunkIndicesForAllBudgets } from './chunkBudget'
import {
  type ChunkPlan,
  chunksToKeepResident,
  matchChunksByContent,
  planSupportsCubic,
  type VolumeChunkDesc,
  warnIfCubicUnsafe,
} from './chunking'
import type { ChunkTravelPredictor } from './chunkPrediction'
import { setChunkBudget } from './chunkRender'
import {
  buildModulationParams,
  type ModulationTextureParams,
} from './modulation'
import {
  chunkedDisplayKey,
  volumeCacheKey,
  volumeSourceKey,
} from './orientChunked'

/**
 * Default GPU memory budget, in bytes, for a chunked volume's resident chunk
 * set (decoded chunk textures plus gradients, excluding the transient upload).
 * Picked to fit below a typical 4 GiB discrete-GPU budget while leaving
 * headroom for overlays, fonts, and other resident textures. Overridable per
 * instance via the `maxChunkResidencyBytes` option; the ChunkResidencyManager
 * evicts least-recently-visible chunks to keep the resident set within budget.
 */
export const DEFAULT_CHUNK_RESIDENCY_BYTES = 1_500_000_000

/**
 * Maximum chunks a single chunked volume may tile into. Bounds WebGPU's
 * per-chunk uniform-buffer slot allocation (one slot per chunk per chunk-tile;
 * see MAX_CHUNK_TILES there); WebGL2 sets per-chunk uniforms per draw and
 * shares the limit so both backends fail the same way. A volume that tiles into
 * more fails fast with a clear error: a structural limit, not a memory budget
 * (memory pressure is handled by chunk eviction). Raised to 1024 (from 256) so
 * full-resolution pyramid levels of large volumes still load.
 */
export const MAX_CHUNKS_PER_TILE = 1024

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
export const MAX_CHUNK_UPLOADS_PER_FRAME = 24
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

/** One resident chunk's GPU textures (VolumeChunkGL / VolumeChunkGPU). */
export interface StreamChunk<TTex> {
  /** RGBA8 color texture for this chunk; sized desc.texDims (includes halo). */
  volumeTexture: TTex
  /** Gradient texture: sized desc.texDims when `hasGradient`, else 1x1x1. */
  volumeGradientTexture: TTex
  /** False when the gradient pass was skipped (unlit at upload). */
  hasGradient: boolean
  /** Reference to the chunk descriptor (texOrigin/texDims/halos/gridIndex). */
  desc: VolumeChunkDesc
}

/** On-demand chunk uploader (ChunkUploaderGL / ChunkUploaderGPU). */
export interface StreamChunkUploader<TChunk> {
  uploadChunk(index: number): Promise<TChunk>
  prefetchChunk(index: number, speculative?: boolean): void
  cancelChunk(index: number): void
  dispose(): void
}

/** Chunked (tiled) volume: one or more axes exceed the 3D texture limit. */
export interface StreamEntry<TChunk, TUploader> {
  kind: 'chunked'
  /** Volume object that owns mutable per-volume render options. */
  volume: NVImage
  /** GPU residency bookkeeping for the volume's chunks. */
  manager: ChunkResidencyManager<TChunk>
  /** On-demand uploader the streaming pump drives to fill the manager. */
  uploader: TUploader
  plan: ChunkPlan
  /**
   * chunkedDisplayKey at uploader creation. Resident chunk textures bake the
   * colormap/window this key captures, so a mismatch on updateVolume forces an
   * uploader rebuild + full re-stream (see _ensureChunkedVolumeEntry).
   */
  displayKey: string
  /**
   * volumeSourceKey of the image the entry streams. Voxels or a source
   * replaced on the same volume build a new entry, decoded tier included,
   * rather than reusing chunks read from the old one.
   */
  sourceKey: string
  /**
   * Modulation the uploader bakes into every chunk (resolved against the
   * volume's own grid), or null. Kept so a plan swap rebuilds the uploader
   * with the same modulator; `displayKey` covers it for change detection.
   */
  modulation: ModulationTextureParams | null
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
  decoded: ByteLru<number, Uint8Array>
  /** Source bytes per voxel, which sets what the decoded tier costs to hold. */
  sourceBytesPerVoxel: number
  /**
   * The plan swapChunkedVolumePlan is moving this entry to, while the swap is
   * queued or awaits its uploader. A refresh that lands in that window waits
   * for it instead of evicting the entry as built for a different plan.
   */
  pendingSwap?: { plan: ChunkPlan; done: Promise<void> }
  /**
   * The last swap queued on this entry. Swaps run one at a time in call order
   * (each reads the plan and residency, awaits, then rewrites them), and one
   * that a later swap supersedes is skipped.
   */
  swapTail?: Promise<void>
}

export abstract class ChunkStreamRenderer<
  TCtx,
  TTex,
  TChunk extends StreamChunk<TTex>,
  TUploader extends StreamChunkUploader<TChunk>,
  TEntry extends StreamEntry<TChunk, TUploader>,
  TSingle extends { kind: 'single' },
> extends NVRenderer {
  // GPU memory budget for a chunked volume's resident chunk set. Set from the
  // maxChunkResidencyBytes option in init; passed to each ChunkResidencyManager.
  protected _chunkResidencyBytes = DEFAULT_CHUNK_RESIDENCY_BYTES
  // Cross-fade duration, ms, for a freshly-admitted streaming chunk. Set from
  // the chunkFadeMs option when the view initializes; 0 disables the fade.
  chunkFadeMs = DEFAULT_CHUNK_FADE_MS
  // Tricubic B-spline instead of hardware trilinear in the background fine pass
  // (from md.volume.isCubicInterpolation). Cures the blocky texel staircase that
  // C0 trilinear leaves on band edges, at 8 fetches per sample instead of 1.
  // Assigned every frame by the view, so the setter is where an "on, but the
  // active chunk plan cannot feed the kernel" warning is raised: it is the only
  // point that sees the request and the current plan together (the entry may
  // have been built long before the user turned cubic on).
  private _isCubicInterpolation = VOLUME_DEFAULTS.isCubicInterpolation
  // Per-volume GPU texture cache. Populated by updateVolume; consumed by
  // bindCachedVolume to switch the active volume/gradient texture per tile
  // when rendering multi-instance global3d scenes.
  protected _texCache: Map<string, TSingle | TEntry> = new Map()
  // True once any chunk was uploaded without a real gradient (unlit). If lighting
  // is later enabled, those chunks are re-streamed so they gain gradients.
  protected _uploadedUnlit = false
  // Set when the active volume is chunked; null for single-texture volumes.
  // draw() branches on this to run the multi-chunk loop.
  protected _activeChunked: TEntry | null = null
  // Set when an independently-streamed hi-res overlay (chunkOverlayOf) is
  // loaded over a chunked base. It has its OWN ChunkPlan + residency manager
  // (a second _texCache entry, keyed by its own url/name) and draws as
  // translucent chunk cubes over the base, instead of being resliced onto the
  // base grid. Null when no such overlay is present (base path unchanged).
  protected _activeOverlayChunked: TEntry | null = null
  // Streamed combined overlays (strategy A): base-aligned chunked overlay
  // entries (chunkSource, co-registered at the base grid) that stream via the
  // pump and feed the base block's overlay slot — base ray-march / clip plane /
  // compositing reused unchanged.
  protected _combinedOverlayEntries: TEntry[] = []
  // A channel stack over a chunked base: per base chunk, the drawn channels'
  // bricks (base and combined mirrors) fused into the overlay slot. Null
  // otherwise.
  protected _stackFuse: ChunkStackFuse<TTex> | null = null
  /** Set while the stack's mirror list is being rebuilt: no fuse then. */
  protected _stackRebuilding = 0
  private _pumpInFlight = false
  // Wall-clock stamp captured once per frame in beginChunkFrame, so every chunk
  // draw in the frame measures fade age against the same instant.
  protected _frameNow = 0
  // Set true during a frame whenever a chunk drew mid cross-fade, so the view
  // schedules a follow-up frame to keep the fade animating to completion.
  protected _fadeActive = false

  // Renderer state the shared code reads; each backend declares and sets it.
  abstract placeholderOverlay: TTex | null
  abstract overlayChunks: TTex[] | null
  abstract paqdChunks: TTex[] | null
  abstract coarseFloorTexture: TTex | null
  abstract overlayAlphaBlend: number
  abstract overlayColorBlend: number
  abstract gradientAmount: number
  abstract gradientOpacity: number
  abstract silhouette: number
  /** Near-plane depth convention of the backend's clip space (WebGPU z in [0, w]). */
  protected abstract readonly clipSpaceZeroToOne: boolean

  get isCubicInterpolation(): boolean {
    return this._isCubicInterpolation
  }
  set isCubicInterpolation(v: boolean) {
    this._isCubicInterpolation = v
    const entry = this._activeChunked
    if (entry) warnIfCubicUnsafe(entry.volume.name, entry.cubicSafe, v)
  }

  /** The stack fuse's chunks and ms (CPU side), for benches. */
  get stackFuseStats(): { chunks: number; ms: number } {
    return this._stackFuse?.stats ?? { chunks: 0, ms: 0 }
  }

  /**
   * Swap a chunked volume's plan in place (multi-LOD refocus): re-key the
   * resident GPU chunks to the new plan by content (`matchChunksByContent`) so
   * unchanged bricks keep their texture and fade, and only changed/new bricks
   * stream — instead of rebuilding the whole entry via a reload. No-op when the
   * volume has no chunked entry yet (first load still goes through updateVolume).
   */
  async swapChunkedVolumePlan(
    ctx: TCtx,
    vol: NVImage,
    newPlan: ChunkPlan,
    keepUntilCovered = false,
  ): Promise<void> {
    const cacheKey = volumeCacheKey(vol)
    const entry = cacheKey ? this._texCache.get(cacheKey) : undefined
    if (!entry || entry.kind !== 'chunked') return
    if (newPlan.chunks.length > MAX_CHUNKS_PER_TILE) {
      throw new Error(
        `multi-LOD plan tiles into ${newPlan.chunks.length} chunks, ` +
          `exceeding the per-tile limit of ${MAX_CHUNKS_PER_TILE}.`,
      )
    }
    vol.chunkPlan = newPlan
    // A combined mirror streams on the base's grid. Its own plan applies once
    // it streams alone or as the base, which rebuilds the entry for it.
    if (this._combinedOverlayEntries.includes(entry)) return
    // Combined mirrors are indexed by the base's chunks, so they move with it.
    const entries = [
      entry,
      ...(entry === this._activeChunked ? this._combinedOverlayEntries : []),
    ]
    const swaps = entries.map(async (e) => {
      const ev = e === entry ? vol : e.volume
      const done = this._queueEntrySwap(ctx, ev, e, newPlan, keepUntilCovered)
      const pending = { plan: newPlan, done }
      e.pendingSwap = pending
      try {
        await done
      } finally {
        if (e.pendingSwap === pending) e.pendingSwap = undefined
      }
    })
    await Promise.all(swaps)
  }

  protected _queueEntrySwap(
    ctx: TCtx,
    vol: NVImage,
    entry: TEntry,
    newPlan: ChunkPlan,
    keepUntilCovered: boolean,
  ): Promise<void> {
    const run: Promise<void> = (entry.swapTail ?? Promise.resolve()).then(() =>
      entry.swapTail === tail
        ? this._swapChunkedEntryPlan(ctx, vol, entry, newPlan, keepUntilCovered)
        : undefined,
    )
    const tail = run.catch(() => undefined)
    entry.swapTail = tail
    return run
  }

  /**
   * Swap `entry` again while `base.chunkPlan` moved on during the last await,
   * so overlapping swaps leave it on the newest plan, not the last to finish.
   */
  protected async _catchUpToPlan(
    ctx: TCtx,
    vol: NVImage,
    entry: TEntry,
    base: NVImage,
    keepUntilCovered: boolean,
  ): Promise<void> {
    for (let p = base.chunkPlan; p && entry.plan !== p; p = base.chunkPlan) {
      await this._swapChunkedEntryPlan(ctx, vol, entry, p, keepUntilCovered)
    }
  }

  protected async _swapChunkedEntryPlan(
    ctx: TCtx,
    vol: NVImage,
    entry: TEntry,
    newPlan: ChunkPlan,
    keepUntilCovered: boolean,
  ): Promise<void> {
    // The uploader bakes the display state as it is now, so record that key,
    // not the one current after the await: a colormap change landing in
    // between must still find the entry stale.
    const displayKey = chunkedDisplayKey(vol, entry.modulation)
    const oldToNew = matchChunksByContent(entry.plan, newPlan)
    // Resident bricks bake the display state of the uploader that made them.
    // When that state has changed since (a colormap set but not yet
    // refreshed), keeping them would show the old state, so none carry over.
    const carryOver = displayKey === entry.displayKey
    const keepResident = carryOver
      ? chunksToKeepResident(
          oldToNew,
          !this._needsGradient(),
          (ci) => entry.manager.getChunk(ci)?.hasGradient,
          newPlan,
          entry.manager.budgetBytes,
        )
      : new Map<number, number>()
    // Rebind the uploader to the new plan; dispose the old orient resources.
    const made = this._newChunkUploader(
      ctx,
      vol,
      newPlan,
      entry.decoded,
      entry.modulation,
    )
    const newUploader = made instanceof Promise ? await made : made
    entry.uploader.dispose()
    entry.uploader = newUploader
    entry.manager.remap(
      keepResident,
      newPlan.chunks.length,
      keepUntilCovered && carryOver
        ? { oldPlan: entry.plan, newPlan }
        : undefined,
    )
    // Chunk indices are plan-relative, so the tier is re-keyed by the same
    // content match: a brick the new plan still contains keeps its bytes, and
    // a refocus back to this level finds them.
    entry.decoded.remap(oldToNew)
    // A new grid makes the recorded travel meaningless (a refocused octree of
    // the same volume keeps it), and the old uploader took its outstanding
    // speculative reads with it.
    if (entry.volume === vol) entry.predictor.replan(entry.plan, newPlan)
    else entry.predictor.reset()
    entry.plan = newPlan
    entry.requestedThisFrame.length = 0
    entry.speculative.clear()
    entry.cubicSafe = planSupportsCubic(newPlan)
    warnIfCubicUnsafe(
      entry.volume.name,
      entry.cubicSafe,
      this.isCubicInterpolation,
    )
    this._resetChunkBindings(entry)
    entry.volume = vol
    entry.displayKey = displayKey
    entry.sourceKey = volumeSourceKey(vol)
    // Keep at least one chunk resident for the first post-swap frame; the pump
    // streams the rest from the next working set.
    if (entry.manager.residentCount === 0) {
      const chunk0 = await entry.uploader.uploadChunk(0)
      if (!chunk0.hasGradient) this._uploadedUnlit = true
      entry.manager.admit(0, chunk0)
    }
    this._onPlanSwapped(entry)
  }

  /**
   * When the active volume is chunked, expose its plan and per-chunk color
   * textures so the 2D slice renderer can draw one in-plane-restricted quad
   * per chunk. Returns null for single-texture volumes.
   */
  getActiveChunkedSlice(): {
    plan: ChunkPlan
    chunkTextures: (TTex | null)[]
    overlayChunks: TTex[] | null
    paqdChunks: TTex[] | null
  } | null {
    if (!this._activeChunked) return null
    const { manager } = this._activeChunked
    const chunkCount = manager.chunkCount
    // Indexed by chunk index; null for chunks not yet streamed in. The slice
    // loop skips nulls — a transient gap rather than a hole, since the pump
    // fills them within a few frames.
    const chunkTextures: (TTex | null)[] = []
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
  protected _combinedOverlaySliceChunks(chunkCount: number): TTex[] | null {
    const fuse = this._stackFuse
    const empty = this.placeholderOverlay
    const base = this._activeChunked
    if (fuse && empty && base)
      return fuse.textures(chunkRegions(base.plan), this._stackGen(), empty)
    if (this._combinedOverlayEntries.length !== 1 || !this.placeholderOverlay) {
      return null
    }
    const entry = this._combinedOverlayEntries[0]
    if (entry.manager.chunkCount !== chunkCount) return null
    const placeholder = this.placeholderOverlay
    const out: TTex[] = []
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
    chunkTextures: (TTex | null)[]
  } | null {
    const entry = this._activeOverlayChunked
    if (!entry) return null
    const chunkTextures: (TTex | null)[] = []
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

  protected _requestChunksInFrustum(
    entry: TEntry | null,
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
    clipPlanes: number[],
    isCutaway: boolean,
    mirrors: ChunkResidencyManager<TChunk>[] = [],
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
    const visible = chunksInFrustum(
      entry.plan,
      mvp,
      this.clipSpaceZeroToOne,
      matRAS,
    )
    // Drop chunks a clip plane removes entirely from the cutaway, so we never
    // stream blocks the 3D render hides.
    const unclipped = chunksNotClippedOut(
      entry.plan,
      visible,
      clipPlanes,
      isCutaway,
    )
    // Stream the centre of the view first, then spiral outward. Streamed
    // combined overlays share the base grid, so the same indices apply.
    const ordered = orderByViewCenter(entry.plan, unclipped, mvp, matRAS)
    // Cap the working set to what the residency budget can hold. A full-volume
    // render makes every visible chunk needed-this-frame, so eviction can't drop
    // any of them; without a cap the resident set grows to the entire visible
    // set and exhausts GPU memory (context loss). Streaming only the most
    // view-central chunks that fit keeps memory bounded — the coarse floor
    // covers the rest. Unlit chunks carry no full-size gradient texture, so
    // the cap prices them at 4 bytes/voxel instead of 8.
    // Mirrors get the same indices but a fraction of the budget, so the set
    // must fit the tightest of them too. A chunk uploaded lit keeps its 8-byte
    // gradient footprint until it re-streams, so each manager prices its
    // resident chunks by their actual gradient state; non-resident chunks fall
    // back to the current lighting state.
    const capped = chunkIndicesForAllBudgets(
      entry.plan,
      ordered,
      [entry.manager, ...mirrors],
      this._needsGradient(),
      entry.requestedThisFrame,
    )
    for (const ci of capped) {
      entry.manager.requestUpload(ci)
      for (const m of mirrors) m.requestUpload(ci)
    }
    // Accumulate rather than replace: a multiplanar layout drives this volume
    // from several tiles per frame, and the union is what travels and what
    // later tiles are capped against.
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

  protected _requestVisibleChunksInView(
    entry: TEntry | null,
    crossing: readonly number[],
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
    mirrors: ChunkResidencyManager<TChunk>[] = [],
  ): void {
    if (!entry) return
    if (chunkExplodeEnabled(entry.volume.chunkExplode)) {
      for (const ci of crossing) {
        entry.manager.requestUpload(ci)
        for (const m of mirrors) m.requestUpload(ci)
      }
      return
    }
    const inView = new Set(
      chunksInFrustum(entry.plan, mvp, this.clipSpaceZeroToOne, matRAS),
    )
    const visible = crossing.filter((ci) => inView.has(ci))
    // Stream the centre of the view first, then spiral outward, capped to what
    // the residency budget can hold (see _requestChunksInFrustum).
    const ordered = orderByViewCenter(entry.plan, visible, mvp, matRAS)
    // Fits the base and every mirror; see _requestChunksInFrustum.
    const capped = chunkIndicesForAllBudgets(
      entry.plan,
      ordered,
      [entry.manager, ...mirrors],
      this._needsGradient(),
      entry.requestedThisFrame,
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
  protected _speculateAhead(entry: TEntry): void {
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
  protected _needsGradient(): boolean {
    return (
      this.gradientAmount > 0 || this.gradientOpacity > 0 || this.silhouette > 0
    )
  }

  protected _refreshUnlitChunksForLighting(): void {
    if (!this._needsGradient() || !this._uploadedUnlit) return
    this._uploadedUnlit = false
    for (const entry of this._texCache.values()) {
      if (entry.kind !== 'chunked') continue
      entry.manager.remap(new Map(), entry.plan.chunks.length)
      this._resetChunkBindings(entry)
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
      if (await this._fuseStackChunks(start + CHUNK_UPLOAD_BUDGET_MS))
        admitted = true
    } finally {
      this._pumpInFlight = false
    }
    return admitted
  }

  protected _stackEntries(): TEntry[] {
    const base = this._activeChunked
    return base ? [base, ...this._combinedOverlayEntries] : []
  }

  protected _stackGen(): string {
    return stackGeneration(this._stackEntries())
  }

  /**
   * Build (or reuse) the independent chunked entry for a hi-res streamed
   * overlay and mark it active. The entry lives in _texCache under the
   * overlay's own key, so the per-frame pump streams it alongside the base.
   * Drawn as translucent chunk cubes over the base in drawOverlayChunked.
   */
  protected async _updateOverlayChunkedIndependent(
    ctx: TCtx,
    vol: NVImage,
    volumes: NVImage[],
  ): Promise<void> {
    // Split the single configured residency budget: the overlay gets a share,
    // the base keeps the rest, so base + overlay together stay within the
    // configured cap instead of each filling it.
    const overlayBudget = this._chunkResidencyBytes * OVERLAY_RESIDENCY_FRACTION
    // The overlay streams on its own grid, so its modulation matrix is
    // resolved against itself, not the base.
    const entry = await this._ensureChunkedVolumeEntry(
      ctx,
      vol,
      overlayBudget,
      buildModulationParams(vol, vol, volumes),
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

  protected _dimsMatchBase(vol: NVImage, baseVol: NVImage): boolean {
    const a = vol.dimsRAS
    const b = baseVol.dimsRAS
    return !!a && !!b && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
  }

  /**
   * Strategy A: build (or reuse) a base-aligned chunked entry for each streamed
   * combined overlay (a chunkSource overlay co-registered at the base grid).
   * They stream via the per-frame pump and feed the base block's overlay slot,
   * so the base ray-march / clip plane / compositing are reused unchanged. The
   * residency hook invalidates the base chunk's binding when an overlay chunk
   * arrives or is evicted, so the overlay slot tracks residency.
   */
  protected async _updateCombinedOverlayChunked(
    ctx: TCtx,
    vols: NVImage[],
    volumes: NVImage[],
  ): Promise<void> {
    // No fuse while the mirror list is partial (the pump awaits meanwhile).
    this._stackRebuilding = (this._stackRebuilding ?? 0) + 1
    try {
      this._combinedOverlayEntries = []
      if (vols.length === 0) return
      // Mirrors share the base grid and are asked for the base's indices, so
      // the base's view is capped by the smallest mirror: split evenly.
      const overlayBudget = this._chunkResidencyBytes / (vols.length + 1)
      // Mirrors are asked for the base's chunk indices and priced by its plan,
      // so each streams on the base's grid, not one set on the overlay itself.
      const basePlan = volumes[0]?.chunkPlan
      for (const vol of vols) {
        // Co-registered at the base grid, so resolving against the overlay's
        // own grid is the base-grid matrix the whole-volume path would use.
        const entry = await this._ensureChunkedVolumeEntry(
          ctx,
          vol,
          overlayBudget,
          buildModulationParams(vol, vol, volumes),
          (ci) => this._invalidateBaseChunkBinding(ci),
          basePlan,
        )
        // A base swap during the await could not see this mirror yet (it is
        // not listed), so bring it to the base's current plan before listing it.
        if (volumes[0]) {
          await this._catchUpToPlan(ctx, vol, entry, volumes[0], false)
        }
        setChunkBudget(entry, overlayBudget)
        this._combinedOverlayEntries.push(entry)
      }
      if (this._activeChunked) {
        setChunkBudget(this._activeChunked, overlayBudget)
      }
      this._invalidateBindGroupCache()
    } finally {
      this._stackRebuilding--
    }
  }

  protected _clearStackFuse(): void {
    this._stackFuse?.clear()
    this._stackFuse = null
  }

  protected _clearCombinedOverlayChunked(): void {
    this._clearStackFuse()
    if (this._combinedOverlayEntries.length === 0) return
    this._combinedOverlayEntries = []
    if (this._activeChunked) {
      setChunkBudget(this._activeChunked, this._chunkResidencyBytes)
    }
    this._invalidateBindGroupCache()
  }

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
  chunkStreamCounts(): ChunkStreamCounts {
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
    // Stack chunks still owed a fuse count as pending: the frame does not yet
    // show every drawn channel.
    pending += this._stackFusePending()
    return { resident, pending, inFlight, total }
  }

  protected _stackFusePending(): number {
    const fuse = this._stackFuse
    const base = this._activeChunked
    if (!fuse || !base) return 0
    const entries = this._stackEntries()
    return fuse.pending(
      chunkRegions(base.plan),
      stackGeneration(entries),
      stackModes(entries, this.overlayAlphaBlend, this.overlayColorBlend),
      (i) => stackInputs(entries, i),
    )
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
  chunkStreamStats(): ChunkStreamDetail {
    let resident = 0
    let pending = 0
    let inFlight = 0
    let total = 0
    let staleDropped = 0
    let predicted = 0
    let retiring = 0
    let retiringBytes = 0
    const decoded: ByteLruStats = {
      hits: 0,
      misses: 0,
      admitted: 0,
      rejected: 0,
      evicted: 0,
      evictedBytes: 0,
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
      retiring += entry.manager.retiringChunks.length
      retiringBytes += entry.manager.retiringBytes
      const d = entry.decoded.stats
      decoded.hits += d.hits
      decoded.misses += d.misses
      decoded.admitted += d.admitted
      decoded.rejected += d.rejected
      decoded.evicted += d.evicted
      decoded.evictedBytes += d.evictedBytes
      decoded.entries += d.entries
      decoded.bytes += d.bytes
      decoded.maxBytes += d.maxBytes
    }
    return {
      resident,
      pending: pending + this._stackFusePending(),
      inFlight,
      total,
      staleDropped,
      predicted,
      retiring,
      retiringBytes,
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

  // Backend hooks. Each runs at the point the two copies used to differ; a
  // backend with nothing to do there implements it as a no-op.

  /**
   * Build (or reuse from the texture cache) the chunked entry for `vol`. A
   * combined mirror passes `basePlan` (the base's grid) and a residency hook.
   */
  protected abstract _ensureChunkedVolumeEntry(
    ctx: TCtx,
    vol: NVImage,
    budgetBytes: number,
    modulation: ModulationTextureParams | null,
    onResidencyChange?: (chunkIndex: number) => void,
    basePlan?: ChunkPlan,
  ): Promise<TEntry>

  /**
   * A chunk uploader for `plan`, baking the volume's current display state.
   * Returned bare when the backend builds it synchronously: the swap awaits
   * only a promise, so a synchronous backend gains no microtask yield.
   */
  protected abstract _newChunkUploader(
    ctx: TCtx,
    vol: NVImage,
    plan: ChunkPlan,
    decoded: ByteLru<number, Uint8Array>,
    modulation: ModulationTextureParams | null,
  ): TUploader | Promise<TUploader>

  /** Drop any per-chunk binding state after the entry's chunks were re-keyed. */
  protected abstract _resetChunkBindings(entry: TEntry): void

  /** Runs once a plan swap has finished on `entry`. */
  protected abstract _onPlanSwapped(entry: TEntry): void

  /** Overlay inputs changed: drop any cached bindings that hold them. */
  protected abstract _invalidateBindGroupCache(): void

  /** A combined-overlay chunk arrived or left base chunk `chunkIndex`. */
  protected abstract _invalidateBaseChunkBinding(chunkIndex: number): void

  /** Build any non-chunked gradient texture the upload path deferred. */
  protected abstract _ensureSingleGradients(): void

  /**
   * Re-fuse the channel stack's chunks until `deadline`; whether any changed.
   */
  protected abstract _fuseStackChunks(deadline: number): Promise<boolean>
}
