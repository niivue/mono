// OHIF's SculptorTool on a NiiVue contour segmentation: a drag pushes the
// active segment's outline on the pressed slice out of a circle around the
// pointer (from inside it grows, from outside it shrinks), as cornerstone's.
// One drag is one undo step.
import {
  type AnnotationPoint,
  type NiiVue,
  type PolygonWithHoles,
  polygonBoolean,
  type VectorAnnotation,
} from '@niivue/niivue'
import { sliceOf } from './contourOps'

// cornerstone's CircleSculptCursor: at most 1/24 of the pane's smaller side.
const MAX_RADIUS_FRACTION = 1 / 24

/** Dynamic Cursor Size (OHIF's switch, on by default). */
let dynamicCursor = true
export const setDynamicCursor = (on: boolean): void => {
  dynamicCursor = on
}

const IN_PLANE = [
  [0, 1],
  [0, 2],
  [1, 2],
] as const

/**
 * `ring` pushed out of the circle (c, r), with points added where it stretched
 * (no gap over `step`; cornerstone's max(radius / 4, one pixel)).
 */
export function sculptRing(
  ring: readonly AnnotationPoint[],
  c: AnnotationPoint,
  r: number,
  step = r / 4,
): AnnotationPoint[] {
  const pushed = ring.map((p) => {
    const dx = p.x - c.x
    const dy = p.y - c.y
    const d = Math.hypot(dx, dy)
    return d >= r || d === 0
      ? p
      : { x: c.x + (dx / d) * r, y: c.y + (dy / d) * r }
  })
  const out: AnnotationPoint[] = []
  for (let i = 0; i < pushed.length; i++) {
    const p = pushed[i] as AnnotationPoint
    const q = pushed[(i + 1) % pushed.length] as AnnotationPoint
    out.push(p)
    const steps = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / step)
    for (let k = 1; k < steps; k++) {
      const t = k / steps
      const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
      const dx = m.x - c.x
      const dy = m.y - c.y
      const d = Math.hypot(dx, dy)
      out.push(
        d >= r || d === 0
          ? m
          : { x: c.x + (dx / d) * r, y: c.y + (dy / d) * r },
      )
    }
  }
  return out
}

// By edge, not vertex: a decimated straight edge has no vertex near the cursor.
const edgeDistance = (
  p: AnnotationPoint,
  q: AnnotationPoint,
  c: AnnotationPoint,
) => {
  const dx = q.x - p.x
  const dy = q.y - p.y
  const t = Math.max(
    0,
    Math.min(
      1,
      ((c.x - p.x) * dx + (c.y - p.y) * dy) / (dx * dx + dy * dy || 1),
    ),
  )
  return Math.hypot(p.x + t * dx - c.x, p.y + t * dy - c.y)
}

const ringsDistance = (polys: PolygonWithHoles[], c: AnnotationPoint) =>
  polys.reduce(
    (best, poly) =>
      [poly.outer, ...poly.holes].reduce(
        (b, ring) =>
          ring.reduce(
            (m, p, i) =>
              Math.min(
                m,
                edgeDistance(
                  p,
                  ring[(i + 1) % ring.length] as AnnotationPoint,
                  c,
                ),
              ),
            b,
          ),
        best,
      ),
    Number.POSITIVE_INFINITY,
  )

const touches = (poly: PolygonWithHoles, c: AnnotationPoint, r: number) =>
  ringsDistance([poly], c) < r

/**
 * The drag's radius, as cornerstone's: the largest allowed, or with a dynamic
 * cursor the press's distance to the outline when smaller (a press near the
 * edge sculpts finely).
 */
export function sculptRadius(
  maxR: number,
  polys: PolygonWithHoles[],
  c: AnnotationPoint,
  dynamic: boolean,
): number {
  const d = dynamic && polys.length ? ringsDistance(polys, c) : 0
  return d > 0 ? Math.min(maxR, d) : maxR
}

/**
 * Sculpt with `nv`'s pointer while `target()` names a segment (its group and
 * label). Returns the cleanup.
 */
export function startSculpt(
  nv: NiiVue,
  target: () => { group: string; label: number } | undefined,
): () => void {
  const canvas = nv.canvas
  if (!canvas) return () => {}
  let drag:
    | {
        group: string
        label: number
        slice: string
        first: boolean
        r: number
        step: number
      }
    | undefined
  // The pointer on a 2D tile: its slice and slice-2D point.
  const at = (e: PointerEvent) => {
    const c = nv.clientToCanvas(e.clientX, e.clientY)
    const hit = c && nv.hitTest(c[0], c[1])
    const mm = c && nv.canvasToMM(c[0], c[1])
    if (!hit || hit.isRender || !mm) return undefined
    const sliceType = hit.sliceType as number
    const [i0, i1] = IN_PLANE[sliceType] as readonly [number, number]
    // The largest radius in mm: MAX_RADIUS_FRACTION of the pane, measured
    // along the canvas at the press.
    const cssPx =
      Math.min(canvas.clientWidth, canvas.clientHeight) * MAX_RADIUS_FRACTION
    const mm2 = nv.canvasToMM(
      c[0] + cssPx * (canvas.width / (canvas.clientWidth || 1)),
      c[1],
    )
    const maxR = mm2
      ? Math.hypot(...mm2.map((v, k) => v - (mm[k] as number)))
      : 5
    return {
      sliceType,
      slice: sliceOf(nv, { sliceType, anchorMM: mm, slicePosition: 0 }),
      p: { x: mm[i0] as number, y: mm[i1] as number },
      maxR,
      pixelMM: maxR / (cssPx || 1),
    }
  }
  const segmentShapes = (t: { group: string; label: number }, slice: string) =>
    nv.annotations.filter(
      (a) =>
        a.group === t.group && a.label === t.label && sliceOf(nv, a) === slice,
    )
  const shapes = () => (drag ? segmentShapes(drag, drag.slice) : [])
  // The cursor circle (cornerstone's CircleSculptCursor), at the radius a
  // press there would sculpt with.
  const ring = document.createElement('div')
  ring.style.cssText =
    'position:absolute;pointer-events:none;border:1px solid #ffff00;border-radius:50%;display:none'
  canvas.parentElement?.appendChild(ring)
  const hideRing = () => {
    ring.style.display = 'none'
  }
  const showRing = (e: PointerEvent, rMM?: number) => {
    const where = at(e)
    const t = target()
    const r =
      where &&
      (rMM ??
        (t &&
          sculptRadius(
            where.maxR,
            segmentShapes(t, where.slice).flatMap((a) => a.polygons),
            where.p,
            dynamicCursor,
          )))
    if (!where || !r) return hideRing()
    const px = r / where.pixelMM
    const box = canvas.getBoundingClientRect()
    const parent = canvas.parentElement?.getBoundingClientRect() ?? box
    ring.style.display = 'block'
    ring.style.width = ring.style.height = `${2 * px}px`
    ring.style.left = `${e.clientX - parent.left - px}px`
    ring.style.top = `${e.clientY - parent.top - px}px`
  }
  const sculpt = (p: AnnotationPoint) => {
    if (!drag) return
    const before = shapes()
    let changed = false
    const after: VectorAnnotation[] = before.map((a) => {
      const { r, step } = drag as NonNullable<typeof drag>
      if (!a.polygons.some((poly) => touches(poly, p, r))) return a
      changed = true
      return {
        ...a,
        polygons: a.polygons.map((poly) => ({
          outer: sculptRing(poly.outer, p, r, step),
          holes: poly.holes.map((h) => sculptRing(h, p, r, step)),
        })),
      }
    })
    if (!changed) return
    // The drag's first change records the undo step; the rest edit in place.
    nv.replaceAnnotations(
      before.map((a) => a.id),
      after,
      drag.first,
    )
    drag.first = false
  }
  const down = (e: PointerEvent) => {
    const t = target()
    const where = t && e.button === 0 && at(e)
    if (!t || !where) return
    // Not a core drag (pan, crosshair).
    e.stopImmediatePropagation()
    canvas.setPointerCapture(e.pointerId)
    drag = { ...t, slice: where.slice, first: true, r: where.maxR, step: 0 }
    drag.r = sculptRadius(
      where.maxR,
      shapes().flatMap((a) => a.polygons),
      where.p,
      dynamicCursor,
    )
    // A press on the outline gives a tiny circle: points no closer than a pixel.
    drag.step = Math.max(drag.r / 4, where.pixelMM)
    sculpt(where.p)
  }
  const move = (e: PointerEvent) => {
    showRing(e, drag?.r)
    if (!drag) return
    e.stopImmediatePropagation()
    const where = at(e)
    if (where && where.slice === drag.slice) sculpt(where.p)
  }
  const up = () => {
    if (!drag) return
    // A pushed outline can cross itself: resolve it to a region once.
    const pushed = shapes()
    if (!drag.first)
      nv.replaceAnnotations(
        pushed.map((a) => a.id),
        pushed.map((a) => ({
          ...a,
          polygons: polygonBoolean('union', a.polygons, []),
        })),
        false,
      )
    drag = undefined
  }
  canvas.addEventListener('pointerdown', down, { capture: true })
  canvas.addEventListener('pointermove', move, { capture: true })
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)
  canvas.addEventListener('pointerleave', hideRing)
  return () => {
    canvas.removeEventListener('pointerdown', down, { capture: true })
    canvas.removeEventListener('pointermove', move, { capture: true })
    canvas.removeEventListener('pointerup', up)
    canvas.removeEventListener('pointercancel', up)
    canvas.removeEventListener('pointerleave', hideRing)
    ring.remove()
  }
}
