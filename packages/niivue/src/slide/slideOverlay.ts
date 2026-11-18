import { UI_DEFAULTS } from '@/NVConstants'
import type { RulerUnits, UIConfig } from '@/NVTypes'
import type { BuildTextFn } from '@/view/NVFont'
import type { BuildLineFn } from '@/view/NVLine'
import {
  buildRulers,
  type MeasurementResult,
  type ScreenRuler,
} from '@/view/NVMeasurement'
import { chooseRulerSize, scaleBarLines } from '@/view/NVRuler'
import type { NVSlide, NVSlideScreen } from './NVSlide'
import {
  isClosedSlideTool,
  type SlideAnnotationStats,
  type SlideAnnotationTool,
  slideAnnotationHandles,
  slideAnnotationOutline,
  slideAnnotationStats,
} from './slideAnnotations'
import type { NVSlideController, NVSlidePoint } from './slideController'

/** Overlay capacity: lines and glyphs a slide renderer draws per frame. */
export const SLIDE_OVERLAY_MAX_LINES = 4096
export const SLIDE_OVERLAY_MAX_GLYPHS = 2048

/** NiiVue's ruler, scale bar (`isRulerVisible`) and selection-box styling. */
export type SlideOverlayStyle = Pick<
  UIConfig,
  | 'isRulerVisible'
  | 'fontColor'
  | 'measureLineColor'
  | 'measureTextColor'
  | 'rulerWidth'
  | 'rulerUnits'
  | 'isMeasureUnitsVisible'
  | 'selectionBoxColor'
>

/** The gesture state an overlay shows. */
export type SlideOverlaySource = Pick<
  NVSlideController,
  'measurements' | 'activeMeasurement' | 'selection'
> &
  Partial<
    Pick<
      NVSlideController,
      'annotations' | 'draft' | 'edit' | 'selectedAnnotation'
    >
  >

/** What a slide renderer draws over the tiles, in device pixels. */
export interface SlideOverlayContent {
  rulers: ScreenRuler[]
  /** Annotation outlines as segments, x0 y0 x1 y1 each; off-screen ones culled. */
  segments: number[]
  /** Annotation labels: text with its lower-left corner at x, y. */
  labels: Array<{ x: number; y: number; text: string }>
  /** The selected annotation's edit handles: x, y, half-size each. */
  handles: number[]
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
 * and its label ("100 um" below 1 mm, or in `units`), at most ~a quarter of
 * `maxDevicePx`. Null without spacing, or when the bar would be a sliver.
 */
export function slideScaleBar(
  spacingMM: number | undefined,
  devicePxPerBase: number,
  maxDevicePx: number,
  units: RulerUnits = 'auto',
): { lengthPx: number; label: string } | null {
  if (!spacingMM || !(devicePxPerBase > 0)) return null
  const mmPerPx = spacingMM / devicePxPerBase
  // chooseRulerSize caps the bar at 65% of its field: 0.4 keeps it near 26%.
  const ruler = chooseRulerSize(maxDevicePx * mmPerPx * 0.4, units)
  const lengthPx = ruler ? ruler.lengthMM / mmPerPx : 0
  // No bar under 2% of the view.
  return ruler && lengthPx >= maxDevicePx / 50
    ? { lengthPx, label: ruler.label }
    : null
}

// Sub-millimetre sizes read in micrometres, the scale most slides live at.
// ASCII only: the font atlas has no micro or superscript glyphs.
function formatLength(v: number, unit: 'mm' | 'px'): string {
  if (unit === 'px') return `${Math.round(v)} px`
  return v < 1 ? `${(v * 1000).toFixed(1)} um` : `${v.toFixed(2)} mm`
}

function formatArea(v: number, unit: 'mm' | 'px'): string {
  if (unit === 'px') return `${Math.round(v)} px2`
  if (v >= 1) return `${v.toFixed(3)} mm2`
  const um2 = v * 1e6
  // Sub-micrometre pixels make areas below 1 um2; whole numbers would read 0.
  return `${um2 >= 1 || um2 === 0 ? um2.toFixed(0) : um2.toPrecision(2)} um2`
}

/** An annotation's overlay text: its label, then its area or length. */
export function slideAnnotationText(
  label: string,
  stats: SlideAnnotationStats,
): string {
  const size =
    stats.area !== undefined
      ? formatArea(stats.area, stats.unit)
      : stats.length !== undefined
        ? formatLength(stats.length, stats.unit)
        : ''
  return [label, size].filter(Boolean).join(' ')
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
  const ruler = ({
    start,
    end,
  }: {
    start: NVSlidePoint
    end: NVSlidePoint
  }) => {
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
  }
  const rulers: ScreenRuler[] = all.map(ruler)
  const segments: number[] = []
  const labels: SlideOverlayContent['labels'] = []
  const W = screen.widthCss * dpr
  const H = screen.heightCss * dpr
  const onScreen = (x0: number, y0: number, x1: number, y1: number) => {
    if (
      Math.max(x0, x1) < 0 ||
      Math.min(x0, x1) > W ||
      Math.max(y0, y1) < 0 ||
      Math.min(y0, y1) > H
    )
      return false
    // A diagonal's box can overlap the view while the line passes a corner:
    // it crosses the view only if the corners are not all on one side of it.
    const dx = x1 - x0
    const dy = y1 - y0
    const side = (x: number, y: number) => dx * (y - y0) - dy * (x - x0)
    const sides = [side(0, 0), side(W, 0), side(0, H), side(W, H)]
    return Math.min(...sides) <= 0 && Math.max(...sides) >= 0
  }
  const segment = (x0: number, y0: number, x1: number, y1: number) => {
    if (onScreen(x0, y0, x1, y1)) segments.push(x0, y0, x1, y1)
  }
  const shape = (
    tool: SlideAnnotationTool,
    points: NVSlidePoint[],
    label: string,
    stats: SlideAnnotationStats | null,
  ) => {
    if (tool === 'line') {
      const [start, end] = points as [NVSlidePoint, NVSlidePoint]
      const r = ruler({ start, end })
      // Off-screen lines would fill the renderer's line cap before visible ones.
      if (!onScreen(r.sx, r.sy, r.ex, r.ey)) return
      rulers.push(r)
      if (label) labels.push({ x: r.ex + 4 * dpr, y: r.ey, text: label })
      return
    }
    const outline = slideAnnotationOutline(tool, points).map(toDevice)
    // A press not yet dragged: an ellipse or circle with no size.
    if (!outline[0]) return
    const drawn = segments.length
    let [px, py] = outline[0]
    let right = px
    let top = py
    if (tool === 'point') {
      const r = 4 * dpr
      segment(px - r, py, px + r, py)
      segment(px, py - r, px, py + r)
    }
    // Vertices under a device pixel apart add lines, not detail.
    for (const [x, y] of outline.slice(1)) {
      if (Math.abs(x - px) < 1 && Math.abs(y - py) < 1) continue
      segment(px, py, x, y)
      px = x
      py = y
      right = Math.max(right, x)
      top = Math.min(top, y)
    }
    if (isClosedSlideTool(tool)) {
      const [x0, y0] = outline[0] as [number, number]
      segment(px, py, x0, y0)
    }
    const text = stats ? slideAnnotationText(label, stats) : label
    // Kept on screen while any of the shape is (zoomed into a large ROI).
    if (text && segments.length > drawn)
      labels.push({
        x: Math.min(right, W) + 4 * dpr,
        y: Math.max(top, 0),
        text,
      })
  }
  const edit = source.edit
  const handles: number[] = []
  for (const a of source.annotations?.list() ?? []) {
    const points = edit?.id === a.id ? edit.points : a.points
    shape(
      a.tool,
      points,
      a.label,
      points === a.points
        ? a.stats
        : slideAnnotationStats(a.tool, points, spacing),
    )
    if (a.id === source.selectedAnnotation)
      for (const h of slideAnnotationHandles(a.tool, points))
        handles.push(...toDevice(h), 4 * dpr)
  }
  const draft = source.draft
  if (draft) {
    // A polygon being clicked is an open path until it closes.
    const isPolygon = draft.tool === 'polygon'
    shape(
      isPolygon ? 'freehandLine' : draft.tool,
      draft.points,
      '',
      isPolygon
        ? null
        : slideAnnotationStats(draft.tool, draft.points, spacing),
    )
  }
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
      fullStyle.rulerUnits,
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
  return {
    rulers,
    segments,
    labels,
    handles,
    box,
    scaleBar,
    style: fullStyle,
  }
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
  // Handles as NiiVue's: white squares edged dark.
  const h = content.handles
  for (let i = 0; i < h.length; i += 3) {
    const [x, y, r] = [h[i] as number, h[i + 1] as number, h[i + 2] as number]
    out.lines.push(
      buildLine(x - r - 1, y, x + r + 1, y, 2 * r + 2, [0.2, 0.2, 0.2, 1]),
      buildLine(x - r, y, x + r, y, 2 * r, [1, 1, 1, 0.9]),
    )
  }
  // Last: past the line cap, annotations drop before the rulers and the bar.
  const { measureLineColor, measureTextColor, rulerWidth } = content.style
  const s = content.segments
  for (let i = 0; i < s.length; i += 4)
    out.lines.push(
      buildLine(
        s[i] as number,
        s[i + 1] as number,
        s[i + 2] as number,
        s[i + 3] as number,
        rulerWidth,
        measureLineColor,
      ),
    )
  for (const { x, y, text } of content.labels) {
    const batch = buildText(text, x, y, 0.8, measureTextColor, 0, 1)
    if (batch.count > 0) out.labels.push(batch)
  }
  return out
}
