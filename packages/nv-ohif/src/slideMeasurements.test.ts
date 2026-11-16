import { expect, test } from 'bun:test'
import { NVSlideAnnotations } from '@niivue/niivue'
import { bindSlideMeasurements } from './slideMeasurements'

type Row = { uid: string; toolName: string; label: string; points: number[][] }

// OHIF's MeasurementService, as far as the bridge uses it: an add on an
// existing uid broadcasts MEASUREMENT_UPDATED, a remove MEASUREMENT_REMOVED.
function fakeMeasurementService() {
  const rows = new Map<string, Row>()
  const subs = new Map<string, Array<(p: { measurement: unknown }) => void>>()
  const emit = (e: string, measurement: unknown) => {
    for (const cb of subs.get(e) ?? []) cb({ measurement })
  }
  return {
    rows,
    EVENTS: {
      MEASUREMENT_UPDATED: 'u',
      MEASUREMENT_REMOVED: 'r',
      JUMP_TO_MEASUREMENT: 'j',
      MEASUREMENTS_CLEARED: 'c',
    },
    getMeasurement: (uid: string) => rows.get(uid),
    createSource: () => ({}),
    addMapping: () => {},
    addRawMeasurement(
      _s: unknown,
      _t: string,
      d: { measurement: Row },
      toSchema: (d: { measurement: Row }) => Row,
    ) {
      const row = toSchema(d)
      const had = rows.has(row.uid)
      rows.set(row.uid, row)
      if (had) emit('u', row)
      return row.uid
    },
    remove(uid: string) {
      if (rows.delete(uid)) emit('r', uid)
    },
    subscribe(e: string, cb: (p: { measurement: unknown }) => void) {
      subs.set(e, [...(subs.get(e) ?? []), cb])
      return { unsubscribe: () => subs.set(e, []) }
    },
    emit,
  }
}

test('slide annotations mirror as µm rows; panel edits flow back', () => {
  const ms = fakeMeasurementService()
  const annotations = new NVSlideAnnotations(() => [0.0005, 0.0005])
  const focused: string[] = []
  const unbind = bindSlideMeasurements(
    {
      annotations,
      focusAnnotation: (id) => focused.push(id),
      tool: 'Length',
    },
    { services: { measurementService: ms } } as never,
    { SeriesInstanceUID: 's', StudyInstanceUID: 't' },
  )
  // 200 px at 0.5 µm/px.
  const a = annotations.add('line', [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ]) as { id: string }
  const [row] = [...ms.rows.values()] as [Row & Record<string, never>]
  expect(row.toolName).toBe('Length')
  expect(row.points).toEqual([
    [0, 0, 0],
    [200, 0, 0],
  ])
  expect(row).toMatchObject({ displayText: { primary: ['100 µm'] } })

  ms.emit('u', { uid: row.uid, label: 'nucleus' })
  expect(annotations.get(a.id)?.label).toBe('nucleus')
  expect(ms.rows.get(row.uid)?.label).toBe('nucleus')

  ms.emit('j', { uid: row.uid })
  expect(focused).toEqual([a.id])

  ms.remove(row.uid)
  expect(annotations.list()).toEqual([])

  // Delete-all clears rows without a remove per row.
  annotations.add('point', [{ x: 1, y: 1 }])
  ms.rows.clear()
  ms.emit('c', [])
  expect(annotations.list()).toEqual([])

  annotations.add('point', [{ x: 1, y: 1 }])
  unbind()
  expect(ms.rows.size).toBe(0)
  expect(annotations.list()).toEqual([])
})
