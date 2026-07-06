// Serialize voxel vector annotations to a standalone SVG. This is the volume
// analog of SlideVectorLayer.toSVG: annotation polygons live in slice-plane mm
// coordinates (two of the three axes, per sliceType), so we emit one `<path>`
// per polygon (outer ring + holes via fill-rule="evenodd") in mm space, sized to
// the annotations' bounding box. y is flipped so the export reads the same way
// up as the on-screen slice (SVG y grows downward, mm y grows upward).

import type { VectorAnnotation } from '@/NVTypes'

export interface AnnotationsToSVGParams {
  annotations: readonly VectorAnnotation[]
  // Only export annotations on this slice plane (AXIAL/CORONAL/SAGITTAL).
  sliceType: number
  // When given, restrict to annotations whose slicePosition is within
  // `tolerance` mm of this depth. Omit to export every annotation on the plane.
  slicePosition?: number
  tolerance?: number
  // Padding (mm) added around the bounding box in the viewBox.
  pad?: number
}

const rgba = (c: [number, number, number, number]): string => {
  const to255 = (n: number): number =>
    Math.round(Math.max(0, Math.min(1, n)) * 255)
  return `rgba(${to255(c[0])},${to255(c[1])},${to255(c[2])},${Math.max(0, Math.min(1, c[3]))})`
}

const round = (n: number): string => (Math.round(n * 100) / 100).toString()

/**
 * Serialize the matching vector annotations to an SVG string. Returns a valid
 * empty-body SVG when nothing matches. Each polygon becomes a `<path>` filled
 * with the annotation's fill color and stroked with its stroke color.
 */
export function annotationsToSVG(params: AnnotationsToSVGParams): string {
  const { annotations, sliceType, slicePosition, tolerance = 0.5 } = params
  const pad = params.pad ?? 2
  const selected = annotations.filter(
    (a) =>
      a.sliceType === sliceType &&
      a.polygons.length > 0 &&
      (slicePosition === undefined ||
        Math.abs(a.slicePosition - slicePosition) <= tolerance),
  )

  // Bounding box over every point of every selected polygon.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ann of selected) {
    for (const poly of ann.polygons) {
      for (const ring of [poly.outer, ...poly.holes]) {
        for (const p of ring) {
          if (p.x < minX) minX = p.x
          if (p.y < minY) minY = p.y
          if (p.x > maxX) maxX = p.x
          if (p.y > maxY) maxY = p.y
        }
      }
    }
  }

  if (!Number.isFinite(minX)) {
    // No geometry: a valid empty 1x1 SVG.
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1" height="1">\n</svg>\n'
  }

  minX -= pad
  minY -= pad
  maxX += pad
  maxY += pad
  const width = maxX - minX
  const height = maxY - minY
  // Flip y within [minY, maxY] so up on screen is up in the SVG.
  const fy = (y: number): number => maxY + minY - y

  const ringPath = (ring: { x: number; y: number }[]): string => {
    if (ring.length === 0) return ''
    const pts = ring
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(fy(p.y))}`)
      .join(' ')
    return `${pts} Z`
  }

  const paths: string[] = []
  for (const ann of selected) {
    const fill = rgba(ann.style.fillColor)
    const stroke = rgba(ann.style.strokeColor)
    const sw = round(ann.style.strokeWidth)
    for (const poly of ann.polygons) {
      const d = [poly.outer, ...poly.holes]
        .map(ringPath)
        .filter(Boolean)
        .join(' ')
      if (!d) continue
      paths.push(
        `  <path d="${d}" fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" />`,
      )
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(minX)} ${round(minY)} ${round(width)} ${round(height)}" width="${round(width)}" height="${round(height)}">\n${paths.join('\n')}\n</svg>\n`
}
