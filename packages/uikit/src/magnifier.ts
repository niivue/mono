// Magnifier geometry: a circular lens centred on the pointer showing the
// frame around that point enlarged. The magnified point stays under the
// pointer, so near an edge the lens is cut off rather than shifted.

import type { UIKitBox } from './rect'

export interface MagnifierSpec {
  /** Pointer, canvas px. */
  x: number
  y: number
  /** Drawable size, canvas px. */
  width: number
  height: number
  dpr: number
  /** Lens radius, CSS px. */
  radiusCss: number
  /** Enlargement, > 1 magnifies. */
  zoom: number
}

export interface MagnifierLayout {
  /** The lens's bounding square, canvas px. */
  lens: UIKitBox
  centerX: number
  centerY: number
  /** Lens radius, canvas px. */
  radius: number
  zoom: number
  /** The frame region shown in the lens, canvas px (may leave the canvas). */
  source: UIKitBox
}

/** The lens for a pointer, or null when the pointer is off the drawable. */
export function layoutMagnifier(spec: MagnifierSpec): MagnifierLayout | null {
  const { x, y, width, height, zoom } = spec
  if (!(x >= 0 && y >= 0 && x < width && y < height && zoom > 0)) return null
  const radius = spec.radiusCss * spec.dpr
  const half = radius / zoom
  return {
    lens: {
      x: x - radius,
      y: y - radius,
      width: 2 * radius,
      height: 2 * radius,
    },
    centerX: x,
    centerY: y,
    radius,
    zoom,
    source: { x: x - half, y: y - half, width: 2 * half, height: 2 * half },
  }
}
