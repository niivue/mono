import { expect, test } from 'bun:test'
import type { OhifExtensionManager, OhifServicesManager } from './ohif-types'
import { mirrorNiivueMeasurements, toCornerstoneAnnotation } from './srBridge'

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

// Codex 855-r1: a rebuilt commands module stops the old mirror (removing its
// annotations); the new one must put the existing rows back.
test('a new mirror re-adds the NiiVue rows that already exist', () => {
  const annotations = new Map<string, unknown>()
  const manager = {
    addAnnotation: (a: { annotationUID: string }) =>
      annotations.set(a.annotationUID, a),
    removeAnnotation: (uid: string) => annotations.delete(uid),
  }
  const extensionManager = {
    getModuleEntry: () => ({
      exports: {
        getCornerstoneLibraries: () => ({
          cornerstoneTools: {
            annotation: { state: { getAnnotationManager: () => manager } },
          },
        }),
      },
    }),
  } as unknown as OhifExtensionManager
  const row = {
    uid: 'r1',
    source: { name: 'NiiVue' },
    toolName: 'Length',
    referencedImageId: 'img',
    points: [
      [0, 0, 0],
      [1, 0, 0],
    ],
  }
  const other = { ...row, uid: 'r2', source: { name: 'Cornerstone3DTools' } }
  const servicesManager = {
    services: {
      measurementService: {
        EVENTS: { MEASUREMENT_ADDED: 'added' },
        subscribe: () => ({ unsubscribe: () => {} }),
        getMeasurements: () => [row, other],
      },
    },
  } as unknown as OhifServicesManager
  const stop = mirrorNiivueMeasurements(servicesManager, extensionManager)
  expect([...annotations.keys()]).toEqual(['r1'])
  stop()
  expect(annotations.size).toBe(0)
  mirrorNiivueMeasurements(servicesManager, extensionManager)
  expect(annotations.has('r1')).toBe(true)
})
