import type { AnnotationPoint } from '@/NVTypes'

export function pointInRing(
  point: AnnotationPoint,
  ring: AnnotationPoint[],
): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]?.x,
      yi = ring[i]?.y
    const xj = ring[j]?.x,
      yj = ring[j]?.y
    if (
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Distance from (x, y) to a polygon with holes: 0 inside it (even-odd, so a
 * hole is outside), else to its nearest edge.
 */
export function polygonDistance(
  x: number,
  y: number,
  { outer, holes }: { outer: AnnotationPoint[]; holes: AnnotationPoint[][] },
): number {
  let inside = false
  let d = Number.POSITIVE_INFINITY
  for (const ring of [outer, ...holes]) {
    if (pointInRing({ x, y }, ring)) inside = !inside
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[j] as AnnotationPoint
      const q = ring[i] as AnnotationPoint
      d = Math.min(d, pointToSegmentDistance(x, y, p.x, p.y, q.x, q.y))
    }
  }
  return inside ? 0 : d
}

/** Distance from a point to a line segment. */
export function pointToSegmentDistance(
  px: number,
  py: number,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
): number {
  const dx = ex - sx
  const dy = ey - sy
  const lenSq = dx * dx + dy * dy
  const t =
    lenSq > 0
      ? Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lenSq))
      : 0
  return Math.hypot(px - (sx + t * dx), py - (sy + t * dy))
}
