import { expect, test } from 'bun:test'
import type { OmeZarrInfo } from '@niivue/nv-ext-tile/zarr'
import { segmentationColormap } from './segColormap'

test('two segmentations with one store name get distinct colormap names', () => {
  const info = (rgba: [number, number, number, number]) =>
    ({ name: null, labelColors: [{ id: 1, rgba }] }) as unknown as OmeZarrInfo
  const red = segmentationColormap(info([255, 0, 0, 255]), 'segmentation-1-1')
  const blue = segmentationColormap(info([0, 0, 255, 255]), 'segmentation-1-2')
  expect(red?.name).not.toBe(blue?.name)
  expect(red?.map.R).toEqual([255])
  expect(segmentationColormap(info([0, 0, 0, 0]), 'x')).not.toBeNull()
  expect(
    segmentationColormap(
      { name: 'n', labelColors: [] } as unknown as OmeZarrInfo,
      'x',
    ),
  ).toBeNull()
})
