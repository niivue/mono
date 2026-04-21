import type { ColorbarInfo } from "@/NVTypes"
import type { BuildTextFn, GlyphBatch } from "./NVFont"
import { estimateFontSize } from "./NVUILayout"

export function deriveBorderColor(
  backColor: [number, number, number, number],
): [number, number, number, number] {
  const lum = backColor[0] + backColor[1] + backColor[2]
  return lum < 0.6 ? [0.2, 0.2, 0.2, 1] : [0, 0, 0, 1]
}

export type ColorbarLayout = {
  margin: number
  heightRatio: number
  gap: number
  canvasWidth: number
  canvasHeight: number
  borderColor: number[]
  /**
   * Actual text renderer output size in device pixels (what the font
   * renderer will rasterize glyphs at). Use `0` when unknown — the layout
   * falls back to the legacy area-based estimate. When non-zero, the
   * layout uses `max(fontPx, estimateFontSize(...))` so slider-cranked
   * `fontScale` values grow the bottom allocation and keep labels on
   * canvas, while the default case (where the legacy area-based estimate
   * is >= actual) preserves the pre-existing visual.
   */
  fontPx: number
}

export type ColorbarRect = { x: number; y: number; w: number; h: number }

export const COLORBAR_GAP = 16
const MIN_COLORBAR_ASPECT = 42
const FONT_XADV = 0.55
const FONT_BACK_PAD = 0.3

// Labels anchor at bar center (anchorY=0) and descend: fontSize to baseline,
// plus FONT_BACK_PAD * fontSize backing padding below. Total overhang below bar:
//   fontSize * (1 + FONT_BACK_PAD) - barHeight / 2
function estimateLabelOverhang(fontSize: number, barHeight: number): number {
  return Math.max(0, fontSize * (1 + FONT_BACK_PAD) - barHeight * 0.5)
}

function estimateLabelHalfWidth(label: string, fontSize: number): number {
  const textWidth = label.length * fontSize * FONT_XADV
  const backingWidth = textWidth + 2 * fontSize * FONT_BACK_PAD
  return Math.ceil(backingWidth * 0.5)
}

function estimateEdgeOverhangs(
  colorbars: ColorbarInfo[],
  fontSize: number,
): { left: number; right: number } {
  let maxLeft = 0
  let maxRight = 0
  for (const info of colorbars) {
    const range = info.max - info.min
    if (range <= 0) continue
    const [spacing, ticMinRaw] = calculateTickSpacing(info.min, info.max)
    const firstTic = ticMinRaw < info.min ? ticMinRaw + spacing : ticMinRaw
    let lastTic = firstTic
    let tic = firstTic
    while (tic <= info.max) {
      lastTic = tic
      tic += spacing
    }
    const firstLabel = humanize(info.isNegative ? -firstTic : firstTic)
    const lastLabel = humanize(info.isNegative ? -lastTic : lastTic)
    maxLeft = Math.max(maxLeft, estimateLabelHalfWidth(firstLabel, fontSize))
    maxRight = Math.max(maxRight, estimateLabelHalfWidth(lastLabel, fontSize))
  }
  return { left: maxLeft, right: maxRight }
}

// Prefer the actual rasterized `fontPx` when the backend passed one
// through; otherwise fall back to the legacy area-based estimate. Use
// `max(...)` so the default case (where legacy >= actual) preserves the
// pre-existing visual, while slider-cranked `fontScale` values let the
// layout grow and keep labels on canvas.
function resolveFontSize(layout: ColorbarLayout): number {
  const legacy = estimateFontSize(layout.canvasWidth, layout.canvasHeight)
  return Math.max(layout.fontPx, legacy)
}

// Bottom cushion below the deepest label backing, in pixels. Scales with
// font size so tiny fonts don't look like they're swimming in a fixed
// margin, and large fonts keep a proportional breathing room. Floor at
// 1 px guarantees the backing never bleeds past the canvas edge even
// when `0.1 * fontSize` rounds down.
function bottomCushion(fontSize: number): number {
  return Math.max(1, 0.1 * fontSize)
}

// Vertical span the colorbar block reserves at the bottom of the canvas:
// top gutter + all bars + inter-row gaps + bottom cushion. `gap` only
// applies BETWEEN rows — a single-row colorbar doesn't need a trailing
// gap. Fixes a pre-existing bug in which `rows * (barHeight + gap)`
// allocated a stale `gap` of dead space below the last row.
function computeColorbarBlockSpan(
  rows: number,
  barHeight: number,
  gap: number,
  margin: number,
  bottomMarginPx: number,
): number {
  const interRowGap = Math.max(0, rows - 1) * gap
  return margin + rows * barHeight + interRowGap + bottomMarginPx
}

export function colorbarGridLayout(
  colorbars: ColorbarInfo[],
  layout: ColorbarLayout,
): { columns: number; rows: number; rects: ColorbarRect[] } {
  if (colorbars.length <= 0) return { columns: 0, rows: 0, rects: [] }
  const { margin, heightRatio, gap, canvasWidth, canvasHeight } = layout
  const fontSize = resolveFontSize(layout)
  const barHeight = Math.ceil(heightRatio * fontSize)
  const fullAspect = canvasWidth / barHeight
  const maxColumns = Math.floor(fullAspect / MIN_COLORBAR_ASPECT) + 1
  const columns = Math.min(maxColumns, colorbars.length)
  const rows = Math.ceil(colorbars.length / columns)
  const { left: leftPad, right: rightPad } = estimateEdgeOverhangs(
    colorbars,
    fontSize,
  )
  const totalWidth = canvasWidth - 2 * margin - leftPad - rightPad
  const colGap = columns > 1 ? Math.max(gap, leftPad + rightPad) : 0
  const barWidth =
    columns > 1 ? (totalWidth - (columns - 1) * colGap) / columns : totalWidth
  const rects: ColorbarRect[] = []
  const bottomMargin = Math.ceil(
    estimateLabelOverhang(fontSize, barHeight) + bottomCushion(fontSize),
  )
  const totalHeight = computeColorbarBlockSpan(
    rows,
    barHeight,
    gap,
    margin,
    bottomMargin,
  )
  const yBase = canvasHeight - totalHeight
  for (let i = 0; i < colorbars.length; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    const x = margin + leftPad + col * (barWidth + colGap)
    const y = yBase + margin + row * (barHeight + gap)
    rects.push({ x, y, w: barWidth, h: barHeight })
  }
  return { columns, rows, rects }
}

function nice(x: number, round: boolean): number {
  const exp = Math.floor(Math.log(x) / Math.log(10))
  const f = x / 10 ** exp
  let nf: number
  if (round) {
    if (f < 1.5) nf = 1
    else if (f < 3) nf = 2
    else if (f < 7) nf = 5
    else nf = 10
  } else {
    if (f <= 1) nf = 1
    else if (f <= 2) nf = 2
    else if (f <= 5) nf = 5
    else nf = 10
  }
  return nf * 10 ** exp
}

function calculateTickSpacing(
  min: number,
  max: number,
): [spacing: number, ticMin: number, ticMax: number] {
  const range = max - min
  if (range <= 0) return [1, min, max]
  const maxTicks = 5
  const niceRange = nice(range, false)
  const spacing = nice(niceRange / (maxTicks - 1), true)
  const ticMin = Math.floor(min / spacing) * spacing
  const ticMax = Math.ceil(max / spacing) * spacing
  return [spacing, ticMin, ticMax]
}

function humanize(x: number): string {
  return x.toFixed(6).replace(/\.?0*$/, "")
}

function emptyPanel(
  rect: number[],
  color: number[],
  radius: number,
): GlyphBatch {
  return {
    data: new Float32Array(0),
    count: 0,
    backColor: color,
    backRect: rect,
    backRadius: radius,
  }
}

export function colorbarTotalHeight(
  colorbars: ColorbarInfo[],
  layout: ColorbarLayout,
): number {
  if (colorbars.length <= 0) return 0
  const { rows } = colorbarGridLayout(colorbars, layout)
  const fontSize = resolveFontSize(layout)
  const barHeight = Math.ceil(layout.heightRatio * fontSize)
  const bottomMargin = Math.ceil(
    estimateLabelOverhang(fontSize, barHeight) + bottomCushion(fontSize),
  )
  return computeColorbarBlockSpan(
    rows,
    barHeight,
    layout.gap,
    layout.margin,
    bottomMargin,
  )
}

export function buildColorbarLabels(
  colorbars: ColorbarInfo[],
  buildText: BuildTextFn,
  layout: ColorbarLayout,
): GlyphBatch[] {
  const { borderColor } = layout
  const { rects } = colorbarGridLayout(colorbars, layout)
  if (rects.length === 0) return []
  const results: GlyphBatch[] = []
  const dotRadius = 3
  const textBackColor = [borderColor[0], borderColor[1], borderColor[2], 0.75]
  const textColor = [1, 1, 1, 1]

  for (let i = 0; i < colorbars.length; i++) {
    const info = colorbars[i]
    const rect = rects[i]
    const barX = rect.x
    const barY = rect.y
    const barWidth = rect.w
    const barCenterY = barY + rect.h * 0.5
    const range = info.max - info.min
    if (range <= 0) continue

    const [spacing, ticMinRaw] = calculateTickSpacing(info.min, info.max)
    let tic = ticMinRaw < info.min ? ticMinRaw + spacing : ticMinRaw

    while (tic <= info.max) {
      const frac = (tic - info.min) / range
      const xPx = barX + frac * barWidth

      // Tick dot (small circle at bar center)
      results.push(
        emptyPanel(
          [
            xPx - dotRadius,
            barCenterY - dotRadius,
            dotRadius * 2,
            dotRadius * 2,
          ],
          borderColor,
          dotRadius,
        ),
      )

      // Text label (descends from bar center)
      const labelValue = info.isNegative ? -tic : tic
      results.push(
        buildText(
          humanize(labelValue),
          xPx,
          barCenterY,
          1.0,
          textColor,
          0.5,
          0,
          textBackColor,
        ),
      )

      tic += spacing
    }

    // Threshold line for ZERO_TO_MAX types
    if (info.thresholdMin !== undefined && info.thresholdMin > info.min) {
      const threshFrac = (info.thresholdMin - info.min) / range
      const threshX = barX + threshFrac * barWidth
      results.push(
        emptyPanel(
          [threshX - dotRadius, barY, dotRadius * 2, rect.h],
          borderColor,
          dotRadius,
        ),
      )
    }
  }

  return results
}
