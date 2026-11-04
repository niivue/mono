import { UI_DEFAULTS } from '@/NVConstants'
import type { UIConfig } from '@/NVTypes'
import type { BuildTextFn } from '@/view/NVFont'
import type { BuildLineFn } from '@/view/NVLine'
import {
  buildRulers,
  type MeasurementResult,
  type ScreenRuler,
} from '@/view/NVMeasurement'
import type { NVSlide, NVSlideScreen } from './NVSlide'
import type { NVSlideController, NVSlidePoint } from './slideController'

/** Overlay capacity: lines and glyphs a slide renderer draws per frame. */
export const SLIDE_OVERLAY_MAX_LINES = 1024
export const SLIDE_OVERLAY_MAX_GLYPHS = 2048

/** NiiVue's ruler and selection-box styling. */
export type SlideOverlayStyle = Pick<
  UIConfig,
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
  style: SlideOverlayStyle
}

/**
 * Rulers and the contrast selection box, placed for the slide's current view.
 * Lengths use the slide's `pixelSpacingMM` (a sub-millimetre span reads in
 * micrometres, "180.0 um"); without it a ruler has no ticks and reads in base
 * pixels.
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
  return { rulers, box, style: { ...UI_DEFAULTS, ...style } }
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
  return out
}
