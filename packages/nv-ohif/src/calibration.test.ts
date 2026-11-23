import { expect, test } from 'bun:test'
import type { AnnotationScreenShape, NiiVue } from '@niivue/niivue'
import {
  calibrateShapes,
  calibrateStats,
  calibrationScale,
  setCalibrationScale,
} from './calibration'
import { contourGroup } from './contourSeg'

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
