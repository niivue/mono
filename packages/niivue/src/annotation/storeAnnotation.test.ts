import { describe, expect, test } from 'bun:test'
import type { VectorAnnotation } from '@/NVTypes'
import { storeAnnotation } from './index'

function square(id: string, min: number, max: number): VectorAnnotation {
  return {
    id,
    label: 1,
    group: 'measurements',
    sliceType: 0,
    slicePosition: 0,
    polygons: [
      {
        outer: [
          { x: min, y: min },
          { x: max, y: min },
          { x: max, y: max },
          { x: min, y: max },
        ],
        holes: [],
      },
    ],
    style: {
      fillColor: [1, 0, 0, 0.3],
      strokeColor: [1, 0, 0, 1],
      strokeWidth: 2,
    },
  }
}

describe('storeAnnotation', () => {
  test('keeps overlapping annotations independent when merging is disabled', () => {
    const first = square('first', 0, 10)
    const second = square('second', 5, 15)

    const stored = storeAnnotation([first], second, false)

    expect(stored).toHaveLength(2)
    expect(stored[0]).toBe(first)
    expect(stored[1]).toBe(second)
  })

  test('preserves the default union behavior when merging is enabled', () => {
    const stored = storeAnnotation(
      [square('first', 0, 10)],
      square('second', 5, 15),
      true,
    )

    expect(stored).toHaveLength(1)
    expect(stored[0]?.id).toBe('second')
  })

  test('never merges a probe, placed or existing', () => {
    const probe = {
      ...square('probe', 4, 6),
      shape: {
        type: 'measurePoint',
        start: { x: 5, y: 5 },
        end: { x: 5, y: 5 },
      },
    } as VectorAnnotation
    const roi = square('roi', 0, 10)
    expect(storeAnnotation([roi], probe, true)).toEqual([roi, probe])
    const stored = storeAnnotation([probe], square('roi2', 0, 10), true)
    expect(stored.map((a) => a.id)).toEqual(['roi2', 'probe'])
    expect(stored[1]).toBe(probe)
  })

  test.each([
    'measureLine',
    'measureAngle',
    'measureCobbAngle',
    'bidirectional',
  ])('never merges or cuts with a %s', (type) => {
    const mark = {
      ...square('mark', 5, 20),
      shape: { type, start: { x: 5, y: 5 }, end: { x: 20, y: 20 } },
    } as VectorAnnotation
    const roi = square('roi', 0, 10)
    expect(storeAnnotation([roi], mark, true)).toEqual([roi, mark])
    expect(storeAnnotation([mark], roi, true)).toEqual([roi, mark])
  })
})
