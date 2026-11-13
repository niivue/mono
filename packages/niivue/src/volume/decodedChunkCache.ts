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
 * RGBA8 color texture (4 bytes per voxel) plus, when lit, an RGBA8 gradient (8).
 * Shadowing the whole resident set therefore costs at most a quarter to the
 * whole of the GPU budget in JS heap, before the cap; see `decodedTierBudgetBytes`, which sizes the tier at the shadow
 * plus a tail, so the tier holds every resident chunk AND the most recently
 * evicted ones. The tail is the part that actually pays: it is what a scrub
 * finds when it turns around. That holds only below the cap: past a 256 MiB
 * shadow the tail shrinks, and past 384 MiB (float32 above a ~403 MB GPU
 * budget, int16 above ~805 MB) the tier holds only the most recently used part
 * of the resident set, so a chunk evicted outside it is read from the source.
 *
 * Eviction is plain LRU, which is what that structure wants. The newest
 * entries are the chunks still on the GPU (whose copies cost nothing to lose)
 * and the oldest are the chunks evicted longest ago (which a reversal reaches
 * last), so dropping from the old end keeps precisely the frontier the view is
 * about to cross back over.
 *
 * The tier is a `ByteLru<number, Uint8Array>` keyed by chunk index in the
 * current plan, one per chunked volume (`remap` follows a plan swap).
 */

/**
 * GPU bytes one voxel of a resident chunk occupies when unlit: an RGBA8 color
 * texel and no gradient (`residentBytesForChunkDesc`). A lit chunk costs 8, so
 * the same budget holds half the voxels; pricing at 4 sizes the tier for the
 * larger (unlit, default) resident set. The tier is sized once per entry, so it
 * cannot follow a lighting toggle; erring large keeps it effective either way.
 */
const GPU_BYTES_PER_VOXEL = 4

/**
 * How much tier is bought beyond the shadow of the resident set, as a fraction
 * of that shadow. This is the entire point of the tier -- the shadow alone
 * only breaks even -- so it buys real depth. Before the cap that is up to
 * 1.5x the GPU budget for float32 (3x for complex64), so the JS-heap ceiling
 * below is what keeps it in check.
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
 * a quarter of what a float32 volume costs.
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
