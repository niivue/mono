import type { NVImage, NVMesh, NVMeshLayer } from '@/NVTypes'
import {
  computeVolumeLabelCentroids,
  labelCentroidsByName,
} from '@/volume/utils'

type Vec3 = [number, number, number]
type Centroids = Record<string, Vec3>

/**
 * Computed on the first legend click, not at load: a 256³ label volume costs
 * ~60 ms to scan and most apps never click. Keyed weakly on the voxel or vertex
 * array, so a replaced array is neither reused nor kept alive.
 */
const memo = new WeakMap<object, { deps: unknown[]; centroids: Centroids }>()
function memoized(data: object, deps: unknown[], compute: () => Centroids) {
  const hit = memo.get(data)
  if (hit?.deps.every((d, i) => d === deps[i])) return hit.centroids
  const centroids = compute()
  memo.set(data, { deps, centroids })
  return centroids
}

export function volumeLabelCentroid(
  volume: NVImage,
  label: string,
): Vec3 | undefined {
  if (!volume.img) return undefined
  return memoized(
    volume.img,
    [volume.colormapLabel, volume.matRAS, volume._dataVersion ?? 0],
    () => computeVolumeLabelCentroids(volume),
  )[label]
}

export function meshLabelCentroid(
  mesh: NVMesh,
  layer: NVMeshLayer,
  label: string,
): Vec3 | undefined {
  const positions = mesh.positions
  if (!positions) return undefined
  return memoized(
    layer.values,
    [positions, layer.colormapLabel, mesh._positionsVersion ?? 0],
    () => computeMeshLabelCentroids(positions, layer),
  )[label]
}

/** Center-of-mass per label of a mesh layer; positions are already in mm. */
export function computeMeshLabelCentroids(
  positions: Float32Array,
  layer: NVMeshLayer,
): Centroids {
  const lut = layer.colormapLabel
  if (!lut?.labels) return {}
  const lutMin = lut.min ?? 0
  const nLabel = Math.max(
    0,
    (lut.max ?? lut.labels.length - 1 + lutMin) - lutMin + 1,
  )
  const acc = new Float64Array(nLabel * 4)
  const values = layer.values
  for (let i = 0; i < positions.length / 3; i++) {
    const k = Math.round(values[i]) - lutMin
    // Negated so a NaN value is skipped too.
    if (!(k >= 0 && k < nLabel)) continue
    acc[k * 4] += positions[i * 3]
    acc[k * 4 + 1] += positions[i * 3 + 1]
    acc[k * 4 + 2] += positions[i * 3 + 2]
    acc[k * 4 + 3] += 1
  }
  return labelCentroidsByName(acc, lut.labels)
}
