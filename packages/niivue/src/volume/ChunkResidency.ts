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
 * Phase 3a: the backend uploads every chunk up front and `admit`s them all, so
 * the resident set is always complete and no eviction or streaming happens.
 * The upload queue, frame counter, and budget accounting are populated but
 * exert no pressure — Phase 3c wires visibility-driven upload and Phase 3d
 * wires eviction under budget pressure.
 */

export interface ChunkResidencyHooks<TChunk> {
  /** Steady-state GPU bytes one resident chunk occupies. */
  bytesOf(chunk: TChunk): number
  /** Release a chunk's GPU resources. Called on eviction and on destroy. */
  destroy(chunk: TChunk): void
}

interface ResidentChunk<TChunk> {
  chunk: TChunk
  /** Frame counter value at last access — the LRU recency stamp. */
  lastFrame: number
  /** Cached `bytesOf(chunk)` so eviction accounting needs no recompute. */
  bytes: number
}

export class ChunkResidencyManager<TChunk> {
  /** Total chunks in the volume's plan, resident or not. */
  readonly chunkCount: number
  private readonly _hooks: ChunkResidencyHooks<TChunk>
  private readonly _resident: Map<number, ResidentChunk<TChunk>> = new Map()
  private readonly _uploadQueue: number[] = []
  private _residentBytes = 0
  private _budgetBytes: number
  private _frame = 0

  constructor(
    chunkCount: number,
    budgetBytes: number,
    hooks: ChunkResidencyHooks<TChunk>,
  ) {
    this.chunkCount = chunkCount
    this._budgetBytes = budgetBytes
    this._hooks = hooks
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
   * resident chunk destroys the old handle and adjusts the byte total.
   */
  admit(chunkIndex: number, chunk: TChunk): void {
    const prev = this._resident.get(chunkIndex)
    if (prev) {
      this._hooks.destroy(prev.chunk)
      this._residentBytes -= prev.bytes
    }
    const bytes = this._hooks.bytesOf(chunk)
    this._resident.set(chunkIndex, { chunk, lastFrame: this._frame, bytes })
    this._residentBytes += bytes
    const q = this._uploadQueue.indexOf(chunkIndex)
    if (q >= 0) this._uploadQueue.splice(q, 1)
  }

  /** The resident chunk for an index, stamping it as used this frame. */
  getChunk(chunkIndex: number): TChunk | null {
    const r = this._resident.get(chunkIndex)
    if (!r) return null
    r.lastFrame = this._frame
    return r.chunk
  }

  /** Whether a chunk index is currently GPU-resident. */
  isResident(chunkIndex: number): boolean {
    return this._resident.has(chunkIndex)
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
   * Enqueue a chunk for upload. No-op if the chunk is already resident or
   * already queued. Drained by the backend via `takePendingUploads`.
   */
  requestUpload(chunkIndex: number): void {
    if (this._resident.has(chunkIndex)) return
    if (this._uploadQueue.includes(chunkIndex)) return
    this._uploadQueue.push(chunkIndex)
  }

  /** Number of chunks queued for upload but not yet resident. */
  get pendingUploadCount(): number {
    return this._uploadQueue.length
  }

  /**
   * Remove and return up to `max` queued chunk indices, oldest first, for the
   * backend to upload this frame. The backend `admit`s each once uploaded.
   */
  takePendingUploads(max: number): number[] {
    return this._uploadQueue.splice(0, Math.max(0, max))
  }

  /** Destroy every resident chunk's GPU resources and reset all state. */
  destroy(): void {
    for (const r of this._resident.values()) this._hooks.destroy(r.chunk)
    this._resident.clear()
    this._residentBytes = 0
    this._uploadQueue.length = 0
  }
}
