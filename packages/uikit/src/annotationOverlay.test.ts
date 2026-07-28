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

  it('draws a plain line as a single segment', () => {
    const line = shape({
      tool: 'measureLine',
      isClosed: false,
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
    })
    const { lines } = buildAnnotationGeometry([line])
    expect(lines).toHaveLength(1)
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
