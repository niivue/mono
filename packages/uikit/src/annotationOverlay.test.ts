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

  it('emits a label with the shape stats and honors alignment', () => {
    const el = shape({
      outer: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
      ],
      label: { lines: ['Area: 12.0 mm²'], x: 30, y: 5, align: 'left' },
    })
    const { text } = buildAnnotationGeometry([el])
    expect(text).toHaveLength(1)
    expect(text[0]?.str).toContain('Area')
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
