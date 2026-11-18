import { describe, expect, test } from 'bun:test'
import {
  NVSlideAnnotations,
  slideAnnotationOutline,
  slideAnnotationStats,
} from './slideAnnotations'

const sp = [0.002, 0.001] as const

describe('slideAnnotationStats', () => {
  test('scales each axis by its spacing', () => {
    const line = slideAnnotationStats(
      'freehandLine',
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      sp,
    )
    expect(line.length).toBeCloseTo(0.03)
    const box = slideAnnotationStats(
      'rectangle',
      [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ],
      sp,
    )
    expect(box.area).toBeCloseTo(0.0004)
    expect(box.perimeter).toBeCloseTo(0.08)
    expect(box.unit).toBe('mm')
  })

  // Review of #836: far from the origin, the shoelace products cancel.
  test('area holds at large base-pixel coordinates', () => {
    const at = 1e9
    const square = slideAnnotationStats(
      'polygon',
      [
        { x: at, y: at },
        { x: at + 10, y: at },
        { x: at + 10, y: at + 10 },
        { x: at, y: at + 10 },
      ],
      undefined,
    )
    expect(square.area).toBe(100)
  })

  test('ellipse and circle use the true curve', () => {
    const e = slideAnnotationStats('ellipse', [
      { x: 0, y: 0 },
      { x: 20, y: 10 },
    ])
    expect(e).toMatchObject({ unit: 'px', area: Math.PI * 50 })
    expect(e.perimeter).toBeCloseTo(48.4422, 3)
    const c = slideAnnotationStats('circle', [
      { x: 5, y: 5 },
      { x: 8, y: 9 },
    ])
    expect(c.area).toBeCloseTo(Math.PI * 25)
    expect(c.perimeter).toBeCloseTo(Math.PI * 10)
  })

  test('a sub-pixel ellipse still has an outline', () => {
    const ring = slideAnnotationOutline('ellipse', [
      { x: 0, y: 0 },
      { x: 0.3, y: 0.2 },
    ])
    expect(ring.length).toBeGreaterThan(2)
  })
})

test('NVSlideAnnotations adds, relabels and removes with events', () => {
  const store = new NVSlideAnnotations(() => undefined)
  const events: string[] = []
  for (const t of ['added', 'changed', 'removed'])
    store.addEventListener(t, (e) =>
      events.push(`${t} ${(e as CustomEvent).detail.label}`),
    )
  expect(store.add('polygon', [{ x: 0, y: 0 }])).toBeNull()
  const a = store.add('point', [{ x: 1, y: 2 }], 'nucleus')
  expect(store.setLabel(a?.id ?? '', 'mitosis')).toBe(true)
  expect(store.remove(a?.id ?? '')).toBe(true)
  expect(store.list()).toEqual([])
  expect(events).toEqual([
    'added nucleus',
    'changed mitosis',
    'removed mitosis',
  ])
})

test('NVSlideAnnotations hands out copies, so callers cannot edit stored geometry', () => {
  const store = new NVSlideAnnotations(() => undefined)
  const added = store.add('line', [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ])
  const id = added?.id ?? ''
  const got = store.get(id)
  if (got?.points[1]) got.points[1].x = 100
  const listed = store.list()[0]
  if (listed?.points[1]) listed.points[1].x = 100
  if (added?.points[1]) added.points[1].x = 100
  expect(store.get(id)?.points[1]?.x).toBe(10)
  expect(store.get(id)?.stats.length).toBe(10)
})
