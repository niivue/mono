import { describe, expect, it } from 'bun:test'
import type { AnnotationScreenShape } from '@niivue/niivue'
import { shapesSignature } from './volumeAnnotationOverlay'

const shape = (dx = 0, label = 'ROI #1'): AnnotationScreenShape =>
  ({
    id: 'a',
    polygons: [
      {
        outer: [
          { x: 10 + dx, y: 10 },
          { x: 20 + dx, y: 10 },
          { x: 15 + dx, y: 20 },
        ],
        holes: [],
      },
    ],
    start: { x: 10 + dx, y: 10 },
    end: { x: 20 + dx, y: 20 },
    tool: 'measureLine',
    isClosed: false,
    style: {
      fillColor: [1, 0, 0, 0.2],
      strokeColor: [1, 0, 0, 1],
      strokeWidth: 2,
    },
    label: { lines: [label], x: 0, y: 0, align: 'left' },
  }) as unknown as AnnotationScreenShape

describe('shapesSignature (#124)', () => {
  it('is stable for identical and sub-pixel-jittered shapes', () => {
    expect(shapesSignature([shape()])).toBe(shapesSignature([shape()]))
    expect(shapesSignature([shape(0.4)])).toBe(shapesSignature([shape()]))
  })

  it('changes on a 1px move, a label edit, a ruler length, or an added shape', () => {
    const base = shapesSignature([shape()])
    expect(shapesSignature([shape(1)])).not.toBe(base)
    expect(shapesSignature([shape(0, 'ROI #2')])).not.toBe(base)
    expect(shapesSignature([shape(), shape()])).not.toBe(base)
    expect(shapesSignature([])).not.toBe(base)
    expect(shapesSignature([{ ...shape(), length: 10.3 }])).not.toBe(
      shapesSignature([{ ...shape(), length: 10.4 }]),
    )
  })

  it('changes on a hundredth-mm ruler length the ruler can show', () => {
    expect(shapesSignature([{ ...shape(), length: 3.41 }])).not.toBe(
      shapesSignature([{ ...shape(), length: 3.44 }]),
    )
  })

  it('changes when the ruler unit changes', () => {
    const ruler = { ...shape(), length: 2 }
    expect(shapesSignature([{ ...ruler, unit: 'um' }])).not.toBe(
      shapesSignature([ruler]),
    )
  })

  it('tags length and label so one cannot alias the other', () => {
    const noLabel = { ...shape(), label: undefined }
    // Untagged, length 0 and one empty label line both hash as mix(0).
    const withLength = { ...noLabel, length: 0 }
    const withLabel = {
      ...noLabel,
      label: { lines: [''], x: 0, y: 0, align: 'left' as const },
    }
    expect(shapesSignature([withLength])).not.toBe(shapesSignature([withLabel]))
  })

  it('changes on a style, label anchor, tool, or tile change', () => {
    const base = shapesSignature([shape()])
    const s = shape()
    expect(
      shapesSignature([
        { ...s, style: { ...s.style, strokeColor: [0, 1, 0, 1] } },
      ]),
    ).not.toBe(base)
    expect(
      shapesSignature([{ ...s, style: { ...s.style, strokeWidth: 3 } }]),
    ).not.toBe(base)
    expect(
      shapesSignature([
        { ...s, style: { ...s.style, fillColor: [1, 0, 0, 0.5] } },
      ]),
    ).not.toBe(base)
    expect(
      shapesSignature([
        { ...s, label: { lines: ['ROI #1'], x: 40, y: 0, align: 'left' } },
      ]),
    ).not.toBe(base)
    expect(
      shapesSignature([
        { ...s, label: { lines: ['ROI #1'], x: 0, y: 0, align: 'center' } },
      ]),
    ).not.toBe(base)
    expect(shapesSignature([{ ...s, tool: 'arrow' }])).not.toBe(base)
    expect(shapesSignature([{ ...s, tileIndex: 1 }])).not.toBe(base)
  })
})
