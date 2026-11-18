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

// Review of #856: setPoints validates before it records an undo step.
describe('NVSlideAnnotations.setPoints', () => {
  const spacing = () => undefined
  test('too few points leave the annotation and history alone', () => {
    const a = new NVSlideAnnotations(spacing)
    const r = a.add('rectangle', [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
    ])
    expect(a.setPoints(r?.id ?? '', [])).toBe(false)
    expect(a.annotationUndoTop).toBeUndefined()
    expect(a.get(r?.id ?? '')?.points).toHaveLength(2)
  })
  // Holistic review H6: a line with 3 points measured one length, drew another.
  test('fixed-count tools take exactly their points', () => {
    const a = new NVSlideAnnotations(spacing)
    const three = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]
    expect(a.add('line', three)).toBeNull()
    const id = a.add('line', three.slice(0, 2))?.id ?? ''
    expect(a.setPoints(id, three)).toBe(false)
    expect(a.add('freehandLine', three)).not.toBeNull()
  })
  test('a history listener that removes it gets no change', () => {
    const a = new NVSlideAnnotations(spacing)
    const id =
      a.add('rectangle', [
        { x: 0, y: 0 },
        { x: 2, y: 2 },
      ])?.id ?? ''
    const changed: string[] = []
    a.addEventListener('annotationHistoryPush', () => a.remove(id))
    a.addEventListener('changed', () => changed.push(id))
    const moved = [
      { x: 0, y: 0 },
      { x: 4, y: 4 },
    ]
    expect(a.setPoints(id, moved)).toBe(false)
    expect(changed).toEqual([])
    // Nor an undo step that would revert nothing.
    expect(a.annotationUndoTop).toBeUndefined()
  })
  test('an abandoned setPoints keeps the redo history', () => {
    const a = new NVSlideAnnotations(spacing)
    const box = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
    ]
    const keep = a.add('rectangle', box)?.id ?? ''
    const gone = a.add('rectangle', box)?.id ?? ''
    a.setPoints(keep, [
      { x: 0, y: 0 },
      { x: 3, y: 3 },
    ])
    a.annotationUndo()
    const redo = a.annotationRedoTop
    expect(redo).toBeDefined()
    a.addEventListener('annotationHistoryPush', () => a.remove(gone))
    expect(a.setPoints(gone, box)).toBe(false)
    expect(a.annotationRedoTop).toBe(redo)
  })

  test('undo reverts an edit that only appends a vertex', () => {
    const a = new NVSlideAnnotations(spacing)
    const tri = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ]
    const id = a.add('polygon', tri)?.id ?? ''
    a.setPoints(id, [...tri, { x: 4, y: 4 }])
    a.annotationUndo()
    expect(a.get(id)?.points).toEqual(tri)
    a.annotationRedo()
    expect(a.get(id)?.points).toHaveLength(4)
  })
})
