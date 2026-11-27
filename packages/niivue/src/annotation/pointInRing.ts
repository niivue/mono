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
      const dx = q.x - p.x
      const dy = q.y - p.y
      const t = Math.max(
        0,
        Math.min(
          1,
          ((x - p.x) * dx + (y - p.y) * dy) / (dx * dx + dy * dy || 1),
        ),
      )
      d = Math.min(d, Math.hypot(x - p.x - t * dx, y - p.y - t * dy))
    }
  }
  return inside ? 0 : d
}
