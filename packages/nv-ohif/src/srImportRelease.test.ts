import { expect, mock, test } from 'bun:test'

// useOhifRowImport runs its effect at once.
mock.module('react', () => ({ useEffect: (f: () => unknown) => void f() }))
const { generateShape } = await import('@niivue/niivue')
const { reflectNiivueAnnotation, clearNiivueAnnotations, isReleasedRow } =
  await import('./commands')
const { registerNiivue, unregisterNiivue, updateNiivueViewport } = await import(
  './niivueRegistry'
)
const { useOhifRowImport: importRows } = await import('./srImport')

const mkNv = (sliceType: number) => {
  const added: unknown[] = []
  return {
    sliceType,
    volumes: [{ permRAS: [1, 2, 3] }],
    annotationStyle: {
      fillColor: [1, 0, 0, 1],
      strokeColor: [1, 0, 0, 1],
      strokeWidth: 1,
    },
    annotationAreaIsGeometric: true,
    annotations: [],
    added,
    addAnnotation: (a: unknown): void => {
      added.push(a)
    },
    removeAnnotation: () => {},
  }
}

test('MPR: closing the axial pane hands its row to the coronal pane on the series', () => {
  const ds = {
    SeriesInstanceUID: 'series',
    displaySetInstanceUID: 'ds',
    instances: [{ FrameOfReferenceUID: 'for' }],
  }
  const rows = new Map<string, Record<string, unknown>>()
  const ms = {
    EVENTS: {},
    createSource: (name: string) => ({ name }),
    addMapping: () => {},
    addRawMeasurement: (
      s: { name: string },
      _t: unknown,
      d: unknown,
      convert: (d: unknown) => Record<string, unknown>,
    ) => {
      const row: Record<string, unknown> = { ...convert(d), source: s }
      rows.set(row.uid as string, row)
      return row.uid
    },
    getMeasurement: (uid: string) => rows.get(uid),
    getMeasurements: () => [...rows.values()],
    remove: (uid: string) => rows.delete(uid),
    subscribe: () => ({ unsubscribe: () => {} }),
  }
  const sm = {
    services: {
      measurementService: ms,
      displaySetService: { getDisplaySetsForSeries: () => [ds] },
    },
  } as never
  const axial = mkNv(0)
  const coronal = mkNv(1)
  registerNiivue('A', axial as never)
  updateNiivueViewport('A', { displaySets: [ds] as never })
  registerNiivue('B', coronal as never)
  updateNiivueViewport('B', { displaySets: [ds] as never })
  const line = {
    id: 'line',
    label: 1,
    group: 'measurements',
    sliceType: 0,
    slicePosition: 5,
    style: axial.annotationStyle,
    shape: {
      type: 'measureLine',
      start: { x: 10, y: 20 },
      end: { x: 20, y: 25 },
      width: 1,
    },
    polygons: generateShape(
      'measureLine',
      { x: 10, y: 20 },
      { x: 20, y: 25 },
      1,
    ),
    stats: { area: 0, min: 0, mean: 0, max: 0, stdDev: 0, length: 10 },
  }
  try {
    expect(reflectNiivueAnnotation('A', sm, line as never)).toBe(true)
    importRows(coronal as never, 'series', sm)
    // Pane A unmounts, in NiivueViewport's cleanup order.
    clearNiivueAnnotations('A', sm)
    unregisterNiivue('A')
    const uid = [...rows.keys()][0] as string
    expect(isReleasedRow(uid)).toBe(true)
    expect(coronal.added.length).toBe(1)
  } finally {
    unregisterNiivue('A')
    unregisterNiivue('B')
  }
})

test('a released row adopted by one pane is not adopted again by its broadcast', () => {
  const ds = {
    SeriesInstanceUID: 's2',
    displaySetInstanceUID: 'ds2',
    instances: [{ FrameOfReferenceUID: 'for' }],
  }
  const rows = new Map<string, Record<string, unknown>>()
  const subs: Array<(e: { measurement?: Record<string, unknown> }) => void> = []
  const ms = {
    EVENTS: { RAW_MEASUREMENT_ADDED: 'raw' },
    createSource: (name: string) => ({ name }),
    addMapping: () => {},
    addRawMeasurement: (
      s: { name: string },
      _t: unknown,
      d: unknown,
      convert: (d: unknown) => Record<string, unknown>,
    ) => {
      const row: Record<string, unknown> = { ...convert(d), source: s }
      rows.set(row.uid as string, row)
      // OHIF broadcasts synchronously, before the add returns.
      for (const f of [...subs]) f({ measurement: row })
      return row.uid
    },
    getMeasurement: (uid: string) => rows.get(uid),
    getMeasurements: () => [...rows.values()],
    remove: (uid: string) => rows.delete(uid),
    subscribe: (_: string, f: (typeof subs)[number]) => {
      subs.push(f)
      return { unsubscribe: () => subs.splice(subs.indexOf(f), 1) }
    },
  }
  const sm = {
    services: {
      measurementService: ms,
      displaySetService: { getDisplaySetsForSeries: () => [ds] },
    },
  } as never
  // Panes reflect what they add, as NiivueViewport's annotation hook does.
  const pane = (id: string, sliceType: number) => {
    const nv = mkNv(sliceType)
    nv.addAnnotation = (a: unknown) => {
      nv.added.push(a)
      reflectNiivueAnnotation(id, sm, a as never)
    }
    registerNiivue(id, nv as never)
    updateNiivueViewport(id, { displaySets: [ds] as never })
    return nv
  }
  const first = pane('X', 1)
  const c1 = pane('Y', 1)
  const c2 = pane('Z', 1)
  const line = {
    id: 'line2',
    label: 1,
    group: 'measurements',
    sliceType: 1,
    slicePosition: 5,
    style: first.annotationStyle,
    shape: {
      type: 'measureLine',
      start: { x: 10, y: 20 },
      end: { x: 20, y: 25 },
      width: 1,
    },
    polygons: generateShape(
      'measureLine',
      { x: 10, y: 20 },
      { x: 20, y: 25 },
      1,
    ),
    stats: { area: 0, min: 0, mean: 0, max: 0, stdDev: 0, length: 10 },
  }
  try {
    expect(reflectNiivueAnnotation('X', sm, line as never)).toBe(true)
    importRows(c1 as never, 's2', sm)
    importRows(c2 as never, 's2', sm)
    clearNiivueAnnotations('X', sm)
    unregisterNiivue('X')
    expect(c1.added.length + c2.added.length).toBe(1)
  } finally {
    for (const id of ['X', 'Y', 'Z']) unregisterNiivue(id)
  }
})
