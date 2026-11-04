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
})
