// OHIF measurement rows from another source (a hydrated DICOM SR) shown as
// NiiVue annotations on the pane displaying their series. Each becomes a NiiVue
// annotation in the acquisition plane and its row is replaced by the NiiVue one
// (reflected from annotationAdded), so it is edited, exported and deleted like
// any NiiVue measurement.
// ponytail: Bidirectional and off-acquisition-plane rows are left to cornerstone.
import {
  type AnnotationPoint,
  type AnnotationTool,
  computeAnnotationStats,
  generateShape,
  mmToSlice2D,
  type NiiVue,
  type VectorAnnotation,
} from '@niivue/niivue'
import { useEffect } from 'react'
import { programmaticAnnotations } from './arrowText'
import { rasToLps, reflectedRowUid } from './commands'
import type { OhifServicesManager } from './ohif-types'
import { acquisitionSliceType } from './standardCommands'

export interface OhifRow {
  uid: string
  toolName?: string
  label?: string
  points?: number[][]
  referenceSeriesUID?: string
  source?: { name?: string }
}

// Depth axis (RAS index) per slice type: axial z, coronal y, sagittal x.
const DEPTH = [2, 1, 0]

const near = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) < 1e-3

// Angle (3 points, vertex in the middle) or CobbAngle (two lines): two arms in
// shape start/end and start2/end2; the angle from the world points.
function angleFromRow(
  nv: Pick<NiiVue, 'annotationStyle'>,
  row: OhifRow,
  ras: [number, number, number][],
  pts: AnnotationPoint[],
  sliceType: number,
  depth: number,
): VectorAnnotation | undefined {
  const isCobb = row.toolName === 'CobbAngle'
  const [a, b, c, d] = pts
  const [A, B, C, D] = ras
  const arm2 = isCobb ? [c, d] : [b, c]
  const w2 = isCobb ? [C, D] : [B, C]
  if (!a || !b || !arm2[0] || !arm2[1] || !A || !B || !w2[0] || !w2[1])
    return undefined
  const sub = (p: number[], q: number[]) =>
    p.map((v, i) => v - (q[i] as number))
  // Angle arms point away from the vertex.
  const u = isCobb ? sub(B, A) : sub(A, B)
  const v = sub(w2[1], w2[0])
  const dot = u.reduce((s, x, i) => s + x * (v[i] as number), 0)
  const [ux, uy, uz] = u as [number, number, number]
  const [vx, vy, vz] = v as [number, number, number]
  const cross = Math.hypot(
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  )
  const angle =
    (Math.atan2(cross, isCobb ? Math.abs(dot) : dot) * 180) / Math.PI
  const width = nv.annotationStyle.strokeWidth
  return {
    id: crypto.randomUUID(),
    label: 1,
    group: 'measurements',
    sliceType,
    slicePosition: depth,
    anchorMM: A,
    polygons: [
      ...generateShape('measureLine', a, b, width),
      ...generateShape('measureLine', arm2[0], arm2[1], width),
    ],
    style: structuredClone(nv.annotationStyle),
    shape: {
      type: isCobb ? 'measureCobbAngle' : 'measureAngle',
      start: a,
      end: b,
      start2: arm2[0],
      end2: arm2[1],
      width,
    },
    text: row.label || undefined,
    stats: { area: 0, min: 0, mean: 0, max: 0, stdDev: 0, angle },
  }
}

/** The NiiVue annotation for an OHIF row on `nv`'s acquisition plane, else undefined. */
export function annotationFromRow(
  nv: Pick<NiiVue, 'volumes' | 'annotationStyle' | 'annotationAreaIsGeometric'>,
  row: OhifRow,
): VectorAnnotation | undefined {
  const sliceType = acquisitionSliceType(nv)
  const vol = nv.volumes[0]
  if (sliceType === undefined || !vol || !row.points?.length) return undefined
  // LPS <-> RAS is its own inverse.
  const ras = row.points.map((p) =>
    rasToLps([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]),
  ) as [number, number, number][]
  const d = DEPTH[sliceType] as number
  const depth = ras[0]?.[d] ?? 0
  // One slice only: an SR row from another plane stays with cornerstone.
  if (ras.some((p) => Math.abs((p[d] as number) - depth) > 1e-3))
    return undefined
  const pts = ras.map((p) => mmToSlice2D(p, sliceType))
  const bounds = (ps: AnnotationPoint[]) => ({
    start: {
      x: Math.min(...ps.map((p) => p.x)),
      y: Math.min(...ps.map((p) => p.y)),
    },
    end: {
      x: Math.max(...ps.map((p) => p.x)),
      y: Math.max(...ps.map((p) => p.y)),
    },
  })
  const p = pts as [AnnotationPoint, ...AnnotationPoint[]]
  if (row.toolName === 'Angle' || row.toolName === 'CobbAngle')
    return angleFromRow(nv, row, ras, pts, sliceType, depth)
  let tool: AnnotationTool
  let start: AnnotationPoint
  let end: AnnotationPoint
  switch (row.toolName) {
    case 'Length':
      ;[tool, start, end] = ['measureLine', p[0], p[1] ?? p[0]]
      break
    case 'ArrowAnnotate':
      // Cornerstone's points[0] is the arrowhead; NiiVue's shape.end is.
      ;[tool, start, end] = ['arrow', p[1] ?? p[0], p[0]]
      break
    case 'Probe':
      ;[tool, start, end] = ['measurePoint', p[0], p[0]]
      break
    case 'EllipticalROI':
      // Axis endpoints (top, bottom, left, right): a rotated ellipse stays a
      // cornerstone row rather than become its axis-aligned bounds.
      if (!(near(p[0].x, p[1]?.x) && near(p[2]?.y, p[3]?.y))) return undefined
      ;({ start, end } = bounds(pts))
      tool = 'measureEllipse'
      break
    case 'RectangleROI':
      // Corners on two x and two y values only; a rotated one stays.
      if (new Set(pts.map((q) => Math.round(q.x * 1e3))).size > 2)
        return undefined
      if (new Set(pts.map((q) => Math.round(q.y * 1e3))).size > 2)
        return undefined
      ;({ start, end } = bounds(pts))
      tool = 'measureRect'
      break
    case 'CircleROI': {
      const [c, e] = [p[0], p[1] ?? p[0]]
      const r = Math.hypot(e.x - c.x, e.y - c.y)
      ;[tool, start, end] = [
        'measureCircle',
        { x: c.x - r, y: c.y - r },
        { x: c.x + r, y: c.y + r },
      ]
      break
    }
    case 'PlanarFreehandROI':
      ;({ start, end } = bounds(pts))
      tool = 'freehand'
      break
    default:
      return undefined
  }
  const width = nv.annotationStyle.strokeWidth
  const polygons =
    tool === 'freehand'
      ? [{ outer: pts, holes: [] }]
      : generateShape(tool, start, end, width)
  if (polygons.length === 0) return undefined
  const anchorMM = ras[0]
  const annotation: VectorAnnotation = {
    id: crypto.randomUUID(),
    label: 1,
    group: 'measurements',
    sliceType,
    slicePosition: depth,
    anchorMM: tool === 'measurePoint' ? anchorMM : undefined,
    polygons,
    style: structuredClone(nv.annotationStyle),
    shape: {
      type: tool,
      start,
      end,
      ...(tool === 'measureLine' || tool === 'arrow' || tool === 'measurePoint'
        ? { width }
        : {}),
    },
    text: row.label || undefined,
  }
  annotation.stats =
    computeAnnotationStats(annotation, vol, nv.annotationAreaIsGeometric) ??
    undefined
  return annotation
}

type RowService = {
  EVENTS?: Record<string, string>
  getMeasurements?: () => OhifRow[]
  getMeasurement?: (uid: string) => OhifRow | undefined
  remove?: (uid: string) => void
  subscribe?: (
    event: string,
    cb: (e: { measurement?: OhifRow }) => void,
  ) => { unsubscribe: () => void }
}

/** Take other sources' rows on `seriesUid` into `nv` once its volume is shown. */
export function useOhifRowImport(
  nv: NiiVue | null,
  seriesUid: string | undefined,
  servicesManager: OhifServicesManager | undefined,
): void {
  useEffect(() => {
    const ms = servicesManager?.services?.measurementService as
      | RowService
      | undefined
    if (!nv || !seriesUid || !ms?.remove) return
    const take = (row: OhifRow | undefined) => {
      if (!row || row.source?.name === 'NiiVue') return
      if (row.referenceSeriesUID !== seriesUid) return
      // Another pane on this series may have taken it already.
      if (ms.getMeasurement && !ms.getMeasurement(row.uid)) return
      const annotation = annotationFromRow(nv, row)
      if (!annotation) return
      // Replace the source row only once the NiiVue one exists: a failed
      // reflection keeps the original measurement.
      // Marked only for the synchronous add, so no id outlives it.
      programmaticAnnotations.add(annotation.id)
      try {
        nv.addAnnotation(annotation)
      } finally {
        programmaticAnnotations.delete(annotation.id)
      }
      if (reflectedRowUid(annotation.id)) ms.remove?.(row.uid)
      else nv.removeAnnotation(annotation.id)
    }
    for (const row of ms.getMeasurements?.() ?? []) take(row)
    const subs = [
      ms.EVENTS?.MEASUREMENT_ADDED,
      ms.EVENTS?.RAW_MEASUREMENT_ADDED,
    ].map((event) =>
      event ? ms.subscribe?.(event, (e) => take(e.measurement)) : undefined,
    )
    return () => {
      for (const sub of subs) sub?.unsubscribe()
    }
  }, [nv, seriesUid, servicesManager])
}
