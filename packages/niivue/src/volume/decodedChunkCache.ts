/**
 * Decoded-chunk tier: the CPU-side buffer that makes GPU eviction cheap.
 *
 * A chunked volume's GPU residency is a fixed byte budget, so a moving view
 * evicts bricks constantly. Without this tier an evicted brick costs a full
 * fetch + decode + assemble + upload to bring back, even though nothing about
 * it changed -- so scrubbing back over ground you just covered is as expensive
 * as seeing it for the first time.
 *
 * This holds the DECODED source bytes for a chunk: exactly what the uploader's
 * `fetchBytes` returns, before the orient pass. A hit turns a chunk's return
 * into a texture upload alone, skipping the network, the codec, and the
 * multi-chunk assemble.
 *
 * WHY IT SHADOWS RESIDENT CHUNKS. The obvious design -- hold only chunks that
 * have been evicted -- cannot work. To have an evicted chunk's bytes you must
 * still be holding them at the moment it is evicted, which means holding them
 * throughout its GPU residency. A tier that drops a chunk's bytes on upload
 * has nothing left to demote later; one that keeps them until eviction IS a
 * shadow of the resident set. So the tier shadows, and the shadow is bounded
 * by a byte budget rather than wished away.
 *
 * That shadow is affordable because a chunk is much narrower on the CPU than
 * on the GPU: source voxels are 1-4 bytes, while a resident chunk carries an
 * RGBA8 color texture plus an RGBA8 gradient, 8 bytes per voxel. Shadowing the
 * whole resident set therefore costs an eighth to a half of the GPU budget in
 * JS heap; see `decodedTierBudgetBytes`, which sizes the tier at the shadow
 * plus a tail, so the tier holds every resident chunk AND the most recently
 * evicted ones. The tail is the part that actually pays: it is what a scrub
 * finds when it turns around.
 *
 * Eviction is plain LRU, which is what that structure wants. The newest
 * entries are the chunks still on the GPU (whose copies cost nothing to lose)
 * and the oldest are the chunks evicted longest ago (which a reversal reaches
 * last), so dropping from the old end keeps precisely the frontier the view is
 * about to cross back over.
 */

/** What a {@link DecodedChunkCache} has done since it was created. */
export interface DecodedChunkStats {
  /** Source reads served from the tier, skipping fetch and decode entirely. */
  hits: number
  /** Source reads that were not, each of which became a real read. */
  misses: number
  /** Buffers admitted. */
  admitted: number
  /** Buffers refused because one alone exceeds the whole budget. */
  rejected: number
  /** Entries dropped to stay inside the budget. */
  evicted: number
  /** Entries held now. */
  entries: number
  /** Bytes held now. */
  bytes: number
  /** The budget those bytes are measured against. */
  maxBytes: number
}

/**
 * GPU bytes one voxel of a resident chunk occupies: an RGBA8 color texel plus
 * an RGBA8 gradient texel. Matches each backend's `bytesOf` residency hook
 * (`residentBytesForChunkDesc`), so the two budgets are measured in the same
 * currency.
 */
const GPU_BYTES_PER_VOXEL = 8

/**
 * How much tier is bought beyond the shadow of the resident set, as a fraction
 * of that shadow. This is the entire point of the tier -- the shadow alone
 * only breaks even -- so it buys real depth, while staying small enough that
 * the tier cannot approach the GPU budget in JS heap.
 */
const DECODED_TIER_TAIL = 0.5

/**
 * Ceiling on the tier, regardless of how large the GPU budget is. Browsers are
 * far less forgiving about JS heap than about GPU memory, and a WebGPU budget
 * measured in gigabytes would otherwise imply a shadow measured in gigabytes.
 */
const DECODED_TIER_MAX_BYTES = 384 * 1024 * 1024

/**
 * Byte budget for the decoded tier backing a chunked volume, given the GPU
 * residency budget it shadows and the source datatype's bytes per voxel.
 *
 * A tier smaller than the shadow of the resident set holds no evicted chunk at
 * all (see the module note), so this is deliberately not a flat fraction of
 * the GPU budget: it tracks the datatype, because a uint8 volume shadows for
 * an eighth of what a float32 volume costs.
 */
export function decodedTierBudgetBytes(
  gpuBudgetBytes: number,
  sourceBytesPerVoxel: number,
  maxBytes: number = DECODED_TIER_MAX_BYTES,
): number {
  if (!(gpuBudgetBytes > 0) || !(sourceBytesPerVoxel > 0)) return 0
  const shadow = (gpuBudgetBytes * sourceBytesPerVoxel) / GPU_BYTES_PER_VOXEL
  return Math.min(maxBytes, Math.round(shadow * (1 + DECODED_TIER_TAIL)))
}

/**
 * A byte-bounded LRU of decoded chunk buffers, keyed by chunk index within one
 * plan. One per chunked volume; see the module note for what it holds and why.
 *
 * `bytes <= maxBytes` holds after every operation: a buffer larger than the
 * whole budget is never admitted, and no resident entry is evicted for it. A
 * budget of 0 makes the tier inert.
 */
export class DecodedChunkCache {
  private entries = new Map<number, Uint8Array>()
  private total = 0
  private max: number
  private hits = 0
  private misses = 0
  private admitted = 0
  private rejected = 0
  private evicted = 0

  constructor(maxBytes: number) {
    // Rejects NaN and negatives in one comparison; 0 and Infinity are valid.
    if (!(maxBytes >= 0)) {
      throw new Error(
        `DecodedChunkCache: maxBytes must be a non-negative number, got ${maxBytes}`,
      )
    }
    this.max = maxBytes
  }

  /** Bytes currently held. */
  get totalBytes(): number {
    return this.total
  }

  /** The budget those bytes are measured against. */
  get maxBytes(): number {
    return this.max
  }

  /** A snapshot of {@link DecodedChunkStats}. Cheap; take it every frame. */
  get stats(): DecodedChunkStats {
    return {
      hits: this.hits,
      misses: this.misses,
      admitted: this.admitted,
      rejected: this.rejected,
      evicted: this.evicted,
      entries: this.entries.size,
      bytes: this.total,
      maxBytes: this.max,
    }
  }

  /**
   * Re-budget the tier, evicting down to the new size if it shrank. Called
   * when a volume's share of the GPU residency budget changes (an independent
   * hi-res overlay arriving or leaving), so the shadow tracks what it shadows.
   */
  setMaxBytes(maxBytes: number): void {
    if (!(maxBytes >= 0)) return
    this.max = maxBytes
    this.evictToFit()
  }

  /**
   * The decoded bytes for `index`, or undefined. Counts the lookup, so this is
   * the one call the hit rate is measured from -- ask it once per source read.
   */
  get(index: number): Uint8Array | undefined {
    const bytes = this.entries.get(index)
    if (!bytes) {
      this.misses++
      return undefined
    }
    this.hits++
    // Re-insert so iteration order stays least-recently-used first.
    this.entries.delete(index)
    this.entries.set(index, bytes)
    return bytes
  }

  /** Whether `index` is held, without counting a lookup or restamping it. */
  has(index: number): boolean {
    return this.entries.has(index)
  }

  /**
   * Hold the decoded bytes for `index`. The buffer must not be mutated
   * afterwards: it is handed back verbatim to later readers.
   */
  set(index: number, bytes: Uint8Array): void {
    const existing = this.entries.get(index)
    if (existing) {
      this.total -= existing.byteLength
      this.entries.delete(index)
    }
    if (bytes.byteLength > this.max) {
      // One brick larger than the whole tier: holding it would evict
      // everything and still not fit. Leave it uncached.
      this.rejected++
      this.evictToFit()
      return
    }
    this.entries.set(index, bytes)
    this.total += bytes.byteLength
    this.admitted++
    this.evictToFit()
  }

  /** Drop `index`, if held. */
  delete(index: number): void {
    const bytes = this.entries.get(index)
    if (!bytes) return
    this.entries.delete(index)
    this.total -= bytes.byteLength
  }

  /**
   * Re-key the tier through a plan swap (multi-LOD refocus), keeping the
   * entries whose chunk survives into the new plan and dropping the rest.
   * `oldToNew` is the same content match the residency manager remaps GPU
   * chunks with, so the two tiers stay in step. Recency order is preserved.
   */
  remap(oldToNew: ReadonlyMap<number, number>): void {
    const next = new Map<number, Uint8Array>()
    let bytes = 0
    for (const [index, buffer] of this.entries) {
      const mapped = oldToNew.get(index)
      if (mapped === undefined) continue
      next.set(mapped, buffer)
      bytes += buffer.byteLength
    }
    this.entries = next
    this.total = bytes
  }

  /** Drop every entry, keeping the counters. */
  clear(): void {
    this.entries.clear()
    this.total = 0
  }

  private evictToFit(): void {
    if (this.total <= this.max) return
    for (const [index, bytes] of this.entries) {
      if (this.total <= this.max) break
      this.entries.delete(index)
      this.total -= bytes.byteLength
      this.evicted++
    }
  }
}
