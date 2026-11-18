import { getControlPoints, updateShapeBounds } from '@/annotation/selection'
import { generateShape } from '@/annotation/shapes'
import { AnnotationUndoStack } from '@/annotation/undoRedo'
import type { NVSlidePoint } from './slideController'

/**
 * Slide annotation tools and the points each stores (slide base pixels):
 * point [p]; line [start, end]; rectangle and ellipse [corner, opposite
 * corner], axis aligned; circle [centre, rim point]; polygon, freehand
 * (closed) and freehandLine (open) their vertices.
 */
export type SlideAnnotationTool =
  | 'point'
  | 'line'
  | 'rectangle'
  | 'ellipse'
  | 'circle'
  | 'polygon'
  | 'freehand'
  | 'freehandLine'

/**
 * Physical size in `unit` (mm, area mm^2) from the slide's pixel spacing, or
 * base pixels without it. Open shapes have `length`, closed `area` and
 * `perimeter`, a point none.
 */
export interface SlideAnnotationStats {
  unit: 'mm' | 'px'
  length?: number
  area?: number
  perimeter?: number
}

export interface SlideAnnotation {
  id: string
  tool: SlideAnnotationTool
  points: NVSlidePoint[]
  label: string
  stats: SlideAnnotationStats
}

type Spacing = readonly [number, number] | undefined

/** The fewest points each tool needs. */
const SLIDE_ANNOTATION_MIN_POINTS: Record<SlideAnnotationTool, number> = {
  point: 1,
  line: 2,
  rectangle: 2,
  ellipse: 2,
  circle: 2,
  polygon: 3,
  freehand: 3,
  freehandLine: 2,
}

export const isClosedSlideTool = (tool: SlideAnnotationTool): boolean =>
  tool !== 'point' && tool !== 'line' && tool !== 'freehandLine'

/**
 * The outline drawn for an annotation, in slide pixels: an ellipse or circle
 * as a 64-gon (its stats use the true curve), a rectangle as its 4 corners.
 */
export function slideAnnotationOutline(
  tool: SlideAnnotationTool,
  points: readonly NVSlidePoint[],
): NVSlidePoint[] {
  const [a, b] = points as [NVSlidePoint, NVSlidePoint]
  if (tool === 'rectangle')
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
  if (tool === 'ellipse' || tool === 'circle') {
    const r = Math.hypot(b.x - a.x, b.y - a.y)
    const [s, e] =
      tool === 'circle'
        ? [
            { x: a.x - r, y: a.y - r },
            { x: a.x + r, y: a.y + r },
          ]
        : [a, b]
    return generateShape('ellipse', s, e, 0)[0]?.outer ?? []
  }
  return [...points]
}

// Rectangle, ellipse and circle as the volume shapes' boxes, so their handles
// and drags are the volume annotations'.
type BoxTool = 'rectangle' | 'ellipse' | 'circle'
const isBoxTool = (tool: SlideAnnotationTool): tool is BoxTool =>
  tool === 'rectangle' || tool === 'ellipse' || tool === 'circle'

function boxOf(type: BoxTool, points: readonly NVSlidePoint[]) {
  const [a, b] = points as [NVSlidePoint, NVSlidePoint]
  if (type !== 'circle') return { type, start: a, end: b }
  const r = Math.hypot(b.x - a.x, b.y - a.y)
  return {
    type,
    start: { x: a.x - r, y: a.y - r },
    end: { x: a.x + r, y: a.y + r },
  }
}

/**
 * Edit handles in slide pixels: a rectangle's corners and sides, an ellipse's
 * or circle's cardinal points (as volume annotations), a point's, line's or
 * polygon's own points; none for freehand.
 */
export function slideAnnotationHandles(
  tool: SlideAnnotationTool,
  points: readonly NVSlidePoint[],
): NVSlidePoint[] {
  if (isBoxTool(tool)) return getControlPoints(boxOf(tool, points))
  return tool.startsWith('freehand') ? [] : points.map(({ x, y }) => ({ x, y }))
}

/** `points` with handle `index` (of {@link slideAnnotationHandles}) dragged to `to`. */
export function dragSlideAnnotationHandle(
  tool: SlideAnnotationTool,
  points: readonly NVSlidePoint[],
  index: number,
  to: NVSlidePoint,
): NVSlidePoint[] {
  if (!isBoxTool(tool))
    return points.map((p, i) => (i === index ? { ...to } : { ...p }))
  const { start, end } = updateShapeBounds(tool, boxOf(tool, points), index, to)
  if (tool !== 'circle') return [start, end]
  const c = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  return [c, { x: c.x + Math.abs(end.x - start.x) / 2, y: c.y }]
}

function pathLength(
  points: readonly NVSlidePoint[],
  closed: boolean,
  sx: number,
  sy: number,
): number {
  let sum = 0
  const n = points.length
  for (let i = closed ? 0 : 1; i < n; i++) {
    const p = points[(i + n - 1) % n] as NVSlidePoint
    const q = points[i] as NVSlidePoint
    sum += Math.hypot((q.x - p.x) * sx, (q.y - p.y) * sy)
  }
  return sum
}

/** An annotation's {@link SlideAnnotationStats}, each axis scaled by its spacing. */
export function slideAnnotationStats(
  tool: SlideAnnotationTool,
  points: readonly NVSlidePoint[],
  spacingMM?: Spacing,
): SlideAnnotationStats {
  const [sx, sy] = spacingMM ?? [1, 1]
  const unit = spacingMM ? 'mm' : 'px'
  if (tool === 'point') return { unit }
  if (!isClosedSlideTool(tool))
    return { unit, length: pathLength(points, false, sx, sy) }
  if (tool === 'ellipse' || tool === 'circle') {
    const [a, b] = points as [NVSlidePoint, NVSlidePoint]
    const r = Math.hypot(b.x - a.x, b.y - a.y)
    const [rx, ry] =
      tool === 'circle'
        ? [r * sx, r * sy]
        : [(Math.abs(b.x - a.x) / 2) * sx, (Math.abs(b.y - a.y) / 2) * sy]
    // Ramanujan's second approximation: exact for a circle, ~1e-5 relative otherwise.
    const h = ((rx - ry) / (rx + ry || 1)) ** 2
    const perimeter =
      Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
    return { unit, area: Math.PI * rx * ry, perimeter }
  }
  const ring = slideAnnotationOutline(tool, points)
  // Relative to the first vertex: products of large base-pixel coordinates
  // cancel catastrophically.
  const o = ring[0] ?? { x: 0, y: 0 }
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[j] as NVSlidePoint
    const q = ring[i] as NVSlidePoint
    twice += (p.x - o.x) * (q.y - o.y) - (q.x - o.x) * (p.y - o.y)
  }
  return {
    unit,
    area: (Math.abs(twice) / 2) * sx * sy,
    perimeter: pathLength(ring, true, sx, sy),
  }
}

export type SlideAnnotationEvent = CustomEvent<SlideAnnotation>

// Callers get copies: editing one must not change stored geometry behind stats and events.
function copyOf(a: SlideAnnotation): SlideAnnotation {
  return {
    ...a,
    points: a.points.map(({ x, y }) => ({ x, y })),
    stats: { ...a.stats },
  }
}

/**
 * A slide's annotations, in base pixels so they hold at every level. Events
 * `added`, `changed` (label or points) and `removed` carry the annotation as
 * `detail`. Stats use the spacing in force when the points were last set.
 * Point edits are undoable steps, announced as NiiVue's are
 * (`annotationHistoryPush`, `annotationUndoTop`, `annotationUndo`).
 */
export class NVSlideAnnotations extends EventTarget {
  private readonly _items = new Map<string, SlideAnnotation>()
  private readonly _spacing: () => Spacing
  private _next = 1
  private readonly _history = Object.assign(
    new AnnotationUndoStack<SlideAnnotation[]>(),
    {
      onPush: (seq: number) =>
        this.dispatchEvent(
          new CustomEvent('annotationHistoryPush', { detail: { seq } }),
        ),
    },
  )

  /** `spacingMM`: the slide's pixel spacing (`manifest.pixelSpacingMM`), if any. */
  constructor(spacingMM: () => Spacing) {
    super()
    this._spacing = spacingMM
  }

  list(): SlideAnnotation[] {
    return [...this._items.values()].map(copyOf)
  }

  get(id: string): SlideAnnotation | undefined {
    const annotation = this._items.get(id)
    return annotation && copyOf(annotation)
  }

  /** Add an annotation (e.g. restored from a store); null with too few points. */
  add(
    tool: SlideAnnotationTool,
    points: readonly NVSlidePoint[],
    label = '',
  ): SlideAnnotation | null {
    if (points.length < SLIDE_ANNOTATION_MIN_POINTS[tool]) return null
    const copy = points.map(({ x, y }) => ({ x, y }))
    const annotation: SlideAnnotation = {
      id: `slide-annotation-${this._next++}`,
      tool,
      points: copy,
      label,
      stats: slideAnnotationStats(tool, copy, this._spacing()),
    }
    this._items.set(annotation.id, annotation)
    this._emit('added', annotation)
    return copyOf(annotation)
  }

  remove(id: string): boolean {
    const annotation = this._items.get(id)
    if (!annotation) return false
    this._items.delete(id)
    this._emit('removed', annotation)
    return true
  }

  setLabel(id: string, label: string): boolean {
    const annotation = this._items.get(id)
    if (!annotation) return false
    annotation.label = label
    this._emit('changed', annotation)
    return true
  }

  /** Replace an annotation's points (an edit), recorded as one undo step. */
  setPoints(id: string, points: readonly NVSlidePoint[]): boolean {
    const annotation = this._items.get(id)
    if (!annotation) return false
    this._history.push(this.list())
    this._setPoints(annotation, points)
    return true
  }

  /** Sequence number of the step annotationUndo would revert. */
  get annotationUndoTop(): number | undefined {
    return this._history.undoTop
  }

  /** Sequence number of the step annotationRedo would reapply. */
  get annotationRedoTop(): number | undefined {
    return this._history.redoTop
  }

  annotationUndo(): void {
    this._restore(this._history.undo(this.list()))
  }

  annotationRedo(): void {
    this._restore(this._history.redo(this.list()))
  }

  clear(): void {
    for (const id of [...this._items.keys()]) this.remove(id)
    this._history.clear()
  }

  // Only edits are steps: points go back by id, so annotations added or
  // removed since are left as they are.
  private _restore(snapshot: SlideAnnotation[] | null): void {
    for (const { id, points } of snapshot ?? []) {
      const annotation = this._items.get(id)
      if (
        annotation &&
        points.some(
          (p, i) =>
            p.x !== annotation.points[i]?.x || p.y !== annotation.points[i]?.y,
        )
      )
        this._setPoints(annotation, points)
    }
  }

  private _setPoints(
    annotation: SlideAnnotation,
    points: readonly NVSlidePoint[],
  ): void {
    annotation.points = points.map(({ x, y }) => ({ x, y }))
    annotation.stats = slideAnnotationStats(
      annotation.tool,
      annotation.points,
      this._spacing(),
    )
    this._emit('changed', annotation)
  }

  private _emit(type: string, detail: SlideAnnotation): void {
    this.dispatchEvent(new CustomEvent(type, { detail: copyOf(detail) }))
  }
}
