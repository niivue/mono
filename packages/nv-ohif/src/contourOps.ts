// OHIF's contour utilities (Combine, Simplify, Smooth; the panel's Duplicate)
// on a NiiVue contour segmentation: per slice, on its segments' shapes, each
// one undo step (replaceAnnotations).
import {
  type AnnotationPoint,
  type NiiVue,
  type PolygonWithHoles,
  polygonBoolean,
  type VectorAnnotation,
} from '@niivue/niivue'
import { contourGroup, contourPane } from './contourSeg'
import { getActiveNiivueEntry, ohifServices } from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'
import { invertAffine, rasGrid } from './quantify'

const DEPTH_AXIS = [2, 1, 0] // axial, coronal, sagittal

/** A shape's voxel depth along its slice axis, unrounded; undefined without a grid. */
export function voxelDepth(
  nv: NiiVue,
  a: Pick<VectorAnnotation, 'sliceType' | 'anchorMM'>,
): number | undefined {
  const base = nv.volumes[0]
  const grid = base && rasGrid(base)
  const at = a.anchorMM
  if (!grid || !at) return undefined
  const m = invertAffine(grid.affine)
  const d = (DEPTH_AXIS[a.sliceType] as number) * 4
  return (
    (m[d] as number) * at[0] +
    (m[d + 1] as number) * at[1] +
    (m[d + 2] as number) * at[2] +
    (m[d + 3] as number)
  )
}

/** A shape's slice: its plane and voxel depth (an oblique slice's mm depth varies). */
export function sliceOf(
  nv: NiiVue,
  a: Pick<VectorAnnotation, 'sliceType' | 'anchorMM' | 'slicePosition'>,
): string {
  const depth = voxelDepth(nv, a)
  return depth === undefined
    ? `${a.sliceType}:${a.slicePosition.toFixed(3)}`
    : `${a.sliceType}:${Math.round(depth)}`
}

type Slices = Map<string, { a: VectorAnnotation[]; b: VectorAnnotation[] }>

function slicesOf(
  nv: NiiVue,
  group: string,
  labelA: number,
  labelB = Number.NaN,
): Slices {
  const slices: Slices = new Map()
  for (const s of nv.annotations) {
    if (s.group !== group || (s.label !== labelA && s.label !== labelB))
      continue
    const key = sliceOf(nv, s)
    const at = slices.get(key) ?? { a: [], b: [] }
    // Both operands when A and B are one segment (OHIF's Combine allows it).
    if (s.label === labelA) at.a.push(s)
    if (s.label === labelB) at.b.push(s)
    slices.set(key, at)
  }
  return slices
}

const polygons = (shapes: VectorAnnotation[]) =>
  shapes.flatMap((s) => s.polygons)

/** One shape of `label` in `template`'s slice and style, or none when empty. */
function shape(
  template: VectorAnnotation,
  label: number,
  polys: PolygonWithHoles[],
): VectorAnnotation[] {
  if (polys.length === 0) return []
  const { stats: _stats, text: _text, shape: _shape, ...rest } = template
  return [{ ...rest, id: crypto.randomUUID(), label, polygons: polys }]
}

/** Edit every slice of one segment: `fn` maps its polygons to new ones. */
function editSegment(
  nv: NiiVue,
  segmentationId: string,
  label: number,
  fn: (polys: PolygonWithHoles[]) => PolygonWithHoles[],
): void {
  const removed: VectorAnnotation[] = []
  const added: VectorAnnotation[] = []
  for (const { a } of slicesOf(
    nv,
    contourGroup(segmentationId),
    label,
  ).values()) {
    const template = a[0]
    if (!template) continue
    removed.push(...a)
    added.push(...shape(template, label, fn(polygons(a))))
  }
  nv.replaceAnnotations(
    removed.map((s) => s.id),
    added,
    true,
  )
}

export type LogicalOperation = 'union' | 'difference' | 'intersection'

/**
 * OHIF's Combine Contours: segment `a` op segment `b` into segment `result`
 * (replaced, whichever it is), slice by slice.
 */
export function combineSegments(
  nv: NiiVue,
  segmentationId: string,
  a: number,
  b: number,
  result: number,
  op: LogicalOperation,
): void {
  const group = contourGroup(segmentationId)
  const removed = nv.annotations.filter(
    (s) => s.group === group && s.label === result,
  )
  const added: VectorAnnotation[] = []
  for (const slice of slicesOf(nv, group, a, b).values()) {
    const template = slice.a[0] ?? slice.b[0]
    if (!template) continue
    const out = polygonBoolean(op, polygons(slice.a), polygons(slice.b))
    added.push(...shape(template, result, out))
  }
  nv.replaceAnnotations(
    removed.map((s) => s.id),
    added,
    true,
  )
}

/** The panel's Duplicate: segment `from`'s shapes copied to segment `to`. */
export function copySegment(
  nv: NiiVue,
  segmentationId: string,
  from: number,
  to: number,
): void {
  const group = contourGroup(segmentationId)
  const added = nv.annotations
    .filter((s) => s.group === group && s.label === from)
    .flatMap((s) => shape(s, to, s.polygons))
  nv.replaceAnnotations([], added, true)
}

/** Simplify: drop a segment's holes (Fill contour holes). */
export function fillHoles(
  nv: NiiVue,
  segmentationId: string,
  label: number,
): void {
  editSegment(nv, segmentationId, label, (polys) =>
    polys.map((p) => ({ outer: p.outer, holes: [] })),
  )
}

/** Simplify: drop a segment's pieces smaller than `minArea` mm² (Remove Small Contours). */
export function removeSmall(
  nv: NiiVue,
  segmentationId: string,
  label: number,
  minArea: number,
): void {
  editSegment(nv, segmentationId, label, (polys) =>
    polys.filter((p) => ringArea(p.outer) >= minArea),
  )
}

/** Simplify: a segment's holes become segment `to`'s shapes; the holes stay. */
export function holesToSegment(
  nv: NiiVue,
  segmentationId: string,
  from: number,
  to: number,
): void {
  const group = contourGroup(segmentationId)
  const added = nv.annotations
    .filter((s) => s.group === group && s.label === from)
    .flatMap((s) =>
      shape(
        s,
        to,
        s.polygons.flatMap((p) =>
          p.holes.map((h) => ({ outer: h, holes: [] })),
        ),
      ),
    )
  nv.replaceAnnotations([], added, true)
}

/** Smooth: each ring through every third point as a closed Catmull-Rom curve. */
export function smoothSegment(
  nv: NiiVue,
  segmentationId: string,
  label: number,
): void {
  editSegment(nv, segmentationId, label, (polys) =>
    polys.map((p) => ({
      outer: smoothRing(p.outer),
      holes: p.holes.map(smoothRing),
    })),
  )
}

/** Remove extra points: Ramer-Douglas-Peucker within 0.1 mm. */
export function decimateSegment(
  nv: NiiVue,
  segmentationId: string,
  label: number,
): void {
  editSegment(nv, segmentationId, label, (polys) =>
    polys.map((p) => ({
      outer: decimateRing(p.outer, 0.1),
      holes: p.holes.map((h) => decimateRing(h, 0.1)),
    })),
  )
}

export function ringArea(r: readonly AnnotationPoint[]): number {
  let twice = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const p = r[i] as AnnotationPoint
    const q = r[j] as AnnotationPoint
    twice += q.x * p.y - p.x * q.y
  }
  return Math.abs(twice) / 2
}

// As cornerstone's smoothContours: knots at 30% of the points.
const KNOT_STEP = 3

// Knots by arc length: a sparse ring's (a decimated square's) are its corners.
const SPACING_MM = 1

function densify(ring: readonly AnnotationPoint[]): AnnotationPoint[] {
  const out: AnnotationPoint[] = []
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] as AnnotationPoint
    const q = ring[(i + 1) % ring.length] as AnnotationPoint
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / SPACING_MM),
    )
    for (let k = 0; k < steps; k++)
      out.push({
        x: p.x + ((q.x - p.x) * k) / steps,
        y: p.y + ((q.y - p.y) * k) / steps,
      })
  }
  return out
}

export function smoothRing(
  ring: readonly AnnotationPoint[],
): AnnotationPoint[] {
  const knots = densify(ring).filter((_, i) => i % KNOT_STEP === 0)
  const n = knots.length
  if (n < 4) return [...ring]
  const out: AnnotationPoint[] = []
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [i - 1, i, i + 1, i + 2].map(
      (k) => knots[(k + n) % n] as AnnotationPoint,
    ) as [AnnotationPoint, AnnotationPoint, AnnotationPoint, AnnotationPoint]
    for (let s = 0; s < KNOT_STEP; s++) {
      const t = s / KNOT_STEP
      const t2 = t * t
      const t3 = t2 * t
      const at = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (c - a) * t +
          (2 * a - 5 * b + 4 * c - d) * t2 +
          (3 * b - a - 3 * c + d) * t3)
      out.push({
        x: at(p0.x, p1.x, p2.x, p3.x),
        y: at(p0.y, p1.y, p2.y, p3.y),
      })
    }
  }
  return out
}

export function decimateRing(
  ring: readonly AnnotationPoint[],
  epsilon: number,
): AnnotationPoint[] {
  if (ring.length < 4) return [...ring]
  const keep = new Uint8Array(ring.length)
  // Closed: split at the first point and the point farthest from it.
  let far = 0
  let farD = -1
  const first = ring[0] as AnnotationPoint
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i] as AnnotationPoint
    const d = (p.x - first.x) ** 2 + (p.y - first.y) ** 2
    if (d > farD) [far, farD] = [i, d]
  }
  keep[0] = keep[far] = 1
  const stack: [number, number][] = [
    [0, far],
    [far, ring.length],
  ]
  while (stack.length) {
    const [lo, hi] = stack.pop() as [number, number]
    const a = ring[lo] as AnnotationPoint
    const b = ring[hi % ring.length] as AnnotationPoint
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    let worst = -1
    let worstD = epsilon
    for (let i = lo + 1; i < hi; i++) {
      const p = ring[i] as AnnotationPoint
      const d =
        Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len
      if (d > worstD) [worst, worstD] = [i, d]
    }
    if (worst < 0) continue
    keep[worst] = 1
    stack.push([lo, worst], [worst, hi])
  }
  return ring.filter((_, i) => keep[i])
}

type Options = Record<string, unknown>
type SegmentInfo = { segmentationId: string; segmentIndex: number }
type Service = {
  getActiveSegmentation(
    viewportId: string,
  ): { segmentationId: string } | undefined
  getActiveSegment(viewportId: string): { segmentIndex: number } | undefined
  getNextAvailableSegmentIndex(segmentationId: string): number
  addSegment(segmentationId: string, config: { segmentIndex: number }): void
}
// cornerstone's contourSegmentation.LogicalOperation
const LOGICAL: Record<number, LogicalOperation> = {
  0: 'union',
  1: 'difference',
  2: 'intersection',
}

/**
 * The contour utilities' commands for the NIIVUE context: on a NiiVue contour
 * segmentation they edit its shapes; otherwise `back` runs cornerstone's.
 */
export function contourOpCommands(
  servicesManager: OhifExtensionParams['servicesManager'],
  back: (name: string, opts: Options) => unknown,
) {
  const service = () =>
    ohifServices(servicesManager)?.segmentationService as Service | undefined
  // The active viewport's active NiiVue contour segment, if any.
  const active = () => {
    const entry = getActiveNiivueEntry(servicesManager)
    const svc = service()
    const id =
      entry && svc?.getActiveSegmentation(entry.viewportId)?.segmentationId
    const pane = contourPane(id)
    const index = entry && svc?.getActiveSegment(entry.viewportId)?.segmentIndex
    return pane && id && index !== undefined
      ? { nv: pane.nv, id, index, svc: svc as Service, pane }
      : undefined
  }
  const onActive =
    (
      name: string,
      fn: (s: NonNullable<ReturnType<typeof active>>, o: Options) => void,
      edits = true,
    ) =>
    (opts: Options = {}) => {
      const s = active()
      if (!s) return orBack(name, opts)
      // An op that rewrites the active segment leaves a locked one as it is.
      if (!edits || !s.pane.isLocked(s.index)) fn(s, opts)
    }
  // On a NiiVue pane a segmentation that is not a NiiVue contour one (a SEG
  // or RTSTRUCT labelmap) has no contours: nothing to do, and cornerstone's
  // ops would look for a cornerstone viewport.
  const orBack = (name: string, opts: Options) =>
    getActiveNiivueEntry(servicesManager) ? undefined : back(name, opts)
  const newSegment = (svc: Service, id: string) => {
    const segmentIndex = svc.getNextAvailableSegmentIndex(id)
    svc.addSegment(id, { segmentIndex })
    return segmentIndex
  }
  return {
    applyLogicalContourOperation: {
      commandFn: (opts: Options = {}) => {
        const a = opts.segmentAInfo as SegmentInfo | undefined
        const b = opts.segmentBInfo as SegmentInfo | undefined
        const r = opts.resultSegmentInfo as SegmentInfo | undefined
        const op = LOGICAL[opts.logicalOperation as number]
        const pane = contourPane(a?.segmentationId)
        if (!pane || !a || !b || !r || !op)
          return orBack('applyLogicalContourOperation', opts)
        // One segmentation's segments only.
        if (b.segmentationId !== a.segmentationId) return
        if (r.segmentationId !== a.segmentationId) return
        if (pane.isLocked(r.segmentIndex)) return
        combineSegments(
          pane.nv,
          a.segmentationId,
          a.segmentIndex,
          b.segmentIndex,
          r.segmentIndex,
          op,
        )
      },
    },
    copyContourSegment: {
      commandFn: (opts: Options = {}) => {
        const from = opts.sourceSegmentInfo as SegmentInfo | undefined
        const pane = contourPane(from?.segmentationId)
        const svc = service()
        if (!pane || !from || !svc) return orBack('copyContourSegment', opts)
        const target = (opts.targetSegmentInfo as SegmentInfo | undefined)
          ?.segmentIndex
        if (target !== undefined && pane.isLocked(target)) return
        const to = target ?? newSegment(svc, from.segmentationId)
        copySegment(pane.nv, from.segmentationId, from.segmentIndex, to)
      },
    },
    smoothContours: {
      commandFn: onActive('smoothContours', (s) =>
        smoothSegment(s.nv, s.id, s.index),
      ),
    },
    decimateContours: {
      commandFn: onActive('decimateContours', (s) =>
        decimateSegment(s.nv, s.id, s.index),
      ),
    },
    removeContourHoles: {
      commandFn: onActive('removeContourHoles', (s) =>
        fillHoles(s.nv, s.id, s.index),
      ),
    },
    removeSmallContours: {
      commandFn: onActive('removeSmallContours', (s, o) =>
        removeSmall(s.nv, s.id, s.index, Number(o.areaThreshold ?? 3)),
      ),
    },
    convertContourHoles: {
      commandFn: onActive(
        'convertContourHoles',
        (s) => holesToSegment(s.nv, s.id, s.index, newSegment(s.svc, s.id)),
        false, // reads the active segment, writes a new one
      ),
    },
  }
}
