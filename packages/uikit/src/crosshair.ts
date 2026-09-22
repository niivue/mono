// The UIKit crosshair widget: a screen-space cross marking one point, with a
// hole at the centre so the pixel being pointed at is never covered by the lines
// pointing at it, and optional graduation ticks reading distance outward from
// that point. `buildCrosshair` is pure -- it turns a spec into plain line + text
// draw data -- so the geometry is unit-testable and the overlay
// (crosshairOverlay.ts) just draws it.
//
// This exists for hosts that render outside a NiiVue canvas and so get no
// crosshair from the core renderer: the standalone slide viewer draws a plane of
// a much larger volume, and without a marker there is no feedback about where a
// linked 3D pick actually landed in it. The graduations turn that marker into a
// scale as well, which matters on a pane that spans a 15 um voxel to a 142 mm
// block in a few wheel turns.

import { buildLine, type LineData } from './line'
import type { RGBA, Vec2 } from './ruler'
import type { UIKitTextItem } from './textOverlay'

export interface CrosshairSpec {
  /** Crosshair centre in screen pixels (the space the overlay draws in). */
  at: Vec2
  /** Frame width in the same pixel space (the overlay frame's bounds). */
  width: number
  /** Frame height in the same pixel space. */
  height: number
  color?: RGBA
  /** Line thickness in pixels. Default 2. */
  thickness?: number
  /**
   * Radius of the hole left at the centre. Default 6. Set 0 for an unbroken
   * cross.
   */
  gapPx?: number
  /**
   * Arm length in pixels, measured outward from the edge of the gap. Omit for
   * arms that run to the edge of the frame.
   */
  armPx?: number

  // --- graduation ---------------------------------------------------------

  /**
   * Draw graduation ticks along the arms, every unit outward from the centre,
   * longer (and optionally numbered) every fifth. Needs `pxPerUnit`: without a
   * scale there is nothing to graduate against and ticks are skipped. Default
   * false.
   */
  showTicks?: boolean
  /**
   * Screen pixels per graduation unit. Pass a pair to graduate the horizontal
   * and vertical arms on their own scales -- these planes can be anisotropic
   * (a slab that never downsamples one axis), and a single mean would read long
   * on one arm and short on the other.
   */
  pxPerUnit?: number | readonly [number, number]
  /**
   * Units between minor ticks. Default 1. Set it when one unit is the wrong
   * tick spacing at the current scale: a pane that zooms across three decades
   * wants 100 um ticks at one end and half-micron ticks at the other, and the
   * numbers then read the distance (`i * unitsPerTick`), not the tick count.
   */
  unitsPerTick?: number
  /** Half-length of a minor tick in pixels. Default 6 (majors are twice that). */
  tickLength?: number
  /** Tick thickness in pixels. Default half the line thickness, minimum 1. */
  tickThickness?: number
  /** Number the major ticks. Default false. Needs a font on the overlay. */
  showTickNumbers?: boolean
  /**
   * Unit suffix for the graduation numbers, e.g. 'um'. Omit for bare numbers.
   * Worth setting on a pane whose scale changes with zoom, where a bare "10" is
   * ambiguous.
   */
  units?: string
  /** Graduation number height in pixels. Default 18. */
  sizePx?: number
  /** Number color. Defaults to the line color. */
  textColor?: RGBA
  /**
   * Outline width (px) for the numbers, for readability over busy backgrounds.
   * Default 2; the outline color auto-contrasts the text color. Set 0 to
   * disable.
   */
  textOutlineWidthPx?: number
}

export interface CrosshairGeometry {
  lines: LineData[]
  text: UIKitTextItem[]
}

const YELLOW: RGBA = [1, 1, 0, 1]
const DEFAULT_GAP_PX = 6
// Cap the ticks emitted per arm so a fine scale on a long arm can't emit
// thousands of lines.
const MAX_TICKS = 200

/** Resolve `pxPerUnit` to a positive [x, y] pair, or null when unusable. */
function unitScale(
  pxPerUnit: number | readonly [number, number] | undefined,
): [number, number] | null {
  if (pxPerUnit === undefined) return null
  const x = typeof pxPerUnit === 'number' ? pxPerUnit : pxPerUnit[0]
  const y = typeof pxPerUnit === 'number' ? pxPerUnit : pxPerUnit[1]
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0)
    return null
  return [x, y]
}

/**
 * Thin the ticks to at most MAX_TICKS per arm, in 1/2/5 steps. A round step
 * matters as much as the cap: majors are every fifth DRAWN tick, so an
 * arbitrary step (7, say) would leave an arm with no majors and no numbers.
 */
function decimation(marks: number): number {
  if (marks <= MAX_TICKS) return 1
  const raw = marks / MAX_TICKS
  const decade = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5]) {
    if (m * decade >= raw) return m * decade
  }
  return 10 * decade
}

/** A tick number: whole units read plainly, fractional ones kept short. */
function formatTickValue(value: number): string {
  return Number.isInteger(value)
    ? `${value}`
    : `${Number(value.toPrecision(3))}`
}

/**
 * Build the cross as up to four clipped segments, plus graduation ticks and
 * numbers when a scale is supplied.
 *
 * An axis is drawn only when the centre lies within the frame on the OTHER axis,
 * so a crosshair panned off the left edge still shows its horizontal line (which
 * says "the point is on this row, off to the left") but not a stray full-height
 * vertical line at a column that is not on screen.
 */
export function buildCrosshair(spec: CrosshairSpec): CrosshairGeometry {
  const [cx, cy] = spec.at
  const {
    width,
    height,
    color = YELLOW,
    thickness = 2,
    showTicks = false,
    tickLength = 6,
    showTickNumbers = false,
    units = '',
    sizePx = 18,
    textOutlineWidthPx = 2,
  } = spec
  const textColor = spec.textColor ?? color
  const lines: LineData[] = []
  const text: UIKitTextItem[] = []
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { lines, text }
  if (!(width > 0) || !(height > 0)) return { lines, text }

  const gapPx = spec.gapPx
  const gap =
    gapPx !== undefined && Number.isFinite(gapPx)
      ? Math.max(0, gapPx)
      : DEFAULT_GAP_PX
  const arm = spec.armPx
  const reach =
    arm !== undefined && Number.isFinite(arm) && arm > 0
      ? gap + arm
      : Number.POSITIVE_INFINITY
  const tickThickness = Math.max(1, spec.tickThickness ?? thickness / 2)
  const scale = showTicks ? unitScale(spec.pxPerUnit) : null
  const perTick = spec.unitsPerTick
  const unitsPerTick =
    perTick !== undefined && Number.isFinite(perTick) && perTick > 0
      ? perTick
      : 1

  // The horizontal arm lies along x at a fixed y, the vertical along y at a
  // fixed x. Both are built by the same code, addressed through `axis`.
  const axes = [
    { axis: 0, centre: cx, cross: cy, extent: width, crossExtent: height },
    { axis: 1, centre: cy, cross: cx, extent: height, crossExtent: width },
  ] as const

  // Emit `[lo, hi]` clipped to the frame, as a segment along `axis`.
  const segment = (
    axis: number,
    cross: number,
    lo: number,
    hi: number,
    extent: number,
  ): void => {
    const a = Math.max(0, lo)
    const b = Math.min(extent, hi)
    if (b - a <= 0) return
    lines.push(
      axis === 0
        ? buildLine(a, cross, b, cross, thickness, color)
        : buildLine(cross, a, cross, b, thickness, color),
    )
  }

  for (const { axis, centre, cross, extent, crossExtent } of axes) {
    // The arm is meaningless when its fixed coordinate is off-frame.
    if (cross < 0 || cross > crossExtent) continue
    segment(axis, cross, centre - reach, centre - gap, extent)
    segment(axis, cross, centre + gap, centre + reach, extent)
    if (!scale) continue

    // Distance between minor ticks, which is one unit only while the caller
    // leaves `unitsPerTick` alone.
    const tickPx = scale[axis] * unitsPerTick
    // Minimum spacing between numbers so they never collide. Along a horizontal
    // arm that is set by the widest label; stacked down a vertical arm it is set
    // by the line height whatever the digits.
    const furthest =
      Math.floor(Math.max(centre, extent - centre) / tickPx) * unitsPerTick
    const maxLabel = `${formatTickValue(furthest)}${units ? ` ${units}` : ''}`
    const minLabelGapPx =
      axis === 0 ? sizePx * (maxLabel.length * 0.62 + 0.8) : sizePx * 1.6

    for (const dir of [-1, 1] as const) {
      // How far this arm actually reaches: the shorter of its length and the
      // frame edge, so ticks are never emitted for arm that was clipped away.
      const limit = Math.min(reach, dir < 0 ? centre : extent - centre)
      if (limit <= gap) continue
      const marks = Math.floor(limit / tickPx)
      const step = decimation(marks)
      let lastLabelPx = Number.NEGATIVE_INFINITY
      for (let i = step; i <= marks; i += step) {
        const distPx = i * tickPx
        // Ticks inside the hole would fill the gap back in.
        if (distPx < gap) continue
        const pos = centre + dir * distPx
        const major = i % 5 === 0
        const half = major ? tickLength * 2 : tickLength
        // The tick is perpendicular to the arm, so it is clipped against the
        // OTHER axis' extent.
        const lo = Math.max(0, cross - half)
        const hi = Math.min(crossExtent, cross + half)
        if (hi - lo > 0) {
          lines.push(
            axis === 0
              ? buildLine(pos, lo, pos, hi, tickThickness, color)
              : buildLine(lo, pos, hi, pos, tickThickness, color),
          )
        }
        if (!major || !showTickNumbers) continue
        if (distPx - lastLabelPx < minLabelGapPx) continue
        lastLabelPx = distPx
        // Numbers read distance FROM the centre, so both arms of an axis carry
        // the same values. Drawn upright on both axes (a rotated vertical-arm
        // number would be harder to read than it is compact).
        const value = formatTickValue(i * unitsPerTick)
        const str = units ? `${value} ${units}` : value
        text.push(
          axis === 0
            ? {
                str,
                x: pos,
                y: cross,
                sizePx,
                align: 0.5,
                // Below the arm: positive lift is above the line.
                liftPx: -(half + sizePx * 0.9),
                color: textColor,
                outlineWidthPx: textOutlineWidthPx,
              }
            : {
                str,
                // Right of the arm, left-aligned off the end of the tick.
                x: cross + half + sizePx * 0.4,
                y: pos,
                sizePx,
                align: 0,
                // Lower the baseline so the glyphs straddle the tick.
                liftPx: -sizePx * 0.35,
                color: textColor,
                outlineWidthPx: textOutlineWidthPx,
              },
        )
      }
    }
  }
  return { lines, text }
}
