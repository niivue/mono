// Pure text layout for UIKit. Rotation, advance, alignment and the perpendicular
// lift are computed on the CPU here, so the math is unit-testable without a
// GPU. Each glyph becomes one record for the instanced text renderers: its
// quad's (rotated) top-left, size, atlas uv rect and colour, then the atlas
// range and the rotation's sin and cos - 1 (the quad turns about its top-left).
//
// Screen space is y-down (matches the canvas / the line + font projection).
import type { UIKitFontMetrics, UIKitGlyph } from './font'

/** Floats per glyph record: rect, uv rect, colour, atlas range, sin, cos - 1, pad. */
export const FLOATS_PER_GLYPH = 16

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
  /**
   * Outline (halo) width in screen pixels; 0 (default) draws no outline. The
   * effective width is bounded by the atlas SDF range, so a small value (1-2)
   * reads best with the bundled MSDF atlas.
   */
  outlineWidthPx?: number
  /**
   * Outline color. Omit to auto-pick black or white for contrast against the
   * fill color (see {@link autoOutlineColor}).
   */
  outlineColor?: RGBA
}

/**
 * Pick a high-contrast outline color for a fill: black for light fills, white
 * for dark ones, using perceptual (Rec. 601) luminance.
 */
export function autoOutlineColor(fill: RGBA): RGBA {
  const [r, g, b] = fill
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b
  return luminance > 0.5 ? [0, 0, 0, 1] : [1, 1, 1, 1]
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
 * Cap height of the font in em units: how far the top of a capital letter sits
 * above the baseline. Used to centre a label on its button vertically by the
 * capitals rather than by each string's own ink, so a row of buttons keeps one
 * baseline whether or not a label has descenders. Falls back to a typical 0.7em
 * when the atlas has no capital H.
 */
export function capHeight(metrics: UIKitFontMetrics): number {
  const h = metrics.glyphs.get('H')
  if (!h || h.plane[3] <= 0) return 0.7
  return h.plane[1] + h.plane[3]
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

/**
 * Lay out `str` as glyph records (FLOATS_PER_GLYPH floats each, screen
 * pixels) for the text renderers. Returns the packed records and their count.
 */
export function layoutText(
  metrics: UIKitFontMetrics,
  str: string,
  opts: TextLayoutOptions,
): { glyphs: Float32Array; count: number } {
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

  const found: UIKitGlyph[] = []
  for (const ch of str) {
    const g = metrics.glyphs.get(ch)
    if (g) found.push(g)
  }
  const glyphs = new Float32Array(found.length * FLOATS_PER_GLYPH)
  let o = 0
  for (const g of found) {
    // Plane bounds are em units relative to the pen on the baseline, y-up:
    // [left bearing, bottom, width, height]. The quad's top-left is at
    // (left, -(bottom + height)) from the pen in y-down screen units, rotated.
    const [pl, pb, pw, ph] = g.plane
    const ox = pl * size
    const oy = -(pb + ph) * size
    glyphs.set(
      [
        penX + cos * ox - sin * oy,
        penY + sin * ox + cos * oy,
        pw * size,
        ph * size,
        ...g.uv,
        ...color,
        metrics.distanceRange,
        sin,
        cos - 1,
      ],
      o,
    )
    o += FLOATS_PER_GLYPH
    penX += cos * g.xadv * size
    penY += sin * g.xadv * size
  }
  return { glyphs, count: found.length }
}
