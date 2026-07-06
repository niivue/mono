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
})
