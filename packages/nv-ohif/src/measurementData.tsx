import {
  type NiiVue,
  type NVSlideAnnotations,
  slice2DToMM,
  type VectorAnnotation,
} from '@niivue/niivue'
import { useEffect, useState } from 'react'
import {
  areaUnit,
  calibrateStats,
  calibrationEvents,
  lengthUnit,
  paneScale,
} from './calibration'
import { isContourAnnotation } from './contourSeg'
import { probeIndex } from './measurementReflection'
import { slideRowTool, slideRowValues } from './slideMeasurements'
import { ANNOTATION_TO_OHIF } from './toolBridge'

type Row = {
  id: string
  /** OHIF's tool name for this annotation (e.g. Length), as its panel row. */
  toolName?: string
  /** The annotation's free text, as the row label. */
  label?: string
  /** A point on the annotation in canvas CSS px, for a test to click it. */
  anchor?: { x: number; y: number }
  values: Record<string, number | string>
}

// A shape's start-end midpoint (on a line, inside an ROI), else its first vertex.
function anchorOf(nv: NiiVue, a: VectorAnnotation) {
  const s = a.shape
  const p = s
    ? { x: (s.start.x + s.end.x) / 2, y: (s.start.y + s.end.y) / 2 }
    : a.polygons[0]?.outer[0]
  const c = p && nv.mmToCanvas(slice2DToMM(p, a.slicePosition, a.sliceType))
  const dpr = nv.effectiveDevicePixelRatio
  return c ? { x: c.x / dpr, y: c.y / dpr } : undefined
}

/** A volume pane's rows, as MeasurementData lists them (exported for tests). */
export const snapshot = (
  nv: NiiVue,
  unit: string,
  viewportId: string,
): Row[] => {
  const scale = paneScale(viewportId)
  return nv.annotations
    .filter((a) => !isContourAnnotation(a))
    .map((a) => {
      const type = a.shape?.type ?? 'freehand'
      const stats = calibrateStats(a.stats, scale)
      const values: Row['values'] = { ...stats }
      if (stats && !stats.length) values.modalityUnit = unit
      if (scale !== 1) {
        values.lengthUnit = lengthUnit(scale)
        values.areaUnit = areaUnit(scale)
      }
      // Cornerstone names a bidirectional's short axis its width.
      if (stats?.shortLength !== undefined) values.width = stats.shortLength
      // Cornerstone's Probe reports the voxel's image index too ("i,j,k").
      const index = probeIndex(viewportId, a)
      if (index) values.index = index.join(',')
      // Cornerstone's CircleROI reports its radius too.
      if (a.shape && (type === 'circle' || type === 'measureCircle')) {
        values.radius = (Math.abs(a.shape.end.x - a.shape.start.x) / 2) * scale
        values.radiusUnit = lengthUnit(scale)
      }
      return {
        id: a.id,
        toolName: ANNOTATION_TO_OHIF[type]?.toolName,
        label: a.text,
        anchor: anchorOf(nv, a),
        values,
      }
    })
}

// Slide annotations: values in µm (px without pixel spacing), no anchor.
const slideSnapshot = (slide: NVSlideAnnotations): Row[] =>
  slide.list().map((a) => ({
    id: a.id,
    toolName: slideRowTool(slide, a),
    label: a.label,
    values: slideRowValues(a).data,
  }))

/**
 * Each annotation's measured values as hidden DOM (`data-*` in kebab case, mm
 * and `modalityUnit` intensities), so tests can compare them with
 * cornerstone's: NiiVue draws its labels on the canvas, where nothing can
 * read them. A slide pane lists its `slide` annotations.
 */
export function MeasurementData({
  nv,
  slide,
  viewportId,
  unit = '',
}: {
  nv: NiiVue | null
  slide?: NVSlideAnnotations
  viewportId: string
  unit?: string
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [slideRows, setSlideRows] = useState<Row[]>([])
  useEffect(() => {
    if (!slide) return setSlideRows([])
    const update = () => setSlideRows(slideSnapshot(slide))
    update()
    const events = ['added', 'changed', 'removed']
    for (const e of events) slide.addEventListener(e, update)
    return () => {
      for (const e of events) slide.removeEventListener(e, update)
    }
  }, [slide])
  useEffect(() => {
    if (!nv) return
    const update = () => setRows(snapshot(nv, unit, viewportId))
    update()
    nv.addEventListener('annotationChanged', update)
    calibrationEvents.addEventListener('change', update)
    // Anchors are canvas px: a resized pane (a panel opening) moves them.
    // NiiVue relays out on its next render, so read them two frames later.
    const ro = nv.canvas
      ? new ResizeObserver(() =>
          requestAnimationFrame(() => requestAnimationFrame(update)),
        )
      : undefined
    if (nv.canvas) ro?.observe(nv.canvas)
    return () => {
      nv.removeEventListener('annotationChanged', update)
      calibrationEvents.removeEventListener('change', update)
      ro?.disconnect()
    }
  }, [nv, unit, viewportId])
  return (
    <div hidden data-measurements="">
      {[...rows, ...slideRows].map((r) => (
        <span
          key={r.id}
          data-annotation-id={r.id}
          data-tool-name={r.toolName}
          data-label={r.label}
          data-x={r.anchor?.x}
          data-y={r.anchor?.y}
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
