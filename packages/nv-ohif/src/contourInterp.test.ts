import { expect, test } from 'bun:test'
import type { NiiVue, VectorAnnotation } from '@niivue/niivue'
import {
  blendRing,
  correspond,
  interpolateGroup,
  isInterpolated,
} from './contourInterp'
import { ringArea } from './contourOps'

// Halfway between concentric 10 and 20 mm squares is a 15 mm square, even
// when the second winds the other way and starts at another corner: the
// rings must be matched point to point, not by index.
test('blendRing halfway between corresponded squares', () => {
  const square = (h: number) => [
    { x: -h, y: -h },
    { x: h, y: -h },
    { x: h, y: h },
    { x: -h, y: h },
  ]
  const outer = square(10).reverse()
  const [a, b] = correspond(
    square(5),
    [...outer.slice(2), ...outer.slice(0, 2)],
    64,
  )
  expect(ringArea(blendRing(a, b, 0.5))).toBeCloseTo(225, 6)
})

// Review of the R28 draft: classification is the shape's geometry, so an edit
// by any tool (Sculptor replaces shapes) makes a generated contour a key, and
// undoing that edit, or a key edit that regenerated it, makes it generated.
test('an edited in-between is a key until undone', () => {
  const square = (w: number) => [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: w },
    { x: 0, y: w },
  ]
  const shape = (id: string, z: number, w: number) =>
    ({
      id,
      group: 'seg:t',
      label: 1,
      sliceType: 0,
      slicePosition: z,
      anchorMM: [0, 0, z],
      polygons: [{ outer: square(w), holes: [] }],
    }) as unknown as VectorAnnotation
  const nv = {
    annotations: [shape('k0', 0, 10), shape('k2', 2, 20)],
    volumes: [
      {
        dimsRAS: [3, 64, 64, 3],
        img2RASstep: [1, 64, 4096],
        img2RASstart: [0, 0, 0],
        matRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      },
    ],
    replaceAnnotations(ids: string[], added: VectorAnnotation[]) {
      nv.annotations = [
        ...nv.annotations.filter((a) => !ids.includes(a.id)),
        ...added,
      ]
    },
  }
  const run = () => interpolateGroup(nv as unknown as NiiVue, 'seg:t')
  const mid = () =>
    nv.annotations.find((a) => a.anchorMM?.[2] === 1) as VectorAnnotation
  const area = () => ringArea(mid().polygons[0]?.outer ?? [])
  const resize = (w: number) =>
    nv.replaceAnnotations(['k2'], [shape('k2', 2, w)])
  run()
  const generated = mid()
  nv.replaceAnnotations(
    [generated.id],
    [{ ...generated, polygons: [{ outer: square(18), holes: [] }] }],
  )
  resize(30)
  run()
  expect([area(), isInterpolated(mid())]).toEqual([324, false])
  nv.replaceAnnotations([generated.id], [generated])
  resize(40)
  run()
  expect([area(), isInterpolated(mid())]).toEqual([625, true])
  // Undoing key edits, as far as undo reaches (32 steps), restores an
  // earlier generation: still generated.
  const snapshot = structuredClone(nv.annotations)
  for (let w = 41; w <= 72; w++) {
    resize(w)
    run()
  }
  nv.annotations = snapshot
  expect(isInterpolated(mid())).toBe(true)
  resize(60)
  run()
  expect([area(), isInterpolated(mid())]).toEqual([1225, true])
})
