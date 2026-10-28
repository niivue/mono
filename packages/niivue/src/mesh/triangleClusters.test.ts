import { describe, expect, test } from 'bun:test'
import type { NVMesh } from '@/NVTypes'
import {
  buildTriangleClusters,
  CLUSTER_SIZE,
  clustersCrossingPlanes,
  meshClusters,
  PLANE_SHIFT,
  sortedIndices,
} from './triangleClusters'

// A flat grid of triangles in z = 0 spanning x, y in [0, n], with its
// triangles listed in a scrambled order (like FreeSurfer's).
function scrambledGrid(n: number) {
  const positions: number[] = []
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) positions.push(x, y, 0)
  const tris: number[][] = []
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = y * (n + 1) + x
      tris.push([v, v + 1, v + n + 1], [v + 1, v + n + 2, v + n + 1])
    }
  }
  // Deterministic shuffle.
  for (let i = tris.length - 1; i > 0; i--) {
    const j = (i * 7919) % (i + 1)
    ;[tris[i], tris[j]] = [tris[j], tris[i]]
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(tris.flat()),
  }
}

// The crosscut2 plane uniform for one plane x = d.
function planeX(d: number): Float32Array {
  const p = new Float32Array(16)
  p.set([1, 0, 0, d], 0)
  p[15] = 1
  return p
}

describe('buildTriangleClusters', () => {
  test('keeps every triangle exactly once', () => {
    const { positions, indices } = scrambledGrid(40)
    const { order, clusterCount } = buildTriangleClusters(positions, indices)
    const sorted = sortedIndices(indices, order)
    const key = (a: ArrayLike<number>, t: number) =>
      `${a[t * 3]},${a[t * 3 + 1]},${a[t * 3 + 2]}`
    const before = new Set(
      Array.from({ length: indices.length / 3 }, (_, t) => key(indices, t)),
    )
    const after = new Set(
      Array.from({ length: sorted.length / 3 }, (_, t) => key(sorted, t)),
    )
    expect(sorted.length).toBe(indices.length)
    expect(after).toEqual(before)
    expect(clusterCount).toBe(Math.ceil(indices.length / 3 / CLUSTER_SIZE))
  })

  test('clusters are compact, so a plane crosses few of them', () => {
    const { positions, indices } = scrambledGrid(80) // 12800 triangles
    const c = buildTriangleClusters(positions, indices)
    const { clusterCount } = c
    const n = clustersCrossingPlanes(c, planeX(40.5)).length
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(clusterCount / 4)
  })

  test('every triangle the plane cuts is in a listed cluster', () => {
    const { positions, indices } = scrambledGrid(60)
    const c = buildTriangleClusters(positions, indices)
    const sorted = sortedIndices(indices, c.order)
    const listed = new Set(Array.from(clustersCrossingPlanes(c, planeX(17.25))))
    for (let t = 0; t < sorted.length / 3; t++) {
      const xs = [0, 1, 2].map((k) => positions[sorted[t * 3 + k] * 3])
      if (Math.min(...xs) <= 17.25 && Math.max(...xs) >= 17.25) {
        expect(listed.has(Math.floor(t / CLUSTER_SIZE))).toBe(true)
      }
    }
  })

  test('entries carry the plane number', () => {
    const { positions, indices } = scrambledGrid(20)
    const c = buildTriangleClusters(positions, indices)
    const planes = new Float32Array(16)
    planes.set([1, 0, 0, 5], 0)
    planes.set([0, 1, 0, 5], 4)
    planes[15] = 2
    const planesSeen = new Set(
      Array.from(clustersCrossingPlanes(c, planes), (e) => e >>> PLANE_SHIFT),
    )
    expect(planesSeen).toEqual(new Set([0, 1]))
  })
})

describe('meshClusters', () => {
  // One triangle spanning x = 0..1, plus spare vertices at x = 10..11.
  const makeMesh = () =>
    ({
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0,
      ]),
      indices: new Uint32Array([0, 1, 2]),
      _dataVersion: 0,
    }) as unknown as NVMesh

  test('an in-place index edit rebuilds the clusters', () => {
    const mesh = makeMesh()
    const before = meshClusters(mesh)
    mesh.indices.set([3, 4, 5])
    mesh._dataVersion = 1
    const after = meshClusters(mesh)
    expect(after).not.toBe(before)
    expect(clustersCrossingPlanes(after, planeX(10.5)).length).toBe(1)
  })

  test('a color-only data version bump keeps the clusters', () => {
    const mesh = makeMesh()
    const before = meshClusters(mesh)
    mesh._dataVersion = 1
    expect(meshClusters(mesh)).toBe(before)
  })
})
