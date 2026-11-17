import type { NVMesh, NVMeshLayer } from '@/NVTypes'

const _shown = new WeakMap<
  NVMesh,
  { indices: Uint32Array; dataVersion: number; shown: Uint32Array }
>()

function isCulling(layer: NVMeshLayer): boolean {
  return (
    layer.isHiddenLabelCulled !== false &&
    !!layer.colormapLabel &&
    layer.opacity > 0 &&
    !!layer.hiddenLabels?.length
  )
}

/** 1 at each hidden label's row of the layer's label table. */
function hiddenMask(layer: NVMeshLayer): { mask: Uint8Array; min: number } {
  const min = layer.colormapLabel?.min ?? 0
  const mask = new Uint8Array((layer.colormapLabel?.lut.length ?? 0) / 4)
  for (const value of layer.hiddenLabels ?? []) mask[value - min] = 1
  return { mask, min }
}

/**
 * The triangles the GPU draws: `mesh.indices` without those whose label is
 * hidden on a label layer (unless its `isHiddenLabelCulled` is false), in
 * file order (translucent blending depends on it). Memoized on
 * `mesh.indices` and `_dataVersion`, which every layer setter
 * bumps; a refilter that gives the same triangles keeps the old array, so a
 * new array means the culled set changed and crosscut2 rebuilds its clusters.
 */
export function shownIndices(mesh: NVMesh): Uint32Array {
  const indices = mesh.indices
  const dataVersion = mesh._dataVersion ?? 0
  const hit = _shown.get(mesh)
  if (hit?.indices === indices && hit.dataVersion === dataVersion)
    return hit.shown
  const layers = (mesh.layers ?? []).filter(isCulling)
  let shown = indices
  if (layers.length) {
    const nVert = mesh.positions.length / 3
    const culls = layers.map((layer) => ({
      ...hiddenMask(layer),
      values: layer.values.subarray(layer.frame4D * nVert),
    }))
    const kept = new Uint32Array(indices.length)
    let n = 0
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i]
      const i1 = indices[i + 1]
      const i2 = indices[i + 2]
      let isHidden = false
      for (const { mask, min, values } of culls) {
        const b = Math.round(values[i1])
        // Majority of the three vertex labels: each triangle has exactly one,
        // so neighbouring regions stay gap-free whichever of them is hidden.
        const label = b === Math.round(values[i2]) ? b : Math.round(values[i0])
        if (mask[label - min]) isHidden = true
      }
      if (isHidden) continue
      kept[n++] = i0
      kept[n++] = i1
      kept[n++] = i2
    }
    const prev = hit?.indices === indices ? hit.shown : null
    shown =
      prev && prev.length === n && prev.every((v, k) => v === kept[k])
        ? prev
        : kept.slice(0, n)
  }
  _shown.set(mesh, { indices, dataVersion, shown })
  return shown
}
