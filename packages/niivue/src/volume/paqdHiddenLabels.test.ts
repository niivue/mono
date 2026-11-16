import { expect, test } from 'bun:test'
import { paqdVoxelVisible } from '@/view/planeVisibility'
import { dropHiddenPaqdLabels } from '@/volume/utils'

// Voxels as [idx1, idx2, prob1, prob2].
test('hidden labels leave the voxel as if the file never had them', () => {
  // Hidden secondary, hidden primary, both hidden, neither, hidden primary
  // over an empty secondary.
  const data = new Uint8Array([
    1, 2, 200, 50, 3, 4, 150, 100, 3, 2, 150, 100, 5, 6, 90, 80, 3, 7, 200, 0,
  ])
  dropHiddenPaqdLabels(data, [2, 3])
  // A freed slot is label 0 at probability 0, PAQD's empty slot, so no
  // hidden index remains for a 2D slice's nearest-index lookup to colour.
  expect(Array.from(data)).toEqual([
    1, 0, 200, 0, 4, 0, 100, 0, 0, 0, 0, 0, 5, 6, 90, 80, 0, 0, 0, 0,
  ])
})

test('a hidden PAQD label no longer counts as a visible plane for picking', () => {
  const ease = [0.2, 0.6, 0.5, 1]
  const data = new Uint8Array([1, 0, 255, 0])
  expect(paqdVoxelVisible(data[2], data[3], ease)).toBe(true)
  dropHiddenPaqdLabels(data, [1])
  expect(paqdVoxelVisible(data[2], data[3], ease)).toBe(false)
})
