import { describe, expect, test } from 'bun:test'
import { SLICE_TYPE } from '@/NVConstants'
import type { VectorAnnotation } from '@/NVTypes'
import { annotationsToSVG } from './annotationSvg'

const makeAnn = (over: Partial<VectorAnnotation> = {}): VectorAnnotation => ({
  id: 'a1',
  label: 1,
  group: 'g',
  sliceType: SLICE_TYPE.AXIAL,
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
    fillColor: [1, 0, 0, 0.3],
    strokeColor: [1, 0, 0, 1],
    strokeWidth: 2,
  },
  ...over,
})

describe('annotationsToSVG', () => {
  test('emits a path for a matching axial annotation with fill + stroke', () => {
    const svg = annotationsToSVG({
      annotations: [makeAnn()],
      sliceType: SLICE_TYPE.AXIAL,
    })
    expect(svg).toContain('<path')
    expect(svg).toContain('fill="rgba(255,0,0,0.3)"')
    expect(svg).toContain('stroke="rgba(255,0,0,1)"')
    expect(svg).toContain('fill-rule="evenodd"')
    expect(svg).toContain('Z')
    expect(svg.match(/<path /g)?.length).toBe(1)
  })

  test('filters by slice type', () => {
    const svg = annotationsToSVG({
      annotations: [makeAnn({ sliceType: SLICE_TYPE.CORONAL })],
      sliceType: SLICE_TYPE.AXIAL,
    })
    expect(svg.match(/<path /g)).toBeNull()
    expect(svg).toContain('viewBox="0 0 1 1"') // empty
  })

  test('filters by slice position within tolerance', () => {
    const anns = [
      makeAnn({ id: 'near', slicePosition: 10 }),
      makeAnn({ id: 'far', slicePosition: 40 }),
    ]
    const svg = annotationsToSVG({
      annotations: anns,
      sliceType: SLICE_TYPE.AXIAL,
      slicePosition: 10,
      tolerance: 1,
    })
    expect(svg.match(/<path /g)?.length).toBe(1)
  })

  test('emits a hole subpath for a polygon with holes', () => {
    const withHole = makeAnn({
      polygons: [
        {
          outer: [
            { x: 0, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 20 },
            { x: 0, y: 20 },
          ],
          holes: [
            [
              { x: 5, y: 5 },
              { x: 15, y: 5 },
              { x: 15, y: 15 },
            ],
          ],
        },
      ],
    })
    const svg = annotationsToSVG({
      annotations: [withHole],
      sliceType: SLICE_TYPE.AXIAL,
    })
    // Two subpaths (outer + hole) => two 'M' move commands in one path.
    const d = svg.match(/d="([^"]+)"/)?.[1] ?? ''
    expect((d.match(/M /g) ?? []).length).toBe(2)
  })

  test('viewBox frames the geometry (with padding) and flips y', () => {
    const svg = annotationsToSVG({
      annotations: [makeAnn()],
      sliceType: SLICE_TYPE.AXIAL,
      pad: 0,
    })
    // bbox is 0..10 in x and y -> viewBox "0 0 10 10"
    expect(svg).toContain('viewBox="0 0 10 10"')
    // The point (0,0) in mm flips to y=10 (maxY+minY-0).
    expect(svg).toContain('M 0 10')
  })

  test('no annotations yields a valid empty SVG', () => {
    const svg = annotationsToSVG({
      annotations: [],
      sliceType: SLICE_TYPE.AXIAL,
    })
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
    expect(svg.match(/<path /g)).toBeNull()
  })

  test('omitting sliceType exports every plane, one <g> panel each', () => {
    const svg = annotationsToSVG({
      annotations: [
        makeAnn({ id: 'a', sliceType: SLICE_TYPE.AXIAL }),
        makeAnn({ id: 'c', sliceType: SLICE_TYPE.CORONAL }),
        makeAnn({ id: 's', sliceType: SLICE_TYPE.SAGITTAL }),
      ],
      pad: 0,
    })
    // Every shape lands in the one SVG (the old code kept only annotations[0]'s plane).
    expect(svg.match(/<path /g)?.length).toBe(3)
    expect(svg.match(/<g /g)?.length).toBe(3)
    expect(svg).toContain('data-slice-plane="AXIAL"')
    expect(svg).toContain('data-slice-plane="CORONAL"')
    expect(svg).toContain('data-slice-plane="SAGITTAL"')
  })

  test('panels are laid out left-to-right without overlapping', () => {
    const svg = annotationsToSVG({
      annotations: [
        makeAnn({ id: 'a', sliceType: SLICE_TYPE.AXIAL }),
        makeAnn({ id: 'c', sliceType: SLICE_TYPE.CORONAL }),
      ],
      pad: 0,
    })
    // Each 10mm panel sits at its own x offset; gap = pad*2 = 0 here.
    expect(svg).toContain('transform="translate(0 0)"')
    expect(svg).toContain('transform="translate(10 0)"')
    // viewBox spans both panels horizontally, one panel tall.
    expect(svg).toContain('viewBox="0 0 20 10"')
  })

  test('panels are ordered by slice plane regardless of annotation order', () => {
    const svg = annotationsToSVG({
      annotations: [
        makeAnn({ id: 's', sliceType: SLICE_TYPE.SAGITTAL }),
        makeAnn({ id: 'a', sliceType: SLICE_TYPE.AXIAL }),
      ],
      pad: 0,
    })
    const axial = svg.indexOf('data-slice-plane="AXIAL"')
    const sagittal = svg.indexOf('data-slice-plane="SAGITTAL"')
    expect(axial).toBeGreaterThanOrEqual(0)
    expect(axial).toBeLessThan(sagittal)
  })

  test('an explicit sliceType still restricts to one panel', () => {
    const svg = annotationsToSVG({
      annotations: [
        makeAnn({ id: 'a', sliceType: SLICE_TYPE.AXIAL }),
        makeAnn({ id: 'c', sliceType: SLICE_TYPE.CORONAL }),
      ],
      sliceType: SLICE_TYPE.AXIAL,
    })
    expect(svg.match(/<path /g)?.length).toBe(1)
    expect(svg.match(/<g /g)?.length).toBe(1)
    expect(svg).toContain('data-slice-plane="AXIAL"')
  })

  test('non-finite geometry never serializes as NaN', () => {
    const svg = annotationsToSVG({
      annotations: [
        makeAnn({
          polygons: [
            {
              outer: [
                { x: 0, y: 0 },
                { x: Number.NaN, y: 10 },
                { x: 10, y: Number.POSITIVE_INFINITY },
                { x: 10, y: 10 },
              ],
              holes: [],
            },
          ],
        }),
      ],
      pad: 0,
    })
    // A NaN in `d` or the viewBox makes the whole document unrenderable.
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('Infinity')
    expect(svg).toContain('<path')
  })

  test('a malformed color never serializes as NaN', () => {
    const svg = annotationsToSVG({
      annotations: [
        makeAnn({
          style: {
            fillColor: [Number.NaN, 0, 0, Number.NaN],
            strokeColor: [1, 0, 0, 1],
            strokeWidth: Number.NaN,
          },
        }),
      ],
      pad: 0,
    })
    expect(svg).not.toContain('NaN')
    // Malformed channels clamp to 0; a malformed alpha renders opaque, not invisible.
    expect(svg).toContain('fill="rgba(0,0,0,1)"')
    expect(svg).toContain('stroke-width="0"')
  })
})
