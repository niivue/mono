// Serialize voxel vector annotations to a standalone SVG. This is the volume
// analog of SlideVectorLayer.toSVG: annotation polygons live in slice-plane mm
// coordinates (two of the three axes, per sliceType), so we emit one `<path>`
// per polygon (outer ring + holes via fill-rule="evenodd") in mm space, sized to
// the annotations' bounding box. y is flipped so the export reads the same way
// up as the on-screen slice (SVG y grows downward, mm y grows upward).
//
// A plane's two in-plane axes differ per sliceType (axial x/y, coronal x/z,
// sagittal y/z), so shapes on different planes cannot share one coordinate
// frame. Each plane becomes its own `<g>` panel, laid out left-to-right, with
// coordinates local to that panel's bounding box.

import { svgNumber } from '@/NVSvg'
import type { VectorAnnotation } from '@/NVTypes'

export interface AnnotationsToSVGParams {
  annotations: readonly VectorAnnotation[]
  // Only export annotations on this slice plane (AXIAL/CORONAL/SAGITTAL). Omit
  // to export every plane present, each in its own `<g>` panel.
  sliceType?: number
  // When given, restrict to annotations whose slicePosition is within
  // `tolerance` mm of this depth. Omit to export every annotation on the plane.
  slicePosition?: number
  tolerance?: number
  // Padding (mm) added around each panel's bounding box.
  pad?: number
}

const PLANE_NAMES: Record<number, string> = {
  0: 'AXIAL',
  1: 'CORONAL',
  2: 'SAGITTAL',
}

const EMPTY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1" height="1">\n</svg>\n'

const rgba = (c: [number, number, number, number]): string => {
  const chan = (n: number): number =>
    Number.isFinite(n) ? Math.round(Math.max(0, Math.min(1, n)) * 255) : 0
  // A malformed alpha renders opaque rather than silently invisible.
  const alpha = Number.isFinite(c[3]) ? Math.max(0, Math.min(1, c[3])) : 1
  return `rgba(${chan(c[0])},${chan(c[1])},${chan(c[2])},${alpha})`
}

interface Panel {
  sliceType: number
  annotations: VectorAnnotation[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Bounding box over every point of every polygon. Null when there is no geometry. */
function boundsOf(annotations: readonly VectorAnnotation[]): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ann of annotations) {
    for (const poly of ann.polygons) {
      for (const ring of [poly.outer, ...poly.holes]) {
        for (const p of ring) {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
          if (p.x < minX) minX = p.x
          if (p.y < minY) minY = p.y
          if (p.x > maxX) maxX = p.x
          if (p.y > maxY) maxY = p.y
        }
      }
    }
  }
  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
}

/**
 * Serialize the matching vector annotations to an SVG string. Returns a valid
 * empty-body SVG when nothing matches. Each polygon becomes a `<path>` filled
 * with the annotation's fill color and stroked with its stroke color, inside a
 * `<g>` for its slice plane.
 */
export function annotationsToSVG(params: AnnotationsToSVGParams): string {
  const { annotations, sliceType, slicePosition, tolerance = 0.5 } = params
  const pad = params.pad ?? 2
  const selected = annotations.filter(
    (a) =>
      (sliceType === undefined || a.sliceType === sliceType) &&
      a.polygons.length > 0 &&
      (slicePosition === undefined ||
        Math.abs(a.slicePosition - slicePosition) <= tolerance),
  )

  // One panel per slice plane, in ascending plane order.
  const byPlane = new Map<number, VectorAnnotation[]>()
  for (const ann of selected) {
    const list = byPlane.get(ann.sliceType)
    if (list) list.push(ann)
    else byPlane.set(ann.sliceType, [ann])
  }
  const panels: Panel[] = []
  for (const plane of [...byPlane.keys()].sort((a, b) => a - b)) {
    const anns = byPlane.get(plane) ?? []
    const b = boundsOf(anns)
    if (!b) continue
    panels.push({
      sliceType: plane,
      annotations: anns,
      minX: b.minX - pad,
      minY: b.minY - pad,
      maxX: b.maxX + pad,
      maxY: b.maxY + pad,
    })
  }
  if (panels.length === 0) return EMPTY_SVG

  const gap = pad * 2
  const totalWidth =
    panels.reduce((sum, p) => sum + (p.maxX - p.minX), 0) +
    gap * (panels.length - 1)
  const totalHeight = Math.max(...panels.map((p) => p.maxY - p.minY))

  const groups: string[] = []
  let dx = 0
  for (const panel of panels) {
    // Panel-local coordinates: shift x to the panel's left edge and flip y
    // within the panel's own bounds, so the panel sits at its own (0,0).
    const lx = (x: number): number => x - panel.minX
    const ly = (y: number): number => panel.maxY - y

    const ringPath = (ring: { x: number; y: number }[]): string => {
      if (ring.length === 0) return ''
      const pts = ring
        .map(
          (p, i) =>
            `${i === 0 ? 'M' : 'L'} ${svgNumber(lx(p.x))} ${svgNumber(ly(p.y))}`,
        )
        .join(' ')
      return `${pts} Z`
    }

    const paths: string[] = []
    for (const ann of panel.annotations) {
      const fill = rgba(ann.style.fillColor)
      const stroke = rgba(ann.style.strokeColor)
      const sw = svgNumber(ann.style.strokeWidth)
      for (const poly of ann.polygons) {
        const d = [poly.outer, ...poly.holes]
          .map(ringPath)
          .filter(Boolean)
          .join(' ')
        if (!d) continue
        paths.push(
          `    <path d="${d}" fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" />`,
        )
      }
    }
    const name = PLANE_NAMES[panel.sliceType] ?? 'UNKNOWN'
    groups.push(
      `  <g data-slice-type="${svgNumber(panel.sliceType)}" data-slice-plane="${name}" transform="translate(${svgNumber(dx)} 0)">\n${paths.join('\n')}\n  </g>`,
    )
    dx += panel.maxX - panel.minX + gap
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgNumber(totalWidth)} ${svgNumber(totalHeight)}" width="${svgNumber(totalWidth)}" height="${svgNumber(totalHeight)}">\n${groups.join('\n')}\n</svg>\n`
}
