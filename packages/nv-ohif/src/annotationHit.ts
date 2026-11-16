// The NiiVue annotation under the pointer, in canvas pixels: inside its
// outline or within a few CSS px of an edge (a line's thin rectangle).

import {
  type AnnotationPoint,
  type NiiVue,
  slice2DToMM,
  type VectorAnnotation,
} from '@niivue/niivue'
import { visibleAnnotationScreenShapes } from './commands'

const HIT_CSS_PX = 8

const segmentDistance = (
  px: number,
  py: number,
  a: AnnotationPoint,
  b: AnnotationPoint,
) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(
    0,
    Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1)),
  )
  return Math.hypot(px - a.x - t * dx, py - a.y - t * dy)
}

/** Canvas px of a slice-2D point of `a`, or null off the layout. */
export function toCanvas(
  nv: NiiVue,
  a: VectorAnnotation,
  p: AnnotationPoint,
): AnnotationPoint | null {
  return nv.mmToCanvas(slice2DToMM(p, a.slicePosition, a.sliceType))
}

/**
 * The visible annotation under the pointer: hit-tested against the shapes the
 * overlay drew (current slice only, each tile, OHIF-hidden ones dropped), so a
 * measurement on another slice can never be picked.
 */
export function annotationAt(
  nv: NiiVue,
  viewportId: string,
  e: MouseEvent,
  accept: (a: VectorAnnotation) => boolean = () => true,
): VectorAnnotation | undefined {
  const dpr = nv.effectiveDevicePixelRatio
  const px = e.offsetX * dpr
  const py = e.offsetY * dpr
  const byId = new Map(nv.annotations.map((a) => [a.id, a]))
  let best: { a: VectorAnnotation; d: number } | undefined
  for (const shape of visibleAnnotationScreenShapes(
    viewportId,
    nv.annotationScreenShapes,
  )) {
    const a = byId.get(shape.id)
    if (!a || !accept(a)) continue
    for (const poly of shape.polygons) {
      const ring = poly.outer
      let inside = false
      let d = Number.POSITIVE_INFINITY
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const p = ring[i] as AnnotationPoint
        const q = ring[j] as AnnotationPoint
        if (
          p.y > py !== q.y > py &&
          px < ((q.x - p.x) * (py - p.y)) / (q.y - p.y) + p.x
        )
          inside = !inside
        d = Math.min(d, segmentDistance(px, py, p, q))
      }
      if (inside) d = 0
      if (d <= HIT_CSS_PX * dpr && (!best || d < best.d)) best = { a, d }
    }
  }
  return best?.a
}
