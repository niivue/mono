import { UI_DEFAULTS } from '@/NVConstants'
import type { UIConfig } from '@/NVTypes'
import type { BuildTextFn } from '@/view/NVFont'
import type { BuildLineFn } from '@/view/NVLine'
import {
  buildRulers,
  type MeasurementResult,
  type ScreenRuler,
} from '@/view/NVMeasurement'
import { chooseRulerSize, scaleBarLines } from '@/view/NVRuler'
import type { NVSlide, NVSlideScreen } from './NVSlide'
import type { NVSlideController, NVSlidePoint } from './slideController'

/** Overlay capacity: lines and glyphs a slide renderer draws per frame. */
export const SLIDE_OVERLAY_MAX_LINES = 1024
export const SLIDE_OVERLAY_MAX_GLYPHS = 2048

/** NiiVue's ruler, scale bar (`isRulerVisible`) and selection-box styling. */
export type SlideOverlayStyle = Pick<
  UIConfig,
  | 'isRulerVisible'
  | 'fontColor'
  | 'measureLineColor'
  | 'measureTextColor'
  | 'rulerWidth'
  | 'isMeasureUnitsVisible'
  | 'selectionBoxColor'
>

/** The gesture state an overlay shows. */
export type SlideOverlaySource = Pick<
  NVSlideController,
  'measurements' | 'activeMeasurement' | 'selection'
>

/** What a slide renderer draws over the tiles, in device pixels. */
export interface SlideOverlayContent {
  rulers: ScreenRuler[]
  box: { x0: number; y0: number; x1: number; y1: number } | null
  scaleBar: {
    x: number
    y: number
    lengthPx: number
    thickness: number
    label: string
  } | null
  style: SlideOverlayStyle
}

/**
 * A nice scale-bar length (1/2/5 x 10^n, as the volume ruler) in device pixels
 * and its label ("100 um" below 1 mm), at most ~a quarter of `maxDevicePx`.
 * Null without spacing or when the field outgrows the 10 cm top step.
 */
export function slideScaleBar(
  spacingMM: number | undefined,
  devicePxPerBase: number,
  maxDevicePx: number,
): { lengthPx: number; label: string } | null {
  if (!spacingMM || !(devicePxPerBase > 0)) return null
  const mmPerPx = spacingMM / devicePxPerBase
  // chooseRulerSize caps the bar at 65% of its field: 0.4 keeps it near 26%.
  const ruler = chooseRulerSize(maxDevicePx * mmPerPx * 0.4)
  const lengthPx = ruler ? ruler.lengthMM / mmPerPx : 0
  // The ladder tops out at 10 cm; a field far wider leaves a sliver, so skip it.
  return ruler && lengthPx >= maxDevicePx / 50
    ? { lengthPx, label: ruler.label }
    : null
}

/**
 * Rulers and the contrast selection box, placed for the slide's current view.
 * Lengths use the slide's `pixelSpacingMM` (a sub-millimetre span reads in
 * micrometres, "180.0 um"); without it a ruler has no ticks and reads in base
 * pixels. `style.isRulerVisible` adds a bottom-left scale bar (horizontal
 * spacing; none without it).
 */
export function slideOverlayContent(
  slide: NVSlide,
  screen: NVSlideScreen,
  source: SlideOverlaySource,
  style: Partial<SlideOverlayStyle> = {},
): SlideOverlayContent {
  const dpr = screen.devicePixelRatio ?? 1
  const toDevice = (p: NVSlidePoint): [number, number] => {
    const { xCss, yCss } = slide.slideToScreen(p.x, p.y, screen)
    return [xCss * dpr, yCss * dpr]
  }
  const spacing = slide.manifest.pixelSpacingMM
  const all = source.activeMeasurement
    ? [...source.measurements, source.activeMeasurement]
    : source.measurements
  const rulers = all.map(({ start, end }): ScreenRuler => {
    const [sx, sy] = toDevice(start)
    const [ex, ey] = toDevice(end)
    const dx = end.x - start.x
    const dy = end.y - start.y
    if (spacing) {
      const mm = Math.hypot(dx * spacing[0], dy * spacing[1])
      // Sub-millimetre spans read in micrometres, the scale most slides live at.
      const label = mm < 1 ? `${(mm * 1000).toFixed(1)} um` : undefined
      return { sx, sy, ex, ey, distance: mm, label }
    }
    const label = `${Math.round(Math.hypot(dx, dy))} px`
    return { sx, sy, ex, ey, distance: 0, label }
  })
  let box: SlideOverlayContent['box'] = null
  if (source.selection) {
    const [x0, y0] = toDevice(source.selection.start)
    const [x1, y1] = toDevice(source.selection.end)
    box = { x0, y0, x1, y1 }
  }
  const fullStyle = { ...UI_DEFAULTS, ...style }
  const bar =
    fullStyle.isRulerVisible &&
    slideScaleBar(
      spacing?.[0],
      slide.viewport.scale * dpr,
      screen.widthCss * dpr,
    )
  const inset = 12 * dpr
  const scaleBar = bar
    ? {
        ...bar,
        x: inset,
        y: screen.heightCss * dpr - inset,
        thickness: 4 * dpr,
      }
    : null
  return { rulers, box, scaleBar, style: fullStyle }
}

/** The overlay as line and glyph batches, for either backend's renderers. */
export function buildSlideOverlay(
  content: SlideOverlayContent,
  buildText: BuildTextFn,
  buildLine: BuildLineFn,
  numberPx: number,
): MeasurementResult {
  const out = buildRulers(
    content.rulers,
    content.style,
    buildText,
    buildLine,
    numberPx,
  )
  const b = content.box
  if (b) {
    // A filled translucent box, as NiiVue's: one line as thick as the box.
    const midY = (b.y0 + b.y1) / 2
    out.lines.push(
      buildLine(
        Math.min(b.x0, b.x1),
        midY,
        Math.max(b.x0, b.x1),
        midY,
        Math.abs(b.y1 - b.y0),
        content.style.selectionBoxColor,
      ),
    )
  }
  const bar = content.scaleBar
  if (bar) {
    const color = content.style.fontColor
    // A translucent backing keeps the grey bar legible over bright tissue.
    // The label is 0.8 x fontPx tall, ~2 x numberPx (half fontPx) with leading.
    const pad = bar.thickness
    const top = bar.y - bar.thickness - 2 * numberPx - pad / 2
    const bottom = bar.y + bar.thickness / 2 + pad
    out.lines.push(
      buildLine(
        bar.x - pad,
        (top + bottom) / 2,
        bar.x + bar.lengthPx + pad,
        (top + bottom) / 2,
        bottom - top,
        [0, 0, 0, 0.75],
      ),
      ...scaleBarLines(
        bar.x,
        bar.y,
        bar.lengthPx,
        bar.thickness,
        bar.thickness / 4,
        buildLine,
        color,
      ),
    )
    const label = buildText(
      bar.label,
      bar.x + bar.lengthPx / 2,
      bar.y - bar.thickness,
      0.8,
      color,
      0.5,
      1,
    )
    if (label.count > 0) out.labels.push(label)
  }
  return out
}
