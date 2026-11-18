import { expect, test } from 'bun:test'
import type NiiVue from '@/index'
import { dragForWindowing } from './dragModes'

// A stand-in controller: only what dragForWindowing reads and calls.
function ctrl(
  windowingStep: [number, number],
  isWindowingUpperBoundOnly = false,
) {
  const vol = { robustMin: 0, robustMax: 1000, calMin: 400, calMax: 600 }
  const c = {
    model: {
      getVolumes: () => [vol],
      interaction: { windowingStep, isWindowingUpperBoundOnly },
    },
    emit: () => {},
    _updateGLChanged: async () => {},
  }
  return { vol, c: c as unknown as NiiVue }
}

test('windowing drag gain and direction follow windowingStep', () => {
  // Default: 0.5% of the robust range per pixel; up (negative dy) raises the center.
  const a = ctrl([0.005, 0.005])
  dragForWindowing(a.c, 10, -10)
  expect(a.vol.calMax - a.vol.calMin).toBeCloseTo(250)
  expect((a.vol.calMax + a.vol.calMin) / 2).toBeCloseTo(550)
  // Cornerstone-style: a negative center step makes dragging down raise it.
  const b = ctrl([0.001, -0.001])
  dragForWindowing(b.c, 10, 10)
  expect(b.vol.calMax - b.vol.calMin).toBeCloseTo(210)
  expect((b.vol.calMax + b.vol.calMin) / 2).toBeCloseTo(510)
})

test('upper-bound windowing moves only calMax and stops at calMin', () => {
  // Cornerstone PET: dragging down lowers the upper bound; width input ignored.
  const a = ctrl([0.005, 0.005], true)
  dragForWindowing(a.c, 50, 10)
  expect(a.vol).toMatchObject({ calMin: 400, calMax: 550 })
  dragForWindowing(a.c, 0, 100)
  expect(a.vol).toMatchObject({ calMin: 400, calMax: 400 })
})
