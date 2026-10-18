// Which meshes a GPU rebuild must re-upload. Shared by both backends so a
// volume or display-only update reuses every mesh's vertex and index buffers,
// and adding, removing or editing one mesh uploads or frees only that mesh.

import type { NVMesh } from '@/NVTypes'

/**
 * How a rebuild treats mesh GPU resources:
 * - `'all'`: free and re-upload every mesh (a full rebuild).
 * - `'changed'`: upload meshes that are new or whose vertex data changed (see
 *   {@link isMeshUploadCurrent}), free meshes no longer in the model, keep
 *   the rest.
 * - `'none'`: leave mesh resources alone.
 */
export type MeshRebuild = 'all' | 'changed' | 'none'

const RANK: Record<MeshRebuild, number> = { none: 0, changed: 1, all: 2 }

/** The rebuild that covers both `a` and `b` (for coalesced updates). */
export function mergeMeshRebuild(a: MeshRebuild, b: MeshRebuild): MeshRebuild {
  return RANK[a] >= RANK[b] ? a : b
}

/** What a mesh's GPU buffers were built from. */
export type MeshUploadStamp = {
  dataVersion: number
  positionsVersion: number
  positions: unknown
  indices: unknown
  colors: unknown
}

/** Record the vertex data a mesh's GPU buffers are about to be built from. */
export function meshUploadStamp(m: NVMesh): MeshUploadStamp {
  return {
    dataVersion: m._dataVersion ?? 0,
    positionsVersion: m._positionsVersion ?? 0,
    positions: m.positions,
    indices: m.indices,
    colors: m.colors,
  }
}

/**
 * Whether buffers built at `stamp` still hold `m`'s vertex data: the same
 * position, index and color arrays (a retessellated tract replaces them) at
 * the same `_dataVersion` (in-place colour/index edits such as recolouring)
 * and `_positionsVersion` (in-place position edits, `updateMeshPositions`).
 */
export function isMeshUploadCurrent(
  stamp: MeshUploadStamp | undefined,
  m: NVMesh,
): boolean {
  return (
    !!stamp &&
    stamp.dataVersion === (m._dataVersion ?? 0) &&
    stamp.positionsVersion === (m._positionsVersion ?? 0) &&
    stamp.positions === m.positions &&
    stamp.indices === m.indices &&
    stamp.colors === m.colors
  )
}

/**
 * The stamp after `updateMeshVertices` rewrote only a mesh's vertex buffer
 * from its current positions. Everything else keeps the old stamp's values
 * (the index buffer, and colors and `_dataVersion`, which a later rebuild
 * should still check), so the next rebuild re-uploads the mesh if any of
 * those changed. No stamp stays no stamp (stale).
 */
export function stampAfterVertexWrite(
  stamp: MeshUploadStamp | undefined,
  m: NVMesh,
): MeshUploadStamp | undefined {
  if (!stamp) return undefined
  return {
    ...stamp,
    positions: m.positions,
    positionsVersion: m._positionsVersion ?? 0,
  }
}

export type MeshSyncPlan = {
  /** Meshes whose GPU resources must be freed (removed, stale or all). */
  free: NVMesh[]
  /** Meshes to upload, in model order. */
  upload: NVMesh[]
}

/** A backend's per-mesh GPU resources, tagged with what they were built from. */
export type StampedMeshGpu = { uploadStamp?: MeshUploadStamp }

/**
 * Decide which mesh GPU resources to free and which meshes to upload.
 * `uploaded` is the backend's mesh resource map; `meshes` is the model's
 * current mesh list.
 */
export function planMeshSync(
  uploaded: ReadonlyMap<NVMesh, StampedMeshGpu>,
  meshes: readonly NVMesh[],
  mode: MeshRebuild,
): MeshSyncPlan {
  if (mode === 'none') return { free: [], upload: [] }
  const current = new Set(meshes)
  if (mode === 'all')
    return { free: [...uploaded.keys()], upload: [...current] }
  const free: NVMesh[] = []
  for (const [m, gpu] of uploaded) {
    if (!current.has(m) || !isMeshUploadCurrent(gpu.uploadStamp, m)) {
      free.push(m)
    }
  }
  const upload: NVMesh[] = []
  for (const m of current) {
    if (!isMeshUploadCurrent(uploaded.get(m)?.uploadStamp, m)) upload.push(m)
  }
  return { free, upload }
}
