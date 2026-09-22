import { describe, expect, it } from 'bun:test'
import type { AnnotationScreenShape } from '@niivue/niivue'
import { buildAnnotationGeometry } from './annotationOverlay'

const style = {
  fillColor: [1, 0, 0, 0.3] as [number, number, number, number],
  strokeColor: [1, 0.85, 0, 1] as [number, number, number, number],
  strokeWidth: 2,
}

function shape(over: Partial<AnnotationScreenShape>): AnnotationScreenShape {
  return {
    id: 'a',
    tool: 'measureEllipse',
    outer: [],
    holes: [],
    isClosed: true,
    style,
    ...over,
  }
}

describe('buildAnnotationGeometry', () => {
  it('draws a closed shape as an outline loop (one segment per edge)', () => {
    const rect = shape({
      tool: 'measureRect',
      outer: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    })
    const { lines } = buildAnnotationGeometry([rect])
    expect(lines).toHaveLength(4) // closed loop over 4 points
  })

  it('draws an arrow with an arrowhead (more than the bare shaft)', () => {
    const arrow = shape({
      tool: 'arrow',
      isClosed: false,
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
    })
    const { lines } = buildAnnotationGeometry([arrow])
    expect(lines.length).toBeGreaterThan(1)
  })

  it('draws a measureLine without a length as a single plain segment', () => {
    const line = shape({
      tool: 'measureLine',
      isClosed: false,
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
    })
    const { lines } = buildAnnotationGeometry([line])
    expect(lines).toHaveLength(1)
  })

  it('draws a measured line as a graduated ruler (baseline + end caps + ticks + mm label)', () => {
    const ruler = shape({
      tool: 'measureLine',
      isClosed: false,
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
      length: 20,
    })
    const { lines, text } = buildAnnotationGeometry([ruler])
    // Baseline + 2 end caps + one tick per mm — far more than a bare segment.
    expect(lines.length).toBeGreaterThan(3)
    // The ruler renders its own length label (mm), separate from any free text.
    expect(text.some((t) => t.str.includes('mm'))).toBe(true)
  })

  it('keeps a measured line label to the user free text (ruler draws the mm)', () => {
    const ruler = shape({
      tool: 'measureLine',
      isClosed: false,
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
      length: 20,
      label: { lines: ['Tumor'], x: 10, y: -8, align: 'center' },
    })
    const { text } = buildAnnotationGeometry([ruler])
    expect(text.some((t) => t.str === 'Tumor')).toBe(true)
    expect(text.some((t) => t.str.includes('20'))).toBe(true)
  })

  it('centers a closed ROI label below its bounding box (ignores seam anchor)', () => {
    const el = shape({
      outer: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ],
      // The seam's off-to-the-side left-aligned anchor must be overridden.
      label: { lines: ['Area: 12.0 mm²'], x: 30, y: 5, align: 'left' },
    })
    const { text } = buildAnnotationGeometry([el], { dpr: 1, labelCssPx: 14 })
    expect(text).toHaveLength(1)
    expect(text[0]?.str).toContain('Area')
    // Centered on the bbox center x (2), center-aligned.
    expect(text[0]?.x).toBe(2)
    expect(text[0]?.align).toBe(0.5)
    // Baseline below the bottom edge (maxY=4): 4 + gap(4) + ascent(14 * 0.8).
    expect(text[0]?.y).toBeCloseTo(4 + 4 + 14 * 0.8, 5)
  })

  it('stacks a multi-line closed ROI label centered below the box', () => {
    const el = shape({
      outer: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ],
      label: {
        lines: ['ROI #1', 'Area: 12.0 mm²', 'Mean: 5.0'],
        x: 30,
        y: 5,
        align: 'left',
      },
    })
    const { text } = buildAnnotationGeometry([el], { dpr: 1, labelCssPx: 10 })
    // One text item per line, all centered on the bbox center x.
    expect(text).toHaveLength(3)
    for (const t of text) {
      expect(t.x).toBe(2)
      expect(t.align).toBe(0.5)
    }
    // Stacked with a constant line height (labelPx * 1.3 = 13).
    expect((text[1]?.y ?? 0) - (text[0]?.y ?? 0)).toBeCloseTo(13, 5)
    expect((text[2]?.y ?? 0) - (text[1]?.y ?? 0)).toBeCloseTo(13, 5)
    // First line just below the bottom edge (maxY=4): 4 + gap(4) + ascent(10*0.8).
    expect(text[0]?.y).toBeCloseTo(4 + 4 + 10 * 0.8, 5)
  })

  it('honors the seam label anchor + alignment for an OPEN shape', () => {
    const line = shape({
      tool: 'measureLine',
      isClosed: false,
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
      label: { lines: ['Tumor'], x: 30, y: 5, align: 'left' },
    })
    const { text } = buildAnnotationGeometry([line])
    expect(text[0]?.x).toBe(30)
    expect(text[0]?.align).toBe(0)
  })

  it('scales stroke + label size by dpr', () => {
    const el = shape({
      outer: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
      ],
      label: { lines: ['x'], x: 0, y: 0, align: 'center' },
    })
    const { text } = buildAnnotationGeometry([el], { dpr: 2, labelCssPx: 14 })
    expect(text[0]?.sizePx).toBe(28)
    expect(text[0]?.align).toBe(0.5)
  })
})
