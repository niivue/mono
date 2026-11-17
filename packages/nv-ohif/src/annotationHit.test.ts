import { expect, test } from 'bun:test'
import type { NiiVue } from '@niivue/niivue'
import { annotationAt } from './annotationHit'

// R14 audit: an annotation on another slice is stored but not drawn; a
// right-click over the visible one must not pick (and delete) it.
test('only drawn shapes are hit, so another slice cannot win', () => {
  const square = {
    outer: [
      { x: 40, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 60 },
      { x: 40, y: 60 },
    ],
    holes: [],
  }
  const nv = {
    effectiveDevicePixelRatio: 1,
    annotations: [{ id: 'old-z0' }, { id: 'visible-z10' }],
    annotationScreenShapes: [{ id: 'visible-z10', polygons: [square] }],
  } as unknown as NiiVue
  const hit = annotationAt(nv, 'vp', { offsetX: 50, offsetY: 50 } as MouseEvent)
  expect(hit?.id).toBe('visible-z10')
})

// Review of #835: a click in an erased hole is outside the ROI.
test('a hole is not inside', () => {
  const square = (a: number, b: number) => [
    { x: a, y: a },
    { x: b, y: a },
    { x: b, y: b },
    { x: a, y: b },
  ]
  const nv = {
    effectiveDevicePixelRatio: 1,
    annotations: [{ id: 'roi' }],
    annotationScreenShapes: [
      {
        id: 'roi',
        polygons: [{ outer: square(0, 100), holes: [square(20, 80)] }],
      },
    ],
  } as unknown as NiiVue
  const at = (x: number) =>
    annotationAt(nv, 'vp', { offsetX: x, offsetY: 50 } as MouseEvent)?.id
  expect(at(50)).toBeUndefined()
  expect(at(10)).toBe('roi')
})
