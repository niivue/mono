import { expect, test } from 'bun:test'
import type { AnnotationScreenShape, NiiVue } from '@niivue/niivue'
import {
  adoptReportScale,
  calibrateShapes,
  calibrateStats,
  calibrationScale,
  setCalibrationScale,
  syncReportRows,
} from './calibration'
import { measurementNote } from './commands'
import { contourGroup } from './contourSeg'
import { snapshot } from './measurementData'
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

test('overlay labels and rulers take the scale; free text and contours do not', () => {
  const nv = {
    // The shape being dragged is core's preview, not yet an annotation.
    model: {
      _annotationPreview: {
        id: 'drag',
        group: '',
        stats: { area: 0, length: 3, shortLength: 1 },
      },
    },
    annotations: [
      {
        id: 'bi',
        group: '',
        text: 'L: lesion',
        stats: { area: 0, length: 4, shortLength: 2 },
      },
      { id: 'roi', group: '', stats: { area: 3, mean: 7 } },
      { id: 'ruler', group: '', stats: { area: 0, length: 5 } },
      { id: 'seg', group: contourGroup('1'), stats: { area: 3 } },
    ],
  } as unknown as NiiVue
  const shape = (id: string, lines: string[], length?: number) =>
    ({
      id,
      label: { lines, x: 0, y: 0, align: 'left' },
      length,
    }) as unknown as AnnotationScreenShape
  const [bi, roi, ruler, seg, drawing, drag] = calibrateShapes(nv, 2, [
    shape('bi', ['L: lesion', 'L: 4.0 mm', 'W: 2.0 mm']),
    shape('roi', ['Area: 3.0 mm²', 'Mean: 7.0  SD: 0.0']),
    shape('ruler', [], 5),
    shape('seg', ['Area: 3.0 mm²']),
    shape('drawing', [], 5),
    shape('drag', ['L: 3.0 mm', 'W: 1.0 mm']),
  ])
  expect(bi?.label?.lines).toEqual([
    'L: lesion',
    'L: 8.0 mm User',
    'W: 4.0 mm User',
  ])
  expect(roi?.label?.lines).toEqual([
    'Area: 12.0 mm² User',
    'Mean: 7.0  SD: 0.0',
  ])
  expect([ruler?.length, ruler?.unit]).toEqual([10, 'mm User'])
  expect(seg?.label?.lines).toEqual(['Area: 3.0 mm²'])
  expect(drawing?.length).toBe(10)
  expect(drag?.label?.lines).toEqual(['L: 6.0 mm User', 'W: 2.0 mm User'])
})

// A pane holding report rows: adoptReportScale checks only rows a pane holds.
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
  // srImport removes the annotation; the pane's annotationRemoved re-syncs.
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
