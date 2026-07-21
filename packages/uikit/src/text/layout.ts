// Pure text layout for UIKit. Rotation, advance, alignment and the perpendicular
// lift are all computed on the CPU here, so the backend renderers stay trivial
// textured-quad drawers and this math is unit-testable without a GPU. The
// per-glyph transform mirrors the old niivue/niivue uikit `drawRotatedText`
// (translate to the glyph pen, rotate about it, scale the em quad), but bakes the
// four corners into screen-pixel triangle vertices instead of a per-glyph MVP.
//
// Screen space is y-down (matches the canvas / the line + font projection). A
// glyph is emitted as two triangles (6 vertices), each vertex carrying
// [posX, posY, u, v, r, g, b, a] = 8 floats.

import type { UIKitFontMetrics, UIKitGlyph } from './font'

export const FLOATS_PER_VERTEX = 8
export const VERTICES_PER_GLYPH = 6

export type RGBA = readonly [number, number, number, number]

export interface TextLayoutOptions {
  /** Anchor position in screen pixels (baseline reference before alignment). */
  x: number
  y: number
  /** Text height in screen pixels (the em size; scales the atlas plane bounds). */
  sizePx: number
  /** Rotation in radians, measured in screen space (0 = left-to-right, y-down). */
  rotation?: number
  color?: RGBA
  /** Horizontal alignment along the (rotated) baseline: 0 left, 0.5 center, 1 right. */
  align?: number
  /** Shift perpendicular to the text direction, in pixels (positive = above line). */
  liftPx?: number
}

/** Total advance width of `str` in pixels at `sizePx`. */
export function measureWidth(
  metrics: UIKitFontMetrics,
  str: string,
  sizePx: number,
): number {
  let w = 0
  for (const ch of str) {
    const g = metrics.glyphs.get(ch)
    if (g) w += g.xadv * sizePx
  }
  return w
}

/**
 * Normalize a line direction angle so text drawn along it is never upside down.
 * When the raw angle points leftward (cos < 0), the label would render mirrored;
 * flip it by pi. Returns the readable angle and whether a flip occurred (the
 * caller flips the perpendicular lift so the label stays on the same side).
 */
export function readableAngle(rotation: number): {
  angle: number
  flipped: boolean
} {
  if (Math.cos(rotation) < 0) {
    return { angle: rotation + Math.PI, flipped: true }
  }
  return { angle: rotation, flipped: false }
}

// Quad corners as (px, py) in [0,1], y-down. Two triangles: TL,BL,TR / TR,BL,BR.
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 0],
  [0, 1],
  [1, 1],
]

/**
 * Lay out `str` into screen-pixel triangle vertices. Returns the packed vertex
 * buffer (8 floats/vertex) and the vertex count (6 per rendered glyph).
 */
export function layoutText(
  metrics: UIKitFontMetrics,
  str: string,
  opts: TextLayoutOptions,
): { vertices: Float32Array; count: number } {
  const size = opts.sizePx
  const rot = opts.rotation ?? 0
  const color = opts.color ?? [1, 1, 1, 1]
  const align = opts.align ?? 0
  const lift = opts.liftPx ?? 0
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)

  // Alignment shifts the pen back along the text direction; lift shifts it along
  // the perpendicular (screen-up side of the direction at rot=0 is (0,-1)).
  const width = measureWidth(metrics, str, size)
  let penX = opts.x - cos * width * align + sin * lift
  let penY = opts.y - sin * width * align - cos * lift

  const glyphs: { g: UIKitGlyph }[] = []
  for (const ch of str) {
    const g = metrics.glyphs.get(ch)
    if (g) glyphs.push({ g })
  }

  const vertices = new Float32Array(
    glyphs.length * VERTICES_PER_GLYPH * FLOATS_PER_VERTEX,
  )
  let o = 0
  const [cr, cg, cb, ca] = color
  for (const { g } of glyphs) {
    // Plane bounds are em units relative to the pen on the baseline, y-up:
    // [left bearing, bottom, width, height]. Map each unit-quad corner to a plane
    // point, then to a pen-relative screen offset (y negated: plane-up = screen-up
    // = -screen-y), rotate it, and translate by the pen. Corner (px,py) has py
    // down, so py=0 is the glyph top and maps to the atlas top row (v = ub + uh).
    const [pl, pb, pw, ph] = g.plane
    const [ul, ub, uw, uh] = g.uv
    for (const [px, py] of CORNERS) {
      const ox = (pl + pw * px) * size
      const oy = -(pb + ph * (1 - py)) * size
      vertices[o] = penX + cos * ox - sin * oy
      vertices[o + 1] = penY + sin * ox + cos * oy
      vertices[o + 2] = ul + px * uw
      // py=0 is the top screen corner and maps to the glyph's top row in the
      // atlas (uv v = ub), matching niivue core's font mapping. The atlas is
      // top-origin in texture space, so top row = smaller v.
      vertices[o + 3] = ub + py * uh
      vertices[o + 4] = cr
      vertices[o + 5] = cg
      vertices[o + 6] = cb
      vertices[o + 7] = ca
      o += FLOATS_PER_VERTEX
    }
    penX += cos * g.xadv * size
    penY += sin * g.xadv * size
  }
  return { vertices, count: glyphs.length * VERTICES_PER_GLYPH }
}
