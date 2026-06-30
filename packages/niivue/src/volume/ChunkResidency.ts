/**
 * Backend-agnostic GPU chunk residency bookkeeping for tiled volumes.
 *
 * Tracks which of a chunked volume's chunks are currently GPU-resident, their
 * collective byte footprint against a budget, an LRU recency stamp per chunk,
 * and a queue of chunks requested but not yet uploaded. The manager never
 * touches the GPU itself: the owning backend renderer builds the chunk handles
 * and supplies `bytesOf` / `destroy` hooks. Keeping the LRU and budget policy
 * here makes it identical across the WebGPU and WebGL2 backends.
 *
 * Phase 3c wired visibility-driven upload: the view requests a per-frame
 * working set and the backend streams those chunks in. Phase 3d adds eviction
 * under budget pressure — `admit` drops the least-recently-needed chunks once
 * the resident set would exceed `budgetBytes`. Recency is driven by the
 * working set: `requestUpload` stamps a resident chunk as needed-this-frame,
 * and eviction never drops a chunk touched since the last `beginFrame`.
 *
 * Frame ordering contract: call `beginFrame()` once at the start of each
 * frame, *before* requesting the working set, so working-set chunks carry the
 * current frame stamp and a same-frame `admit` cannot evict them.
 */

export interface ChunkResidencyHooks<TChunk> {
  /** Steady-state GPU bytes one resident chunk occupies. */
  bytesOf(chunk: TChunk): number
  /** Release a chunk's GPU resources. Called on eviction and on destroy. */
  destroy(chunk: TChunk): void
  /**
   * Called with a chunk index just before it is evicted, so the backend can
   * drop any per-chunk caches keyed by index (e.g. cached bind groups) that
   * would otherwise dangle once the chunk's GPU resources are released.
   */
  onEvict?(chunkIndex: number): void
  /**
   * Called once when a chunk is first enqueued for upload (not when it is
   * already resident, in-flight, or queued), so the backend can begin fetching
   * its source bytes in parallel ahead of the serial upload pump. Optional and
   * best-effort — the upload path must still work if it is a no-op.
   */
  prefetch?(chunkIndex: number): void
  /**
   * Called with a chunk index just after it becomes resident (admitted). Lets
   * the backend invalidate caches that sample this chunk — e.g. a streamed
   * overlay chunk feeding another volume's per-chunk bind group.
   */
  onAdmit?(chunkIndex: number): void
}

interface ResidentChunk<TChunk> {
  chunk: TChunk
  /** Frame counter value at last access — the LRU recency stamp. */
  lastFrame: number
  /** Cached `bytesOf(chunk)` so eviction accounting needs no recompute. */
  bytes: number
  /**
   * Wall-clock (`performance.now()`) at admit, so the renderer can cross-fade a
   * freshly streamed chunk in over the coarse floor instead of popping it in.
   * Reset on re-admit (a re-streamed chunk fades again).
   */
  admittedAt: number
}

export class ChunkResidencyManager<TChunk> {
  /** Total chunks in the volume's plan, resident or not. */
  private _chunkCount: number
  private readonly _hooks: ChunkResidencyHooks<TChunk>
  private readonly _resident: Map<number, ResidentChunk<TChunk>> = new Map()
  private readonly _uploadQueue: number[] = []
  private readonly _inFlightUploads = new Set<number>()
  private _residentBytes = 0
  private _budgetBytes: number
  private _frame = 0
  private _generation = 0

  constructor(
    chunkCount: number,
    budgetBytes: number,
    hooks: ChunkResidencyHooks<TChunk>,
  ) {
    this._chunkCount = chunkCount
    this._budgetBytes = budgetBytes
    this._hooks = hooks
  }

  /** Total chunks in the volume's plan, resident or not. */
  get chunkCount(): number {
    return this._chunkCount
  }

  /**
   * Adopt a new plan in place. `oldToNew` maps an old chunk index to the new
   * index of the content-identical chunk (see `matchChunksByContent`): those
   * resident chunks are re-keyed, keeping their GPU handle, byte total, and
   * fade-in stamp (so unchanged bricks don't re-stream or re-fade). Resident
   * chunks absent from the map are evicted (destroyed). The pending-upload
   * queue is cleared — the next frame's working set re-requests what it needs.
   */
  remap(oldToNew: ReadonlyMap<number, number>, newChunkCount: number): void {
    const next = new Map<number, ResidentChunk<TChunk>>()
    for (const [oldIndex, r] of this._resident) {
      const newIndex = oldToNew.get(oldIndex)
      if (newIndex === undefined || next.has(newIndex)) {
        this._hooks.destroy(r.chunk)
        this._residentBytes -= r.bytes
      } else {
        next.set(newIndex, r)
      }
    }
    this._resident.clear()
    for (const [k, v] of next) this._resident.set(k, v)
    this._uploadQueue.length = 0
    this._inFlightUploads.clear()
    this._chunkCount = newChunkCount
    // Invalidate any in-flight upload captured against the old plan: a result
    // returned after this point would `admit` at a re-keyed (or out-of-range)
    // index. The pump captures `generation` before its await and discards a
    // result whose generation no longer matches (see `discardUpload`).
    this._generation++
  }

  /**
   * Monotonic plan-generation counter, bumped on every `remap`. A backend upload
   * pump captures this before an async `uploadChunk` and, on completion, must
   * discard the result (via `discardUpload`) rather than `admit` it if the value
   * has changed — otherwise a stale brick lands at a re-keyed index.
   */
  get generation(): number {
    return this._generation
  }

  /** Advance the LRU clock. Call once per frame before consuming chunks. */
  beginFrame(): void {
    this._frame++
  }

  /** Current LRU frame counter. */
  get frame(): number {
    return this._frame
  }

  /**
   * Register an already-uploaded chunk as resident. Replacing an existing
   * resident chunk destroys the old handle and adjusts the byte total. Once
   * the chunk is in, evicts the least-recently-needed resident chunks if the
   * resident set now exceeds `budgetBytes` (see `_evictToFit`).
   */
  admit(chunkIndex: number, chunk: TChunk): void {
    // Defend the keyspace against a stale upload (a result captured against an
    // older plan whose index is now out of range). Destroy it rather than
    // corrupt `_resident` / `_residentBytes`. In-plan stale results are caught
    // earlier by the pump's generation check (`discardUpload`).
    if (chunkIndex < 0 || chunkIndex >= this._chunkCount) {
      this._hooks.destroy(chunk)
      this._inFlightUploads.delete(chunkIndex)
      return
    }
    const prev = this._resident.get(chunkIndex)
    if (prev) {
      this._hooks.destroy(prev.chunk)
      this._residentBytes -= prev.bytes
    }
    const bytes = this._hooks.bytesOf(chunk)
    this._resident.set(chunkIndex, {
      chunk,
      lastFrame: this._frame,
      bytes,
      admittedAt: performance.now(),
    })
    this._residentBytes += bytes
    this._inFlightUploads.delete(chunkIndex)
    this._removeQueuedUpload(chunkIndex)
    this._evictToFit(chunkIndex)
    this._hooks.onAdmit?.(chunkIndex)
  }

  /** The resident chunk for an index, or null. Pure lookup — does not affect
   * eviction recency; recency is driven by `requestUpload` (the working set). */
  getChunk(chunkIndex: number): TChunk | null {
    return this._resident.get(chunkIndex)?.chunk ?? null
  }

  /** Whether a chunk index is currently GPU-resident. */
  isResident(chunkIndex: number): boolean {
    return this._resident.has(chunkIndex)
  }

  /**
   * Fade-in fraction in [0,1] for a resident chunk: how far through a
   * `durationMs` cross-fade the chunk is, given the current wall-clock `now`
   * (`performance.now()`). Returns 1 for chunks admitted longer ago than the
   * duration, for a non-positive duration, or for a non-resident index — i.e.
   * "draw fully" is the safe default. The renderer multiplies a streaming
   * chunk's premultiplied color by this so fine detail dissolves in over the
   * coarse floor instead of popping.
   */
  fadeFraction(chunkIndex: number, now: number, durationMs: number): number {
    const r = this._resident.get(chunkIndex)
    if (!r || durationMs <= 0) return 1
    const t = (now - r.admittedAt) / durationMs
    return t >= 1 ? 1 : t <= 0 ? 0 : t
  }

  /** Count of currently-resident chunks. */
  get residentCount(): number {
    return this._resident.size
  }

  /** True once every chunk in the plan is resident. */
  get isFullyResident(): boolean {
    return this._resident.size === this.chunkCount
  }

  /** Summed GPU bytes of all resident chunks. */
  get residentBytes(): number {
    return this._residentBytes
  }

  /** GPU byte budget the resident set is expected to stay within. */
  get budgetBytes(): number {
    return this._budgetBytes
  }

  /**
   * Adjust the GPU byte budget (e.g. to split a single configured budget across
   * a base volume and an independent overlay). Shrinking evicts the
   * least-recently-needed resident chunks to fit, subject to the same
   * current-frame protection as admit-time eviction.
   */
  setBudgetBytes(bytes: number): void {
    this._budgetBytes = Math.max(0, bytes)
    this._evictToFit(-1)
  }

  /**
   * Mark a chunk as needed this frame. A resident chunk is stamped with the
   * current frame so eviction will not drop it; a non-resident, not-yet-queued
   * chunk is enqueued for upload. Already-queued chunks are left as-is. This is
   * the single entry point the per-frame working set drives — it both keeps
   * visible resident chunks fresh and streams in the visible missing ones.
   * Drained by the backend via `takePendingUploads`.
   */
  requestUpload(chunkIndex: number): void {
    const resident = this._resident.get(chunkIndex)
    if (resident) {
      resident.lastFrame = this._frame
      return
    }
    if (this._inFlightUploads.has(chunkIndex)) return
    if (this._uploadQueue.includes(chunkIndex)) return
    this._uploadQueue.push(chunkIndex)
    // Newly queued — start its source fetch in parallel ahead of the pump.
    this._hooks.prefetch?.(chunkIndex)
  }

  /** Number of chunks queued for upload but not yet resident. */
  get pendingUploadCount(): number {
    return this._uploadQueue.length
  }

  /** Number of chunks removed from the queue and currently being uploaded. */
  get inFlightUploadCount(): number {
    return this._inFlightUploads.size
  }

  /**
   * Return (without removing) up to `max` queued chunk indices, oldest first —
   * the chunks the next `takePendingUploads` calls will drain. Lets the backend
   * prefetch the upcoming working set ahead of the serial upload pump.
   */
  peekPendingUploads(max: number): number[] {
    const out: number[] = []
    const limit = Math.max(0, max)
    for (const ci of this._uploadQueue) {
      if (out.length >= limit) break
      if (this._resident.has(ci)) continue
      if (this._inFlightUploads.has(ci)) continue
      out.push(ci)
    }
    return out
  }

  /**
   * Remove and return up to `max` queued chunk indices, oldest first, for the
   * backend to upload this frame. Returned indices are marked in-flight until
   * the backend either `admit`s them or calls `failUpload`.
   */
  takePendingUploads(max: number): number[] {
    const out: number[] = []
    const limit = Math.max(0, max)
    while (out.length < limit && this._uploadQueue.length > 0) {
      const chunkIndex = this._uploadQueue.shift()
      if (chunkIndex === undefined) break
      if (this._resident.has(chunkIndex)) continue
      if (this._inFlightUploads.has(chunkIndex)) continue
      this._inFlightUploads.add(chunkIndex)
      out.push(chunkIndex)
    }
    return out
  }

  /**
   * Clear an in-flight upload after the backend fails to upload the chunk.
   * A later working-set request may enqueue the chunk again.
   */
  failUpload(chunkIndex: number): void {
    this._inFlightUploads.delete(chunkIndex)
  }

  /**
   * Drop an upload result that completed after a `remap` changed the plan
   * (generation mismatch): destroy its GPU handle and clear the in-flight mark.
   * The next frame's working set re-requests whatever the new plan needs.
   */
  discardUpload(chunkIndex: number, chunk: TChunk): void {
    this._hooks.destroy(chunk)
    this._inFlightUploads.delete(chunkIndex)
  }

  /**
   * Evict least-recently-needed resident chunks until the resident set fits
   * within `budgetBytes`. A chunk is a candidate only if it is not `keepIndex`
   * (the chunk just admitted) and was not touched this frame (`lastFrame` is
   * older than the current frame) — so a chunk in this frame's working set is
   * never evicted. Candidates are evicted oldest-first. If no candidate
   * remains the resident set stays over budget: the visible working set itself
   * exceeds the budget, and rendering over budget beats punching a hole.
   */
  private _evictToFit(keepIndex: number): void {
    if (this._residentBytes <= this._budgetBytes) return
    const candidates = [...this._resident.entries()]
      .filter(
        ([index, r]) => index !== keepIndex && r.lastFrame !== this._frame,
      )
      .sort((a, b) => a[1].lastFrame - b[1].lastFrame)
    for (const [index, r] of candidates) {
      if (this._residentBytes <= this._budgetBytes) break
      this._hooks.onEvict?.(index)
      this._hooks.destroy(r.chunk)
      this._resident.delete(index)
      this._residentBytes -= r.bytes
    }
  }

  /** Destroy every resident chunk's GPU resources and reset all state. */
  destroy(): void {
    for (const r of this._resident.values()) this._hooks.destroy(r.chunk)
    this._resident.clear()
    this._residentBytes = 0
    this._uploadQueue.length = 0
    this._inFlightUploads.clear()
  }

  private _removeQueuedUpload(chunkIndex: number): void {
    for (let i = this._uploadQueue.length - 1; i >= 0; i--) {
      if (this._uploadQueue[i] === chunkIndex) this._uploadQueue.splice(i, 1)
    }
  }
}
