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

// Contour segmentation: segments are groups; measurements must stay whole.
describe('storeAnnotation group policy', () => {
  const inGroup = (a: VectorAnnotation, group: string, label = 1) => ({
    ...a,
    group,
    label,
  })
  const area = (a: VectorAnnotation | undefined) =>
    (a?.polygons ?? []).reduce((sum, p) => {
      let twice = 0
      for (let i = 0, j = p.outer.length - 1; i < p.outer.length; j = i++) {
        const [u, v] = [p.outer[j], p.outer[i]] as [
          { x: number; y: number },
          { x: number; y: number },
        ]
        twice += u.x * v.y - v.x * u.y
      }
      return sum + Math.abs(twice) / 2
    }, 0)

  test('a shape never cuts or merges another group', () => {
    const measurement = inGroup(square('m', 0, 10), 'measurements', 2)
    const stored = storeAnnotation(
      [measurement],
      inGroup(square('s', 5, 15), 'seg'),
      true,
    )
    expect(stored[0]).toBe(measurement)
    expect(stored).toHaveLength(2)
  })

  test('mergedGroups limits merging to its groups', () => {
    const a = inGroup(square('a', 0, 10), 'measurements')
    const stored = storeAnnotation(
      [a],
      inGroup(square('b', 5, 15), 'measurements'),
      true,
      {
        mergedGroups: ['seg'],
      },
    )
    expect(stored).toHaveLength(2)
    const seg = storeAnnotation(
      [inGroup(a, 'seg')],
      inGroup(square('b', 5, 15), 'seg'),
      true,
      {
        mergedGroups: ['seg'],
      },
    )
    expect(seg).toHaveLength(1)
    expect(area(seg[0])).toBeCloseTo(175, 6)
  })

  test('a locked shape is not cut; the new one is clipped around it', () => {
    const locked = inGroup(square('locked', 0, 10), 'seg', 2)
    const stored = storeAnnotation(
      [locked],
      inGroup(square('new', 5, 15), 'seg', 1),
      true,
      {
        isEditable: (a) => a.id !== 'locked',
      },
    )
    expect(stored[0]).toBe(locked)
    expect(area(stored[1])).toBeCloseTo(75, 6)
  })
})
