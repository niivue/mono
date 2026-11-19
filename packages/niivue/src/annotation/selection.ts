import type {
  AnnotationPoint,
  AnnotationTool,
  PolygonWithHoles,
  VectorAnnotation,
} from '@/NVTypes'

export type AnnotationSelection = {
  annotationId: string
  controlPoints: AnnotationPoint[]
}

export type ShapeBoundsUpdate = {
  start: AnnotationPoint
  end: AnnotationPoint
  width?: number
  /** Second line of a two-line shape (bidirectional, angle). */
  start2?: AnnotationPoint
  end2?: AnnotationPoint
}

export function getAnnotationSelection(
  annotation: VectorAnnotation,
): AnnotationSelection {
  return {
    annotationId: annotation.id,
    controlPoints: annotation.shape ? getControlPoints(annotation.shape) : [],
  }
}

/**
 * Returns control points placed directly on the shape.
 *
 * Rectangle (8): 4 corners + 4 edge midpoints
 * Ellipse (4): cardinal points on the ellipse curve
 * Line/Arrow (3): start, end, + side handle for thickness
 * Measure line (2): start, end (its thickness is not drawn or measured)
 * Bidirectional, Cobb angle (4): start, end, start2, end2
 * Angle (3): start, vertex, end2
 */
export function getControlPoints(shape: {
  type: AnnotationTool
  start: AnnotationPoint
  end: AnnotationPoint
  width?: number
  start2?: AnnotationPoint
  end2?: AnnotationPoint
}): AnnotationPoint[] {
  // A two-line shape still being drawn has no second line and no handles.
  if (isTwoLineShape(shape.type)) {
    const { start, end, start2, end2 } = shape
    if (!start2 || !end2) return []
    // An angle's vertex is both `end` and `start2`: one handle.
    const points =
      shape.type === 'measureAngle'
        ? [start, end, end2]
        : [start, end, start2, end2]
    return points.map((p) => ({ ...p }))
  }
  switch (shape.type) {
    case 'rectangle':
    case 'measureRect': {
      const { minX, maxX, minY, maxY } = _bounds(shape)
      const midX = (minX + maxX) / 2
      const midY = (minY + maxY) / 2
      return [
        { x: minX, y: minY }, // 0: TL
        { x: maxX, y: minY }, // 1: TR
        { x: maxX, y: maxY }, // 2: BR
        { x: minX, y: maxY }, // 3: BL
        { x: midX, y: minY }, // 4: top-mid
        { x: maxX, y: midY }, // 5: right-mid
        { x: midX, y: maxY }, // 6: bottom-mid
        { x: minX, y: midY }, // 7: left-mid
      ]
    }
    case 'ellipse':
    case 'measureEllipse':
    case 'circle':
    case 'measureCircle': {
      const cx = (shape.start.x + shape.end.x) / 2
      const cy = (shape.start.y + shape.end.y) / 2
      const rx = Math.abs(shape.end.x - shape.start.x) / 2
      const ry = Math.abs(shape.end.y - shape.start.y) / 2
      return [
        { x: cx, y: cy - ry }, // 0: top
        { x: cx + rx, y: cy }, // 1: right
        { x: cx, y: cy + ry }, // 2: bottom
        { x: cx - rx, y: cy }, // 3: left
      ]
    }
    case 'line':
    case 'arrow':
    case 'measureLine': {
      const hw = (shape.width ?? 2) / 2
      const midX = (shape.start.x + shape.end.x) / 2
      const midY = (shape.start.y + shape.end.y) / 2
      const dx = shape.end.x - shape.start.x
      const dy = shape.end.y - shape.start.y
      const len = Math.sqrt(dx * dx + dy * dy)
      // Perpendicular offset for the width handle
      const px = len > 1e-9 ? (-dy / len) * hw : hw
      const py = len > 1e-9 ? (dx / len) * hw : 0
      const ends = [
        { x: shape.start.x, y: shape.start.y }, // 0: start/tail
        { x: shape.end.x, y: shape.end.y }, // 1: end/tip
      ]
      if (shape.type === 'measureLine') return ends
      return [...ends, { x: midX + px, y: midY + py }] // 2: width handle
    }
    case 'measurePoint':
      return [{ x: shape.end.x, y: shape.end.y }]
    default:
      return []
  }
}

export function hitTestControlPoint(
  point: AnnotationPoint,
  controlPoints: AnnotationPoint[],
  hitRadius: number,
): number {
  for (let i = 0; i < controlPoints.length; i++) {
    const cp = controlPoints[i] as AnnotationPoint
    const dx = point.x - cp.x
    const dy = point.y - cp.y
    if (dx * dx + dy * dy <= hitRadius * hitRadius) return i
  }
  return -1
}

/**
 * Recompute shape bounds when a control point is dragged.
 *
 * Rectangle corners (0-3): opposite corner stays fixed.
 * Rectangle sides (4-7): constrain one axis.
 * Ellipse cardinals (0-3): move the corresponding edge.
 * Line/Arrow 0-1: move that endpoint.
 * Line/Arrow 2: adjust width (perpendicular distance to line).
 */
export function updateShapeBounds(
  shapeType: AnnotationTool,
  original: ShapeBoundsUpdate,
  controlPointIndex: number,
  newPosition: AnnotationPoint,
): ShapeBoundsUpdate {
  switch (shapeType) {
    case 'bidirectional':
    case 'measureBidirectional':
      return _updateBidirectional(original, controlPointIndex, newPosition)
    case 'measureAngle':
    case 'measureCobbAngle': {
      const p = getControlPoints({ type: shapeType, ...original })
      p[controlPointIndex] = newPosition
      const [start, end, a, b] = p as AnnotationPoint[]
      // An angle's vertex (end) starts its second arm.
      return shapeType === 'measureAngle'
        ? { start, end, width: original.width, start2: end, end2: a }
        : { start, end, width: original.width, start2: a, end2: b }
    }
    case 'rectangle':
    case 'measureRect':
      return _updateRectangle(original, controlPointIndex, newPosition)
    case 'ellipse':
    case 'measureEllipse':
      return _updateEdge(original, controlPointIndex, newPosition)
    case 'circle':
    case 'measureCircle':
      return _updateCircle(original, controlPointIndex, newPosition)
    case 'line':
    case 'arrow':
    case 'measureLine':
      return _updateLineArrow(original, controlPointIndex, newPosition)
    case 'measurePoint':
      return {
        start: { ...newPosition },
        end: { ...newPosition },
        width: original.width,
      }
    default:
      return { start: { ...original.start }, end: { ...original.end } }
  }
}

export function isTwoLineShape(type: AnnotationTool): boolean {
  return (
    type === 'bidirectional' ||
    type === 'measureBidirectional' ||
    type === 'measureAngle' ||
    type === 'measureCobbAngle'
  )
}

/**
 * Cornerstone's bidirectional handles. A long-axis end (0, 1) turns the long
 * axis about the other end and carries the short axis with it: same fraction
 * along the long axis, same distances off it. A short-axis end (2, 3) slides
 * the short axis along the long axis to the pointer and sets its own distance
 * off it; the short axis keeps its angle and keeps crossing the long axis.
 */
function _updateBidirectional(
  original: ShapeBoundsUpdate,
  idx: number,
  pos: AnnotationPoint,
): ShapeBoundsUpdate {
  const { start, end, width, start2 = start, end2 = end } = original
  // Long-axis frame: origin start, unit u along it, n across it.
  const frame = (a: AnnotationPoint, b: AnnotationPoint) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const u =
      len > 1e-9
        ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
        : { x: 1, y: 0 }
    return { a, len, u, n: { x: -u.y, y: u.x } }
  }
  const f = frame(start, end)
  const along = (p: AnnotationPoint) =>
    (p.x - start.x) * f.u.x + (p.y - start.y) * f.u.y
  const across = (p: AnnotationPoint) =>
    (p.x - start.x) * f.n.x + (p.y - start.y) * f.n.y
  // Each short end: its fraction along the long axis and distance off it
  // (equal fractions for a perpendicular short axis; an imported or dragged
  // one may be skewed, and keeps its skew).
  const frac = (p: AnnotationPoint) => (f.len > 1e-9 ? along(p) / f.len : 0.5)
  let [t1, d1] = [frac(start2), across(start2)]
  let [t2, d2] = [frac(end2), across(end2)]
  let s = start
  let e = end
  if (idx === 0) s = pos
  else if (idx === 1) e = pos
  else {
    // The dragged end follows the pointer and the other slides along with it,
    // clamped so the axes still cross: the dragged end not across the long
    // axis to the other end's side, and the crossing (not the dragged end,
    // which a skewed short axis offsets) not past a long-axis end.
    const dt = frac(pos) - (idx === 2 ? t1 : t2)
    t1 += dt
    t2 += dt
    const keepSide = (d: number, was: number) =>
      was < 0 ? Math.min(0, d) : Math.max(0, d)
    if (idx === 2) d1 = keepSide(across(pos), d1)
    else d2 = keepSide(across(pos), d2)
    const cross = d1 === d2 ? t1 : t1 + ((t2 - t1) * d1) / (d1 - d2)
    const shift = Math.min(1, Math.max(0, cross)) - cross
    t1 += shift
    t2 += shift
  }
  const g = frame(s, e)
  const at = (t: number, d: number) => ({
    x: s.x + (e.x - s.x) * t + g.n.x * d,
    y: s.y + (e.y - s.y) * t + g.n.y * d,
  })
  return { start: s, end: e, width, start2: at(t1, d1), end2: at(t2, d2) }
}

function _bounds(original: { start: AnnotationPoint; end: AnnotationPoint }) {
  return {
    minX: Math.min(original.start.x, original.end.x),
    maxX: Math.max(original.start.x, original.end.x),
    minY: Math.min(original.start.y, original.end.y),
    maxY: Math.max(original.start.y, original.end.y),
  }
}

function _updateRectangle(
  original: { start: AnnotationPoint; end: AnnotationPoint },
  idx: number,
  pos: AnnotationPoint,
): ShapeBoundsUpdate {
  const { minX, maxX, minY, maxY } = _bounds(original)
  switch (idx) {
    case 0:
      return { start: { x: maxX, y: maxY }, end: pos }
    case 1:
      return { start: { x: minX, y: maxY }, end: pos }
    case 2:
      return { start: { x: minX, y: minY }, end: pos }
    case 3:
      return { start: { x: maxX, y: minY }, end: pos }
    default:
      return _updateEdge(original, idx - 4, pos)
  }
}

/** Move one edge (0 minY, 1 maxX, 2 maxY, 3 minX): rectangle sides and ellipse cardinals. */
function _updateEdge(
  original: { start: AnnotationPoint; end: AnnotationPoint },
  idx: number,
  pos: AnnotationPoint,
): ShapeBoundsUpdate {
  const { minX, maxX, minY, maxY } = _bounds(original)
  switch (idx) {
    case 0:
      return { start: { x: minX, y: pos.y }, end: { x: maxX, y: maxY } }
    case 1:
      return { start: { x: minX, y: minY }, end: { x: pos.x, y: maxY } }
    case 2:
      return { start: { x: minX, y: minY }, end: { x: maxX, y: pos.y } }
    case 3:
      return { start: { x: pos.x, y: minY }, end: { x: maxX, y: maxY } }
    default:
      return { start: { ...original.start }, end: { ...original.end } }
  }
}

function _updateCircle(
  original: { start: AnnotationPoint; end: AnnotationPoint },
  idx: number,
  pos: AnnotationPoint,
): ShapeBoundsUpdate {
  const cx = (original.start.x + original.end.x) / 2
  const cy = (original.start.y + original.end.y) / 2
  let newRadius: number
  switch (idx) {
    case 0: // top
    case 2: // bottom
      newRadius = Math.abs(pos.y - cy)
      break
    case 1: // right
    case 3: // left
      newRadius = Math.abs(pos.x - cx)
      break
    default:
      return { start: { ...original.start }, end: { ...original.end } }
  }
  return {
    start: { x: cx - newRadius, y: cy - newRadius },
    end: { x: cx + newRadius, y: cy + newRadius },
  }
}

function _updateLineArrow(
  original: { start: AnnotationPoint; end: AnnotationPoint; width?: number },
  idx: number,
  pos: AnnotationPoint,
): ShapeBoundsUpdate {
  const w = original.width ?? 2
  if (idx === 0) return { start: pos, end: { ...original.end }, width: w }
  if (idx === 1) return { start: { ...original.start }, end: pos, width: w }
  if (idx === 2) {
    // Width handle: compute perpendicular distance from pos to the line
    const dx = original.end.x - original.start.x
    const dy = original.end.y - original.start.y
    const len = Math.sqrt(dx * dx + dy * dy)
    let newWidth = w
    if (len > 1e-9) {
      // Signed perpendicular distance, take absolute * 2 for full width
      const perpDist = Math.abs(
        (pos.x - original.start.x) * (-dy / len) +
          (pos.y - original.start.y) * (dx / len),
      )
      newWidth = Math.max(0.5, perpDist * 2)
    }
    return {
      start: { ...original.start },
      end: { ...original.end },
      width: newWidth,
    }
  }
  return { start: { ...original.start }, end: { ...original.end }, width: w }
}

/**
 * Carries a shape's drawn polygons from its original bounds to new ones, so a
 * resize keeps an erased part erased. Box shapes scale per axis; a line or
 * arrow maps along and across its axis. null when either frame is degenerate,
 * so the caller keeps the last valid bounds.
 */
export function resizePolygons(
  shapeType: AnnotationTool,
  original: ShapeBoundsUpdate,
  next: ShapeBoundsUpdate,
  polygons: PolygonWithHoles[],
): PolygonWithHoles[] | null {
  const map = isLineShape(shapeType)
    ? lineMap(original, next)
    : boxMap(original, next)
  if (!map) return null
  return polygons.map((p) => ({
    outer: p.outer.map(map),
    holes: p.holes.map((h) => h.map(map)),
  }))
}

const isLineShape = (t: AnnotationTool) =>
  t === 'line' || t === 'arrow' || t === 'measureLine'

type PointMap = (p: AnnotationPoint) => AnnotationPoint

function boxMap(o: ShapeBoundsUpdate, n: ShapeBoundsUpdate): PointMap | null {
  const ox = Math.min(o.start.x, o.end.x)
  const oy = Math.min(o.start.y, o.end.y)
  const ow = Math.abs(o.end.x - o.start.x)
  const oh = Math.abs(o.end.y - o.start.y)
  const nw = Math.abs(n.end.x - n.start.x)
  const nh = Math.abs(n.end.y - n.start.y)
  const nx = Math.min(n.start.x, n.end.x)
  const ny = Math.min(n.start.y, n.end.y)
  // A zero-size axis (a probe) can only move; a collapsed box could not be
  // expanded again.
  const sx = ow === 0 ? Number(nw === 0) : nw / ow
  const sy = oh === 0 ? Number(nh === 0) : nh / oh
  if (sx === 0 || sy === 0) return null
  return (p) => ({ x: nx + (p.x - ox) * sx, y: ny + (p.y - oy) * sy })
}

function lineMap(o: ShapeBoundsUpdate, n: ShapeBoundsUpdate): PointMap | null {
  const oDirX = o.end.x - o.start.x
  const oDirY = o.end.y - o.start.y
  const nDirX = n.end.x - n.start.x
  const nDirY = n.end.y - n.start.y
  const oLen = Math.hypot(oDirX, oDirY)
  const nLen = Math.hypot(nDirX, nDirY)
  if (oLen === 0 || nLen === 0) return null
  // The width handle scales the offset across the line.
  const across = o.width && n.width ? n.width / o.width : 1
  return (p) => {
    const rx = p.x - o.start.x
    const ry = p.y - o.start.y
    const along = (rx * oDirX + ry * oDirY) / (oLen * oLen)
    const off = ((rx * -oDirY + ry * oDirX) / oLen) * across
    return {
      x: n.start.x + along * nDirX - (off * nDirY) / nLen,
      y: n.start.y + along * nDirY + (off * nDirX) / nLen,
    }
  }
}
