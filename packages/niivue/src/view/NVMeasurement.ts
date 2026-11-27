import { rulerSegments, rulerTickNumbers } from '@niivue/uikit'
import type NVModel from '@/NVModel'
import type { BuildTextFn, GlyphBatch } from './NVFont'
import type { BuildLineFn, LineData } from './NVLine'

export type MeasurementResult = { lines: LineData[]; labels: GlyphBatch[] }

/**
 * Unit perpendicular pointing down the screen (right for a vertical ruler),
 * whichever way the ruler was drawn, so numbers and length never share a side.
 */
function downPerp(dx: number, dy: number, len: number): [number, number] {
  const s = dx > 0 || (dx === 0 && dy < 0) ? 1 : -1
  return [(-dy / len) * s, (dx / len) * s]
}

/** Where the length label goes: past the major ticks, opposite the numbers. */
export function rulerLengthLabel(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  tickLength = 6,
): { x: number; y: number; anchorX: number; anchorY: number } {
  const len = Math.hypot(ex - sx, ey - sy)
  const [px, py] = len > 0 ? downPerp(ex - sx, ey - sy, len) : [0, 1]
  const gap = tickLength * 2 + 3
  return {
    x: (sx + ex) * 0.5 - px * gap,
    y: (sy + ey) * 0.5 - py * gap,
    // The text extends away from the ruler: above it, or beside a vertical one.
    anchorX: 0.5 + 0.5 * px,
    anchorY: 0.5 + 0.5 * py,
  }
}

/** A ruler graduation number and where to draw it (canvas pixels). */
export type RulerTickLabel = { str: string; x: number; y: number }

/**
 * Graduation numbers for a ruler between two canvas points: uikit's numbered
 * major ticks (`rulerTickNumbers`, which thins them so they never collide),
 * each placed just past its tick on the screen-down side, so they line up like
 * a real ruler's scale. `numberPx` is a number's drawn height in canvas pixels.
 * Empty for a zero-length or unit-less ruler.
 */
export function rulerTickLabels(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  units: number,
  tickLength = 6,
  numberPx = 12,
): RulerTickLabel[] {
  const dx = ex - sx
  const dy = ey - sy
  const len = Math.hypot(dx, dy)
  if (len === 0 || units <= 0) return []
  const [px, py] = downPerp(dx, dy, len)
  const off = tickLength * 3
  return rulerTickNumbers(len, units, tickLength, numberPx).map(
    ({ value, t }) => ({
      str: `${value}`,
      x: sx + t * dx + px * off,
      y: sy + t * dy + py * off,
    }),
  )
}

/** Format distance with smart decimals, suffixed with `unit` when shown. */
export function formatDistance(
  dist: number,
  showUnits: boolean,
  unit = 'mm',
): string {
  let decimals = 2
  if (dist > 9) decimals = 1
  if (dist > 99) decimals = 0
  let label = dist.toFixed(decimals)
  if (showUnits) label += ` ${unit}`
  return label
}

/** Translucent backing that keeps measurement text readable on any image. */
export function measureTextBack(textColor: number[]): number[] {
  return textColor[0] + textColor[1] + textColor[2] > 0.8
    ? [0, 0, 0, 0.5]
    : [1, 1, 1, 0.5]
}

/** A ruler between two canvas points, `distance` units long (0: no ticks). */
export type ScreenRuler = {
  sx: number
  sy: number
  ex: number
  ey: number
  distance: number
  /** Replaces the formatted distance. */
  label?: string
}

/**
 * Graduated rulers as NiiVue draws them: baseline, end caps, per-unit ticks
 * (majors every fifth), graduation numbers and the length at the midpoint.
 */
export function buildRulers(
  rulers: readonly ScreenRuler[],
  style: Pick<
    NVModel['ui'],
    | 'measureLineColor'
    | 'measureTextColor'
    | 'rulerWidth'
    | 'isMeasureUnitsVisible'
  >,
  buildText: BuildTextFn,
  buildLine: BuildLineFn,
  numberPx = 12,
  unit = 'mm',
): MeasurementResult {
  const lineColor = style.measureLineColor
  const lineWidth = style.rulerWidth
  const textColor = style.measureTextColor
  const textBack = measureTextBack(textColor)
  const lines: LineData[] = []
  const labels: GlyphBatch[] = []
  for (const { sx, sy, ex, ey, distance, label: text } of rulers) {
    for (const [x0, y0, x1, y1] of rulerSegments(
      [sx, sy],
      [ex, ey],
      distance,
    )) {
      lines.push(buildLine(x0, y0, x1, y1, lineWidth, lineColor))
    }
    for (const t of rulerTickLabels(sx, sy, ex, ey, distance, 6, numberPx)) {
      const b = buildText(t.str, t.x, t.y, 0.5, textColor, 0.5, 0.5)
      if (b.count > 0) labels.push(b)
    }
    const label =
      text ?? formatDistance(distance, style.isMeasureUnitsVisible, unit)
    const at = rulerLengthLabel(sx, sy, ex, ey)
    const batch = buildText(
      label,
      at.x,
      at.y,
      0.8,
      textColor,
      at.anchorX,
      at.anchorY,
      textBack,
    )
    if (batch.count > 0) labels.push(batch)
  }
  return { lines, labels }
}
