import { expect, test } from 'bun:test'
import { toCornerstoneAnnotation } from './srBridge'

// R13 audit: SR adapters read RectangleROI handles as TL, TR, BL, BR (the row
// runs around the outline), a circle's radius and an ROI's modalityUnit from
// cachedStats (the row says unit: 30 HU was exported as 30 px).
test('rectangle handles reorder and a circle carries its radius', () => {
  const base = {
    uid: 'u',
    referencedImageId: 'img',
    data: { area: 1, mean: 30, unit: 'HU', areaUnit: 'mm²' },
  }
  const rect = toCornerstoneAnnotation({
    ...base,
    toolName: 'RectangleROI',
    points: [
      [0, 0, 0],
      [4, 0, 0],
      [4, 3, 0],
      [0, 3, 0],
    ],
  })
  expect(rect?.data.handles.points).toEqual([
    [0, 0, 0],
    [4, 0, 0],
    [0, 3, 0],
    [4, 3, 0],
  ])
  const circle = toCornerstoneAnnotation({
    ...base,
    toolName: 'CircleROI',
    points: [
      [1, 1, 0],
      [4, 5, 0],
    ],
  })
  expect(circle?.data.cachedStats['imageId:img']).toMatchObject({
    radius: 5,
    area: 1,
    modalityUnit: 'HU',
  })
})
