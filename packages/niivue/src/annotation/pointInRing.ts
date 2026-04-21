import type { AnnotationPoint } from "@/NVTypes"

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
