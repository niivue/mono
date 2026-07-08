/**
 * Memory budget estimation for chunked volume uploads.
 *
 * A chunked volume's GPU footprint is the sum across all chunks of:
 *   - the per-chunk scalar texture (sized texDims, format-dependent bpv)
 *   - the per-chunk RGBA output texture (sized texDims, 4 bytes/voxel)
 *   - the per-chunk gradient texture (sized texDims, 4 bytes/voxel, rgba8unorm)
 *
 * Each chunk's texDims includes the 1-voxel halo per interior face, so the
 * total footprint is larger than the raw volume size — roughly
 * `(1 + 2*halo/stride)^3 × baseline` for a chunked volume.
 *
 * `estimateChunkedBytes` is a pure number-cruncher: it does not allocate
 * anything. The renderer calls it before uploading to decide whether to
 * proceed or fail fast with a clear error.
 */

import type { ChunkPlan, VolumeChunkDesc } from './chunking'

export interface ChunkBudget {
  /** Bytes for the scalar (source-format) textures, across all chunks. */
  scalarBytes: number
  /** Bytes for the RGBA output textures, across all chunks. */
  rgbaBytes: number
  /** Bytes for the gradient textures, across all chunks. */
  gradientBytes: number
  /** Total bytes. */
  totalBytes: number
  /** Number of chunks. */
  chunkCount: number
}

/**
 * Bytes per voxel for the source scalar texture, by NIfTI datatype code.
 * Returns 0 for unsupported types; the caller should treat that as "skip".
 */
export function bytesPerSourceVoxel(datatypeCode: number): number {
  switch (datatypeCode) {
    case 2:
      return 1 // UINT8
    case 4:
      return 2 // INT16
    case 8:
      return 4 // INT32
    case 16:
      return 4 // FLOAT32
    case 32:
      return 8 // COMPLEX64 (2 × float32)
    case 128:
      return 3 // RGB24 (uploaded as rgba8 → 4 bytes; caller adjusts)
    case 512:
      return 2 // UINT16
    case 768:
      return 4 // UINT32
    case 2304:
      return 4 // RGBA32
    default:
      return 0
  }
}

export function estimateChunkedBytes(
  plan: ChunkPlan,
  sourceBytesPerVoxel: number,
): ChunkBudget {
  let scalarBytes = 0
  let rgbaBytes = 0
  let gradientBytes = 0
  for (const c of plan.chunks) {
    const voxels = c.texDims[0] * c.texDims[1] * c.texDims[2]
    scalarBytes += voxels * sourceBytesPerVoxel
    rgbaBytes += voxels * 4
    gradientBytes += voxels * 4
  }
  return {
    scalarBytes,
    rgbaBytes,
    gradientBytes,
    totalBytes: scalarBytes + rgbaBytes + gradientBytes,
    chunkCount: plan.chunks.length,
  }
}

/** Persistent GPU bytes for one resident chunk after the orient pass. */
export function residentBytesForChunkDesc(chunk: VolumeChunkDesc): number {
  const [tx, ty, tz] = chunk.texDims
  return tx * ty * tz * 8
}

/**
 * Select the chunks from `orderedChunkIndices` (view-central first) whose
 * persistent resident bytes fit `budgetBytes`.
 *
 * Costs come from each chunk's ACTUAL texture size, not the plan average. The
 * average hides variance: with uneven edge bricks or multi-LOD bricks the
 * view-central head of the order can each be larger than average, so an
 * average-based cap can hand the residency manager a working set that exceeds
 * the budget — and its same-frame guard refuses to evict chunks the current
 * frame touched. `residentBytesForChunkDesc` matches each backend's `bytesOf`
 * hook exactly, so this cap and the manager's eviction accounting agree.
 *
 * This is a BEST-FIT scan, not a strict prefix: a chunk that does not fit is
 * skipped and a later, smaller one may still be admitted. Because the input is
 * ordered centre-outward, the budget only runs low near the tail, so the skipped
 * chunks are always among the farthest considered — the centre is never traded
 * away for the periphery. The trade-off is that a chunk sitting right at the
 * budget edge can flip in and out as the view moves; eviction is LRU with a
 * same-frame guard, so that churn is bounded.
 *
 * Always returns the first valid chunk even under a tiny budget, so streaming
 * can make progress rather than stalling on an unaffordable brick.
 */
export function chunkIndicesForResidentBudget(
  plan: ChunkPlan,
  orderedChunkIndices: readonly number[],
  budgetBytes: number,
): number[] {
  const selected: number[] = []
  const budget = Math.max(0, budgetBytes)
  let bytes = 0
  for (const chunkIndex of orderedChunkIndices) {
    const chunk = plan.chunks[chunkIndex]
    if (!chunk) continue
    const nextBytes = residentBytesForChunkDesc(chunk)
    if (selected.length > 0 && bytes + nextBytes > budget) continue
    selected.push(chunkIndex)
    bytes += nextBytes
    if (bytes >= budget) break
  }
  return selected
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}
