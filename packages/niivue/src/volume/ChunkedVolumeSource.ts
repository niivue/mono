import type { Vec3f, Vec3i } from './chunking'

/** One pyramid level of a {@link ChunkedVolumeSource}. */
export interface ChunkedVolumeLevel {
  /** Pyramid level number (0 = finest). Informational (labels/telemetry). */
  level: number
  /** Level dims in voxels `[x, y, z]`. */
  shape: Vec3i
  /** Voxel spacing in mm `[x, y, z]`. */
  spacing: Vec3f
}

/** Arguments to {@link ChunkedVolumeSource.fetchChunk}. */
export interface ChunkedVolumeFetch {
  /** Index into {@link ChunkedVolumeSource.levels} (0 = finest). */
  levelIndex: number
  /** First voxel of the region, in THIS level's own voxel grid. */
  texOrigin: Vec3i
  /** Region size in voxels `[x, y, z]` (equals the returned brick size). */
  texDims: Vec3i
  /** Bytes per voxel for {@link ChunkedVolumeSource.datatypeCode}. */
  bytesPerVoxel: number
}

/**
 * Pluggable, format-agnostic source for a multi-resolution (pyramid) volume.
 *
 * Modeled on the slide `SlideTileSource` seam: the source only READS raw voxel
 * bytes for a region of one level; the aggregator ({@link NVChunkedVolume})
 * owns plan-building, per-level dispatch, concurrency, retry, dedup, and GPU
 * residency. Implement it over OME-Zarr (zarrita), an HTTP range shard, a tile
 * server, etc. — the fetch/format never enters niivue core.
 */
export interface ChunkedVolumeSource {
  /**
   * Pyramid levels, FINEST-FIRST. `levels[0]` is the common reference grid: its
   * `shape` becomes the volume's world dims and every brick's world placement
   * is expressed on it; coarser levels follow at increasing index.
   */
  readonly levels: ChunkedVolumeLevel[]
  /** NIfTI datatype code shared by every level (see `NiiDataType`). */
  readonly datatypeCode: number
  /**
   * Read a voxel region of ONE level. `texOrigin`/`texDims` are in that level's
   * OWN voxel grid (see the multi-LOD coordinate split in `chunking.ts`). MUST
   * resolve to EXACTLY `texDims[0] * texDims[1] * texDims[2] * bytesPerVoxel`
   * bytes, laid out z-major then y then x, zero-padded where the region runs
   * past the level's array bounds.
   */
  fetchChunk(req: ChunkedVolumeFetch): Promise<Uint8Array>
}
