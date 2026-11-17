// OHIF measurement rows from another source (a hydrated DICOM SR) shown as
// NiiVue annotations on the pane displaying their series. Each becomes a NiiVue
// annotation in the acquisition plane and its row is replaced by the NiiVue one
// (reflected from annotationAdded), so it is edited, exported and deleted like
// any NiiVue measurement. NiiVue rows a pane released (unmount, series swap)
// come back the same way under their own uid.
// ponytail: off-axis (oblique) rows are left to cornerstone.
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
import {
  adoptedRowUids,
  claimPendingJump,
  isReleasedRow,
  jumpToNiivueMeasurement,
  onRowsReleased,
  rasToLps,
  reflectedRowUid,
} from './commands'
import { type NiivueViewportEntry, niivueEntries } from './niivueRegistry'
import type { OhifServicesManager } from './ohif-types'
import { acquisitionSliceType } from './standardCommands'

export interface OhifRow {
  uid: string
  toolName?: string
  label?: string
  points?: number[][]
  referenceSeriesUID?: string
  source?: { name?: string }
  metadata?: { sliceType?: number }
}

// Depth axis (RAS index) per slice type: axial z, coronal y, sagittal x.
const DEPTH = [2, 1, 0]

// OHIF contour rows: their points are the outline NiiVue stores.
const CONTOUR_TOOLS: Record<string, AnnotationTool> = {
  PlanarFreehandROI: 'freehand',
  SplineROI: 'measureSpline',
  LivewireContour: 'measureLivewire',
}

const near = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) < 1e-3

// Angle (3 points, vertex in the middle), CobbAngle or Bidirectional (two
// lines): two arms in shape start/end and start2/end2; the angle or the axis
// lengths from the world points.
function twoLineFromRow(
  nv: Pick<NiiVue, 'annotationStyle'>,
  row: OhifRow,
  ras: [number, number, number][],
  pts: AnnotationPoint[],
  sliceType: number,
  depth: number,
): VectorAnnotation | undefined {
  const isAngle = row.toolName === 'Angle'
  const isBidirectional = row.toolName === 'Bidirectional'
  let [a, b, c, d] = pts
  let [A, B, C, D] = ras
  const sub = (p: number[], q: number[]) =>
    p.map((v, i) => v - (q[i] as number))
  // The long axis first, whatever order the source wrote.
  if (
    isBidirectional &&
    A &&
    B &&
    C &&
    D &&
    Math.hypot(...sub(C, D)) > Math.hypot(...sub(A, B))
  )
    [a, b, c, d, A, B, C, D] = [c, d, a, b, C, D, A, B]
  const arm2 = isAngle ? [b, c] : [c, d]
  const w2 = isAngle ? [B, C] : [C, D]
  if (!a || !b || !arm2[0] || !arm2[1] || !A || !B || !w2[0] || !w2[1])
    return undefined
  // Angle arms point away from the vertex.
  const u = isAngle ? sub(A, B) : sub(B, A)
  const v = sub(w2[1], w2[0])
  const dot = u.reduce((s, x, i) => s + x * (v[i] as number), 0)
  const [ux, uy, uz] = u as [number, number, number]
  const [vx, vy, vz] = v as [number, number, number]
  const cross = Math.hypot(
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  )
  const stats = isBidirectional
    ? { length: Math.hypot(...u), shortLength: Math.hypot(...v) }
    : {
        angle:
          (Math.atan2(cross, isAngle ? dot : Math.abs(dot)) * 180) / Math.PI,
      }
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
      type: isBidirectional
        ? 'measureBidirectional'
        : isAngle
          ? 'measureAngle'
          : 'measureCobbAngle',
      start: a,
      end: b,
      start2: arm2[0],
      end2: arm2[1],
      width,
    },
    text: row.label || undefined,
    stats: { area: 0, min: 0, mean: 0, max: 0, stdDev: 0, ...stats },
  }
}

/**
 * The NiiVue annotation for an OHIF row on the axial, coronal or sagittal
 * plane holding all its points (a NiiVue row's own plane, then the acquisition
 * plane, first), else undefined.
 */
export function annotationFromRow(
  nv: Pick<NiiVue, 'volumes' | 'annotationStyle' | 'annotationAreaIsGeometric'>,
  row: OhifRow,
): VectorAnnotation | undefined {
  const vol = nv.volumes[0]
  if (!vol || !row.points?.length) return undefined
  // LPS <-> RAS is its own inverse.
  const ras = row.points.map((p) =>
    rasToLps([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]),
  ) as [number, number, number][]
  const onPlane = (t: number) =>
    ras.every(
      (p) =>
        Math.abs(
          (p[DEPTH[t] as number] as number) -
            (ras[0]?.[DEPTH[t] as number] as number),
        ) < 1e-3,
    )
  // A NiiVue row's own plane first, then the acquisition plane.
  const sliceType = [
    row.metadata?.sliceType,
    acquisitionSliceType(nv),
    0,
    1,
    2,
  ].find((t) => t !== undefined && onPlane(t))
  if (sliceType === undefined) return undefined
  const depth = ras[0]?.[DEPTH[sliceType] as number] ?? 0
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
  if (
    row.toolName === 'Angle' ||
    row.toolName === 'CobbAngle' ||
    row.toolName === 'Bidirectional'
  )
    return twoLineFromRow(nv, row, ras, pts, sliceType, depth)
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
    case 'SplineROI':
    case 'LivewireContour':
      ;({ start, end } = bounds(pts))
      tool = CONTOUR_TOOLS[row.toolName] as AnnotationTool
      break
    default:
      return undefined
  }
  const width = nv.annotationStyle.strokeWidth
  const polygons =
    row.toolName && row.toolName in CONTOUR_TOOLS
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

// Released rows mid-adoption: adding one broadcasts it synchronously, and it
// stays released until that add returns.
const adopting = new Set<string>()

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
    const take = (
      row: OhifRow | undefined,
      releasing?: NiivueViewportEntry['nv'],
    ) => {
      if (!row) return
      // NiiVue rows are this or another pane's, unless released by one.
      const released = isReleasedRow(row.uid)
      if (row.source?.name === 'NiiVue' && !released) return
      if (adopting.has(row.uid)) return
      if (row.referenceSeriesUID !== seriesUid) return
      // Not a pane already swapping to another series (its effect re-runs).
      const entries = [...niivueEntries()]
      const own = entries.find((e) => e.nv === nv)
      if (own?.displaySets[0]?.SeriesInstanceUID !== seriesUid) return
      // Another pane on this series may have taken it already.
      if (ms.getMeasurement && !ms.getMeasurement(row.uid)) return
      const annotation = annotationFromRow(nv, row)
      if (!annotation) return
      // Leave it to a pane on the series showing its plane (MPR), if any.
      if (nv.sliceType !== annotation.sliceType)
        for (const e of entries)
          if (
            e.nv !== nv &&
            e.nv !== releasing &&
            e.nv.sliceType === annotation.sliceType &&
            e.displaySets[0]?.SeriesInstanceUID === seriesUid
          )
            return
      // Replace the source row only once the NiiVue one exists: a failed
      // reflection keeps the original measurement. A released row is
      // reflected under its own uid, so jumps and tracking keep pointing at it.
      // Marked only for the synchronous add, so no id outlives it.
      programmaticAnnotations.add(annotation.id)
      if (released) {
        adoptedRowUids.set(annotation.id, row.uid)
        adopting.add(row.uid)
      }
      try {
        nv.addAnnotation(annotation)
      } finally {
        programmaticAnnotations.delete(annotation.id)
        adoptedRowUids.delete(annotation.id)
        adopting.delete(row.uid)
      }
      if (!reflectedRowUid(annotation.id)) nv.removeAnnotation(annotation.id)
      else if (!released) ms.remove?.(row.uid)
      else if (claimPendingJump(row.uid))
        jumpToNiivueMeasurement(row.uid, servicesManager)
    }
    const scan = (releasing?: NiivueViewportEntry['nv']) => {
      for (const row of ms.getMeasurements?.() ?? []) take(row, releasing)
    }
    scan()
    // Not the releasing pane itself: it is unmounting or swapping series.
    const unsubscribeReleased = onRowsReleased((from) => {
      if (from !== nv) scan(from)
    })
    const subs = [
      ms.EVENTS?.MEASUREMENT_ADDED,
      ms.EVENTS?.RAW_MEASUREMENT_ADDED,
    ].map((event) =>
      event ? ms.subscribe?.(event, (e) => take(e.measurement)) : undefined,
    )
    return () => {
      unsubscribeReleased()
      for (const sub of subs) sub?.unsubscribe()
    }
  }, [nv, seriesUid, servicesManager])
}
