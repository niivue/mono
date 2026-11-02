import { UI_DEFAULTS } from '@/NVConstants'
import { rulerSegments, rulerTickLabels } from '@/view/NVMeasurement'
import type { NVSlide, NVSlideScreen } from './NVSlide'
import type { NVSlideMeasurement, NVSlidePoint } from './slideController'

/** A screen-space segment in device pixels. */
export interface SlideOverlayLine {
  x0: number
  y0: number
  x1: number
  y1: number
  thickness: number
  color: number[]
}

/** Text in device pixels, anchored as NiiVue's font renderer anchors it. */
export interface SlideOverlayLabel {
  str: string
  x: number
  y: number
  scale: number
  color: number[]
  anchorX: number
  anchorY: number
  backColor?: number[]
}

/** What a slide renderer draws over the tiles. */
export interface SlideOverlayContent {
  lines: SlideOverlayLine[]
  labels: SlideOverlayLabel[]
}

/** NiiVue's ruler and selection-box styling; defaults are NiiVue's. */
export interface SlideOverlayStyle {
  measureLineColor?: number[]
  measureTextColor?: number[]
  rulerWidth?: number
  selectionBoxColor?: number[]
}

/** The gesture state an overlay shows (an NVSlideController satisfies it). */
export interface SlideOverlaySource {
  measurements: readonly NVSlideMeasurement[]
  activeMeasurement: NVSlideMeasurement | null
  selection: { start: NVSlidePoint; end: NVSlidePoint } | null
}

/**
 * Rulers and the contrast selection box as NiiVue draws them on a 2D slice:
 * a graduated ruler with per-mm ticks and its length in mm at the midpoint,
 * and the translucent box a contrast drag selects. Lengths use the slide's
 * `pixelSpacingMM`; a slide without it measures in base pixels (no ticks).
 */
export function slideOverlayContent(
  slide: NVSlide,
  screen: NVSlideScreen,
  source: SlideOverlaySource,
  style: SlideOverlayStyle = {},
): SlideOverlayContent {
  const lineColor = style.measureLineColor ?? UI_DEFAULTS.measureLineColor
  const textColor = style.measureTextColor ?? UI_DEFAULTS.measureTextColor
  const width = style.rulerWidth ?? UI_DEFAULTS.rulerWidth
  const dpr = screen.devicePixelRatio ?? 1
  const toDevice = (p: NVSlidePoint): [number, number] => {
    const { xCss, yCss } = slide.slideToScreen(p.x, p.y, screen)
    return [xCss * dpr, yCss * dpr]
  }
  const lines: SlideOverlayLine[] = []
  const labels: SlideOverlayLabel[] = []
  const textBack =
    textColor[0] + textColor[1] + textColor[2] > 0.8
      ? [0, 0, 0, 0.5]
      : [1, 1, 1, 0.5]
  const spacing = slide.manifest.pixelSpacingMM

  const rulers = source.activeMeasurement
    ? [...source.measurements, source.activeMeasurement]
    : source.measurements
  for (const { start, end } of rulers) {
    const [sx, sy] = toDevice(start)
    const [ex, ey] = toDevice(end)
    const dx = end.x - start.x
    const dy = end.y - start.y
    const mm = spacing ? Math.hypot(dx * spacing[0], dy * spacing[1]) : 0
    for (const [x0, y0, x1, y1] of rulerSegments(sx, sy, ex, ey, mm, width)) {
      lines.push({ x0, y0, x1, y1, thickness: width, color: lineColor })
    }
    for (const t of rulerTickLabels(sx, sy, ex, ey, mm)) {
      labels.push({
        str: t.str,
        x: t.x,
        y: t.y,
        scale: 0.5,
        color: textColor,
        anchorX: 0.5,
        anchorY: 0.5,
      })
    }
    // NiiVue's decimals: fewer as the length grows.
    const str = spacing
      ? `${mm.toFixed(mm > 99 ? 0 : mm > 9 ? 1 : 2)} mm`
      : `${Math.round(Math.hypot(dx, dy))} px`
    labels.push({
      str,
      x: (sx + ex) / 2,
      y: (sy + ey) / 2,
      scale: 0.8,
      color: textColor,
      anchorX: 0.5,
      anchorY: 1,
      backColor: textBack,
    })
  }

  if (source.selection) {
    const [ax, ay] = toDevice(source.selection.start)
    const [bx, by] = toDevice(source.selection.end)
    // A filled translucent box, as NiiVue's: one line as thick as the box.
    const midY = (ay + by) / 2
    lines.push({
      x0: Math.min(ax, bx),
      y0: midY,
      x1: Math.max(ax, bx),
      y1: midY,
      thickness: Math.abs(by - ay),
      color: style.selectionBoxColor ?? UI_DEFAULTS.selectionBoxColor,
    })
  }
  return { lines, labels }
}
