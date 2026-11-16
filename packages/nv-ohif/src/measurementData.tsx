import type { NiiVue } from '@niivue/niivue'
import { useEffect, useState } from 'react'
import { probeIndex } from './commands'
import { ANNOTATION_TO_OHIF } from './toolBridge'

type Row = {
  id: string
  /** OHIF's tool name for this annotation (e.g. Length), as its panel row. */
  toolName?: string
  values: Record<string, number | string>
}

const snapshot = (nv: NiiVue, unit: string, viewportId: string): Row[] =>
  nv.annotations.map((a) => {
    const type = a.shape?.type ?? 'freehand'
    const values: Row['values'] = { ...a.stats }
    if (a.stats && !a.stats.length) values.modalityUnit = unit
    // Cornerstone's Probe reports the voxel's image index too ("i,j,k").
    const index = probeIndex(viewportId, a)
    if (index) values.index = index.join(',')
    // Cornerstone's CircleROI reports its radius too.
    if (a.shape && (type === 'circle' || type === 'measureCircle')) {
      values.radius = Math.abs(a.shape.end.x - a.shape.start.x) / 2
      values.radiusUnit = 'mm'
    }
    return { id: a.id, toolName: ANNOTATION_TO_OHIF[type]?.toolName, values }
  })

/**
 * Each annotation's measured values as hidden DOM (`data-*` in kebab case, mm
 * and `modalityUnit` intensities), so tests can compare them with
 * cornerstone's: NiiVue draws its labels on the canvas, where nothing can
 * read them.
 */
export function MeasurementData({
  nv,
  viewportId,
  unit = '',
}: {
  nv: NiiVue | null
  viewportId: string
  unit?: string
}) {
  const [rows, setRows] = useState<Row[]>([])
  useEffect(() => {
    if (!nv) return
    const update = () => setRows(snapshot(nv, unit, viewportId))
    update()
    const events = ['annotationAdded', 'annotationRemoved', 'annotationChanged']
    for (const e of events) nv.addEventListener(e, update)
    return () => {
      for (const e of events) nv.removeEventListener(e, update)
    }
  }, [nv, unit, viewportId])
  return (
    <div hidden data-measurements="">
      {rows.map((r) => (
        <span
          key={r.id}
          data-annotation-id={r.id}
          data-tool-name={r.toolName}
          {...Object.fromEntries(
            Object.entries(r.values).map(([k, v]) => [
              `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
              v,
            ]),
          )}
        />
      ))}
    </div>
  )
}
