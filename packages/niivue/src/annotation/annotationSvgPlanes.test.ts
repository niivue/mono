import { expect, test } from 'bun:test'
import NiiVue, { SLICE_TYPE } from '@/index'

// The controller wiring of `nv.annotationsToSVG()`, which picks the plane(s)
// to export; the serializer itself is tested in annotationSvg.test.ts. In a
// view with no single slice plane on screen (render / multiplanar), every
// plane exports. Previously the controller fell back to
// `annotations[0].sliceType` and silently dropped shapes on other planes.
// No volume is loaded: the export reads only the annotations.

/** An instance holding one square annotation on each of the three planes. */
function threePlanes(): NiiVue {
  const nv = new NiiVue({ backend: 'webgl2' })
  const square = (id: string, sliceType: number) => ({
    id,
    label: 1,
    group: 'g',
    sliceType,
    slicePosition: 0,
    polygons: [
      {
        outer: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        holes: [],
      },
    ],
    style: {
      fillColor: [1, 0, 0, 0.3] as [number, number, number, number],
      strokeColor: [1, 0, 0, 1] as [number, number, number, number],
      strokeWidth: 2,
    },
  })
  nv.addAnnotation(square('ax', SLICE_TYPE.AXIAL))
  nv.addAnnotation(square('co', SLICE_TYPE.CORONAL))
  nv.addAnnotation(square('sa', SLICE_TYPE.SAGITTAL))
  return nv
}

const paths = (svg: string | null) => svg?.match(/<path /g)?.length

test('multiplanar view exports every plane, not just the first annotation of the first plane', () => {
  const nv = threePlanes()
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
  const svg = nv.annotationsToSVG()
  expect(svg).toContain('data-slice-plane="AXIAL"')
  expect(svg).toContain('data-slice-plane="CORONAL"')
  expect(svg).toContain('data-slice-plane="SAGITTAL"')
  expect(paths(svg)).toBe(3)
  // Panels are laid out left-to-right, so at least one is translated off zero.
  expect(svg).toMatch(/transform="translate\((?!0 0)/)
})

test('render view (no single slice plane) also exports every plane', () => {
  const nv = threePlanes()
  nv.sliceType = SLICE_TYPE.RENDER
  expect(paths(nv.annotationsToSVG())).toBe(3)
})

test('a single-slice view still restricts the export to that plane', () => {
  const nv = threePlanes()
  nv.sliceType = SLICE_TYPE.CORONAL
  const auto = nv.annotationsToSVG()
  // An explicit sliceType overrides the current view.
  const explicit = nv.annotationsToSVG(SLICE_TYPE.SAGITTAL)

  expect(auto).toContain('data-slice-plane="CORONAL"')
  expect(auto).not.toContain('data-slice-plane="AXIAL"')
  expect(paths(auto)).toBe(1)
  expect(explicit).toContain('data-slice-plane="SAGITTAL"')
  expect(paths(explicit)).toBe(1)
})

test('returns null when there are no annotations', () => {
  expect(new NiiVue({ backend: 'webgl2' }).annotationsToSVG()).toBeNull()
})
