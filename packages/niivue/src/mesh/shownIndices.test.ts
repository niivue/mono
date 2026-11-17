import { expect, test } from 'bun:test'
import { shownIndices } from '@/mesh/shownIndices'
import type { NVMesh, NVMeshLayer } from '@/NVTypes'

// Vertex labels 1, 1, 2, 2. Triangle labels by majority: 1, 2, 1.
function atlasMesh(layer: Partial<NVMeshLayer>): NVMesh {
  return {
    positions: new Float32Array(12),
    indices: new Uint32Array([0, 1, 2, 1, 2, 3, 0, 1, 3]),
    layers: [
      {
        values: new Float32Array([1, 1, 2, 2]),
        frame4D: 0,
        opacity: 1,
        colormapLabel: { lut: new Uint8ClampedArray(12), min: 0, max: 2 },
        ...layer,
      },
    ],
  } as unknown as NVMesh
}

test('culls the triangles whose majority label is hidden', () => {
  const hide = (hiddenLabels: number[]) =>
    Array.from(shownIndices(atlasMesh({ hiddenLabels })))
  expect(hide([2])).toEqual([0, 1, 2, 0, 1, 3])
  // Each triangle has one label, so the two hidden sets tile the mesh.
  expect(hide([1])).toEqual([1, 2, 3])
  expect(hide([1, 2])).toEqual([])
})

test('draws every triangle when the layer opts out', () => {
  const mesh = atlasMesh({ isHiddenLabelCulled: false, hiddenLabels: [2] })
  expect(shownIndices(mesh)).toBe(mesh.indices)
})

test('returns the same array until the hidden set changes', () => {
  const mesh = atlasMesh({ hiddenLabels: [2] })
  const first = shownIndices(mesh)
  expect(shownIndices(mesh)).toBe(first)
  mesh.layers[0].hiddenLabels = [1]
  mesh._dataVersion = 1 // as setMeshLayerProperty bumps it
  expect(shownIndices(mesh)).not.toBe(first)
})

test('refilters labels edited in place once _dataVersion bumps', () => {
  const mesh = atlasMesh({ hiddenLabels: [2] })
  const first = shownIndices(mesh)
  mesh._dataVersion = 1
  expect(shownIndices(mesh)).toBe(first) // same result keeps the array
  mesh.layers[0].values.set([2, 2, 1, 1])
  mesh._dataVersion = 2
  expect(Array.from(shownIndices(mesh))).toEqual([1, 2, 3])
})
