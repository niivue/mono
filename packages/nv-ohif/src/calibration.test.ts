import { expect, test } from 'bun:test'
import type { NiiVue } from '@niivue/niivue'
import {
  adoptReportScale,
  calibrateStats,
  calibrationScale,
  setCalibrationScale,
  syncReportRows,
} from './calibration'
import { snapshot } from './measurementData'
import { measurementNote } from './measurementReflection'
import {
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'

test('a calibration doubles lengths, quadruples area, keeps the rest', () => {
  const stats = { area: 10, min: 1, mean: 2, max: 3, stdDev: 4, length: 5 }
  expect(calibrateStats({ ...stats, shortLength: 3 }, 2)).toEqual({
    ...stats,
    area: 40,
    length: 10,
    shortLength: 6,
  })
  // Recalibrating replaces the scale; another display set stays native.
  setCalibrationScale('a', 2)
  setCalibrationScale('a', 3)
  expect(calibrationScale('a')).toBe(3)
  expect(calibrationScale('b')).toBe(1)
  setCalibrationScale('a', 1)
  expect(calibrationScale('a')).toBe(1)
})

const reportPane = (viewportId: string) => {
  const annotations: { id: string }[] = []
  registerNiivue(viewportId, { annotations } as unknown as NiiVue)
  const adopt = (ds: string, id: string, ratio: number) => {
    adoptReportScale(ds, id, ratio)
    annotations.push({ id })
  }
  return { annotations, adopt }
}

test('report rows restore their scale; disagreeing rows leave native mm', () => {
  const { adopt } = reportPane('vp-sr')
  adopt('sr', 'a', 2)
  adopt('sr', 'b', 2.0005)
  expect(calibrationScale('sr')).toBe(2)
  adopt('sr', 'c', 1)
  expect(calibrationScale('sr')).toBe(1)
  unregisterNiivue('vp-sr')
})

test('a later report at another scale leaves native mm, even tasks later', async () => {
  const { annotations, adopt } = reportPane('vp-two')
  adopt('two-reports', 'a', 2)
  await new Promise((r) => setTimeout(r, 0))
  adopt('two-reports', 'b', 3)
  expect(calibrationScale('two-reports')).toBe(1)
  // Removing the disagreeing row restores the surviving rows' scale.
  annotations.splice(1)
  syncReportRows()
  expect(calibrationScale('two-reports')).toBe(2)
  // Once every report row is gone, the scale from before the report returns.
  annotations.length = 0
  syncReportRows()
  expect(calibrationScale('two-reports')).toBe(1)
  adopt('two-reports', 'c', 2)
  expect(calibrationScale('two-reports')).toBe(2)
  // A user calibration starts the agreement over.
  setCalibrationScale('two-reports', 4)
  adopt('two-reports', 'd', 3)
  expect(calibrationScale('two-reports')).toBe(3)
  setCalibrationScale('two-reports', 1)
  unregisterNiivue('vp-two')
})

test('a report row whose reflection failed gives back the prior scale', () => {
  registerNiivue('vp-fail', { annotations: [] } as unknown as NiiVue)
  setCalibrationScale('failed', 4)
  adoptReportScale('failed', 'gone', 2)
  expect(calibrationScale('failed')).toBe(2)
  // srImport removes the annotation; the pane's annotationChanged re-syncs.
  syncReportRows()
  expect(calibrationScale('failed')).toBe(4)
  setCalibrationScale('failed', 1)
  unregisterNiivue('vp-fail')
})

test('undoing a report row deletion brings its scale back', () => {
  const { annotations, adopt } = reportPane('vp-undo')
  adopt('undo', 'a', 2)
  const [row] = annotations.splice(0)
  syncReportRows()
  expect(calibrationScale('undo')).toBe(1)
  annotations.push(row as { id: string })
  syncReportRows()
  expect(calibrationScale('undo')).toBe(2)
  setCalibrationScale('undo', 1)
  unregisterNiivue('vp-undo')
})

test('unmounting the pane holding a report row gives back the prior scale', () => {
  const { adopt } = reportPane('vp-unmount')
  adopt('unmount', 'a', 2)
  expect(calibrationScale('unmount')).toBe(2)
  // NiivueViewport's cleanup order: unregister, then re-sync report rows.
  unregisterNiivue('vp-unmount')
  syncReportRows()
  expect(calibrationScale('unmount')).toBe(1)
})

test('calibrated rows and the flash note carry scaled values and User units', () => {
  const stats = { area: 6, min: 0, mean: 0, max: 0, stdDev: 0 }
  const line = {
    id: 'line',
    group: 'measurements',
    sliceType: 0,
    slicePosition: 0,
    shape: { type: 'measureLine', start: { x: 0, y: 0 }, end: { x: 3, y: 4 } },
    polygons: [],
    stats: { ...stats, area: 0, length: 5 },
  }
  const circle = {
    ...line,
    id: 'circle',
    shape: {
      type: 'measureCircle',
      start: { x: 0, y: 0 },
      end: { x: 4, y: 4 },
    },
    stats,
  }
  const nv = {
    annotations: [line, circle],
    effectiveDevicePixelRatio: 1,
    mmToCanvas: () => ({ x: 0, y: 0 }),
  } as unknown as NiiVue
  registerNiivue('vp-rows', nv)
  updateNiivueViewport('vp-rows', {
    displaySets: [{ displaySetInstanceUID: 'ds-rows' }] as never,
  })
  setCalibrationScale('ds-rows', 2)
  try {
    const [l, c] = snapshot(nv, 'HU', 'vp-rows').map((r) => r.values)
    expect([l?.length, l?.lengthUnit, l?.areaUnit]).toEqual([
      10,
      'mm User',
      'mm² User',
    ])
    expect([c?.area, c?.radius, c?.radiusUnit]).toEqual([24, 4, 'mm User'])
    expect(measurementNote(line.stats, 2)).toBe('Length: 10.0 mm User')
    expect(measurementNote(stats, 2)).toBe('Area: 24.0 mm² User')
    expect(measurementNote(line.stats, 1)).toBe('Length: 5.0 mm')
  } finally {
    setCalibrationScale('ds-rows', 1)
    unregisterNiivue('vp-rows')
  }
  const [native] = snapshot(nv, 'HU', 'vp-rows').map((r) => r.values)
  expect([native?.length, native?.lengthUnit]).toEqual([5, undefined])
})

// A study's calibration must not carry into the next mode entry.
test('mode exit forgets every calibration', async () => {
  const { default: extension } = await import('./index')
  setCalibrationScale('exit-ds', 2)
  extension.onModeExit?.()
  expect(calibrationScale('exit-ds')).toBe(1)
})
