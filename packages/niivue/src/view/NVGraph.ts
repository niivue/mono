import type { GraphConfig } from '@/NVTypes'
import type { BuildTextFn, GlyphBatch } from './NVFont'
import type { BuildLineFn, LineData } from './NVLine'
import { estimateFontSize } from './NVUILayout'

/** A single colored trace for the multi-series (signal) graph mode. */
export type GraphSeries = {
  label: string
  /** independent-axis values; null means a plain 0..n-1 index */
  x: ArrayLike<number> | null
  y: ArrayLike<number>
  /**
   * optional un-normalized values (same length as `y`) used for the cursor
   * readout when `y` has been scaled for display (e.g. the association view).
   */
  rawY?: ArrayLike<number>
  /** optional RGBA [0..1] override; otherwise a palette color is assigned */
  color?: [number, number, number, number]
  /**
   * x-axis positions of this measure's BIDS event triggers (numeric, non-zero
   * cells of its "<label>_trigger" column, NOT the plain scanner-volume
   * "trigger"), drawn as a tick rug along the TOP of the plot (mirrors the bottom
   * missing-data rug). Absent when the signal has no matching trigger column.
   */
  triggers?: number[]
}

/** Independent-axis description for the multi-series (signal) graph mode. */
export type GraphAxis = {
  label: string
  /** draw high-to-low (MR ppm convention) */
  reversed: boolean
  /** fixed window; null autoscales to the data */
  min: number | null
  max: number | null
}

/**
 * A text label anchored to a position in signal-graph data space. Mapped through
 * the same axis window as the series, so it translates as the graph is panned or
 * zoomed and is omitted when its x is outside the visible window. A y of
 * `-Infinity`/`+Infinity` pins the label to the bottom/top of the plot area.
 */
export type GraphAnnotation = {
  text: string
  x: number
  y: number
  color?: [number, number, number, number]
}

export type GraphData = {
  lines: number[][]
  selectedColumn: number
  calMin: number
  calMax: number
  nTotalFrame4D: number
  graphConfig: GraphConfig
  /**
   * When present and non-empty, the graph renders in multi-series "signal"
   * mode: each series is drawn in its own color with a real-valued (optionally
   * reversed/windowed) x-axis and a legend. When absent, the legacy
   * single-line 4D-volume time-course path is used.
   */
  series?: GraphSeries[]
  xAxis?: GraphAxis
  /** legend toggle for signal mode (default true when more than one series) */
  showLegend?: boolean
  /**
   * Signal mode only: when true (no spatial data in the scene), the graph
   * expands to fill the whole instance area instead of the right-hand strip.
   */
  fullCanvas?: boolean
  /**
   * Signal mode only: x-axis value of the selected cursor, drawn as a faint
   * vertical line. null hides the cursor.
   */
  cursorX?: number | null
  /**
   * Signal mode only: text labels anchored to data-space positions, mapped
   * through the visible x-window (hidden when out of range).
   */
  annotations?: GraphAnnotation[]
  /**
   * Signal mode only: the FULL x-domain before any zoom/pan view window is
   * applied. Derived from the input axis by `applyGraphViewWindow` on every
   * collect (not persisted) and stamped here so `graphZoom`/`graphPan` can
   * re-derive the window/orientation from a fresh collect without drift.
   */
  fullXDomain?: [number, number]
}

/** Pan/zoom control buttons drawn at the bottom of a dense signal graph. */
export type GraphControlId = 'panLeft' | 'zoomOut' | 'zoomIn' | 'panRight'
export type GraphControl = {
  id: GraphControlId
  label: string
  /** box rect in canvas pixels */
  x: number
  y: number
  w: number
  h: number
  /** true when the action is a no-op (drawn grey, not hit-tested) */
  disabled: boolean
}

export type GraphLayout = {
  /** Left edge of the graph area in canvas pixels */
  x: number
  /** Top edge of the graph area in canvas pixels */
  y: number
  /** Total width of the graph (including margins/labels) */
  width: number
  /** Total height of the graph */
  height: number
  /** Plot area (inner area where lines are drawn) [left, top, width, height] */
  plotLTWH: number[]
  /** Number of data points (frames) */
  nFrames: number
  /** Whether extra frames exist beyond what is loaded */
  hasDeferred: boolean
  /** Multi-series signal mode (no frame selection / deferred ellipsis) */
  isSignal: boolean
  /** Font scale multiplier for buildText (same convention as legend) */
  fontScale: number
  /** Estimated font pixel size for positioning calculations */
  fontSize: number
  /** Device pixel ratio for line thickness scaling */
  dpr: number
  /** Signal mode: pan/zoom buttons (only for dense graphs); else undefined */
  controls?: GraphControl[]
}

// Show the pan/zoom controls only once a signal graph has more samples than fit
// comfortably across the plot, so individual samples are otherwise unreadable.
const CONTROL_MIN_POINTS = 20

/**
 * Lay out the bottom-row pan/zoom buttons (left-aligned, on the axis-title row).
 * Each button is flagged `disabled` when its action is a no-op given the current
 * view `window` vs the `full` x-extent (full view, or window already at an edge,
 * or at the zoom-in limit).
 */
function computeGraphControls(
  pL: number,
  plotBottom: number,
  fontSize: number,
  window: [number, number],
  full: [number, number],
  reversed: boolean,
): GraphControl[] {
  const w = fontSize * 1.4
  const h = fontSize * 1.4
  const gap = fontSize * 0.3
  const y = plotBottom + fontSize * 0.8
  const [lo, hi] = window
  const [f0, f1] = full
  const fullW = Math.max(1e-9, f1 - f0)
  const eps = fullW * 1e-4
  const atDataMin = lo <= f0 + eps
  const atDataMax = hi >= f1 - eps
  const atFull = atDataMin && atDataMax
  const atMinWidth = hi - lo <= (fullW / 1000) * (1 + 1e-4)
  // On a reversed (ppm) axis the screen-left edge is the data MAX, so the
  // pan-left/right disabled edges swap.
  const atScreenLeft = reversed ? atDataMax : atDataMin
  const atScreenRight = reversed ? atDataMin : atDataMax
  const disabled: Record<GraphControlId, boolean> = {
    panLeft: atFull || atScreenLeft,
    zoomOut: atFull,
    zoomIn: atMinWidth,
    panRight: atFull || atScreenRight,
  }
  const defs: [GraphControlId, string][] = [
    ['panLeft', '<'],
    ['zoomOut', '-'],
    ['zoomIn', '+'],
    ['panRight', '>'],
  ]
  // Start one button-width in from the plot's left edge so the buttons clear the
  // leftmost x-axis label (often "0").
  return defs.map(([id, label], i) => ({
    id,
    label,
    x: pL + (i + 1) * (w + gap),
    y,
    w,
    h,
    disabled: disabled[id],
  }))
}

// Layout constants (em = multiples of fontSize for DPI-consistent spacing)
const GRAPH_OUTER_MARGIN_EM = 0.6 // Backing rect inset from canvas edge
const GRAPH_TOP_EM = 1.5 // Top padding above plot area
const GRAPH_BOTTOM_EM = 4.0 // Bottom: X-axis tick labels + "Volume" label + padding
const GRAPH_RIGHT_EM = 1.5 // Right padding (room for rightmost X label overhang)
const GRAPH_Y_GAP_EM = 0.3 // Gap between Y-axis labels and plot left edge
const GRAPH_WIDTH_RATIO = 0.25
const GRAPH_MIN_WIDTH = 120
const GRAPH_MAX_WIDTH = 4096
const FONT_XADV = 0.55
const GRAPH_FONT_SCALE = 0.7 // Multiplier for buildText (same convention as legend's 0.8)
const LINE_THICKNESS = 2 // Base thickness for all lines (scaled by DPR)
const LINE_RGB = [0.8, 0, 0]
const LEGEND_MAX_ROWS = 12 // Cap signal legend rows (overflow -> "+N more")
const CURSOR_ALPHA = 0.5 // Faint vertical cursor line
const GUIDE_ALPHA = 0.35 // Faint vertical guide for edge-pinned annotations

// Color-blind-safe categorical palette (Okabe-Ito) for multi-series signals.
const SERIES_PALETTE: [number, number, number, number][] = [
  [0.0, 0.447, 0.698, 1], // blue
  [0.902, 0.624, 0.0, 1], // orange
  [0.0, 0.62, 0.451, 1], // bluish green
  [0.8, 0.475, 0.655, 1], // reddish purple
  [0.337, 0.706, 0.914, 1], // sky blue
  [0.835, 0.369, 0.0, 1], // vermilion
  [0.941, 0.894, 0.259, 1], // yellow
  [0.0, 0.0, 0.0, 1], // black
]

/** Whether GraphData is in multi-series signal mode. */
function isSignalMode(data: GraphData): boolean {
  return !!data.series && data.series.length > 0
}

function seriesColor(
  s: GraphSeries,
  i: number,
): [number, number, number, number] {
  return s.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length]
}

function seriesX(s: GraphSeries, i: number): number {
  return s.x ? s.x[i] : i
}

/** Resolve the x-domain for signal mode (explicit window, else data extent). */
function signalXDomain(data: GraphData): [number, number] {
  const series = data.series ?? []
  const ax = data.xAxis
  if (ax && ax.min !== null && ax.max !== null && ax.min < ax.max) {
    return [ax.min, ax.max]
  }
  let mn = Number.POSITIVE_INFINITY
  let mx = Number.NEGATIVE_INFINITY
  for (const s of series) {
    for (let i = 0; i < s.y.length; i++) {
      const xv = seriesX(s, i)
      if (xv < mn) mn = xv
      if (xv > mx) mx = xv
    }
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn >= mx) {
    mn = 0
    mx = Math.max(1, (series[0]?.y.length ?? 1) - 1)
  }
  return [mn, mx]
}

/** Y-range over points inside the visible x-window (with 5% padding). */
function signalYRange(
  data: GraphData,
  xMin: number,
  xMax: number,
): [number, number] {
  let mn = Number.POSITIVE_INFINITY
  let mx = Number.NEGATIVE_INFINITY
  for (const s of data.series ?? []) {
    for (let i = 0; i < s.y.length; i++) {
      const xv = seriesX(s, i)
      if (xv < xMin || xv > xMax) continue
      const yv = s.y[i]
      if (!Number.isFinite(yv)) continue
      if (yv < mn) mn = yv
      if (yv > mx) mx = yv
    }
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
    mn = 0
    mx = 1
  }
  if (mn >= mx) mx = mn + 1
  const pad = 0.05 * (mx - mn)
  return [mn - pad, mx + pad]
}

/**
 * Clip a data-space segment (x0,y0)-(x1,y1) to the x-window [xMin,xMax],
 * interpolating y at the clipped ends. Returns [x0,y0,x1,y1] or null if the
 * segment lies entirely outside the window. Lets a line reach the plot edge even
 * when one endpoint (the previous/next sample) is off-window.
 */
export function clipSegmentX(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  xMin: number,
  xMax: number,
): [number, number, number, number] | null {
  const dx = x1 - x0
  let t0 = 0
  let t1 = 1
  if (dx === 0) {
    if (x0 < xMin || x0 > xMax) return null
  } else {
    let ta = (xMin - x0) / dx
    let tb = (xMax - x0) / dx
    if (ta > tb) {
      const t = ta
      ta = tb
      tb = t
    }
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
    if (t0 > t1) return null
  }
  const dy = y1 - y0
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy]
}

function mapSignalX(
  xv: number,
  xMin: number,
  xMax: number,
  pL: number,
  pW: number,
  reversed: boolean,
): number {
  // Guard a degenerate domain (single-x series / collapsed window): a zero span
  // would map to Infinity/NaN and corrupt the GPU line buffer.
  const span = xMax - xMin || 1
  const t = (xv - xMin) / span
  return pL + (reversed ? 1 - t : t) * pW
}

/** Map a y data value to a screen y, clamped into the plot's [pT, plotBottom]. */
function mapSignalY(
  yv: number,
  yMin: number,
  scaleH: number,
  pT: number,
  plotBottom: number,
): number {
  const sy = plotBottom - (yv - yMin) * scaleH
  return Math.max(pT, Math.min(plotBottom, sy))
}

function signalPointCount(data: GraphData): number {
  let n = 0
  for (const s of data.series ?? []) n = Math.max(n, s.y.length)
  return n
}

/**
 * Render a dense series as a per-pixel-column min/max envelope: one vertical
 * segment per column covering the range of samples that fall in it. Bounds the
 * segment count to the plot width regardless of sample count.
 */
function drawDecimatedSeries(
  s: GraphSeries,
  xMin: number,
  xMax: number,
  yMin: number,
  scaleH: number,
  pL: number,
  pT: number,
  pW: number,
  plotBottom: number,
  reversed: boolean,
  lineThick: number,
  color: number[],
  buildLine: BuildLineFn,
  out: LineData[],
): void {
  const cols = Math.max(1, Math.ceil(pW))
  const minY = new Float32Array(cols).fill(Number.POSITIVE_INFINITY)
  const maxY = new Float32Array(cols).fill(Number.NEGATIVE_INFINITY)
  for (let i = 0; i < s.y.length; i++) {
    const xv = s.x ? s.x[i] : i
    if (xv < xMin || xv > xMax) continue
    const yv = s.y[i]
    if (!Number.isFinite(yv)) continue
    const sx = mapSignalX(xv, xMin, xMax, pL, pW, reversed)
    let col = Math.round(sx - pL)
    if (col < 0) col = 0
    else if (col >= cols) col = cols - 1
    const sy = mapSignalY(yv, yMin, scaleH, pT, plotBottom)
    if (sy < minY[col]) minY[col] = sy
    if (sy > maxY[col]) maxY[col] = sy
  }
  // Connect columns into a continuous line: from the previous column up to this
  // column's min, then a vertical bar across its [min,max] range. This keeps
  // smooth signals (low per-column range) continuous instead of collapsing to
  // disconnected dots, while still showing the full envelope of dense regions.
  let havePrev = false
  let prevX = 0
  let prevY = 0
  for (let col = 0; col < cols; col++) {
    // Empty column = a NaN run (or window edge). Break the line so the gap is
    // not bridged by a connector, matching the non-decimated path's behaviour.
    if (maxY[col] < minY[col]) {
      havePrev = false
      continue
    }
    const x = pL + col
    if (havePrev) {
      out.push(buildLine(prevX, prevY, x, minY[col], lineThick, color))
    }
    out.push(buildLine(x, minY[col], x, maxY[col], lineThick, color))
    havePrev = true
    prevX = x
    prevY = maxY[col]
  }
}

/**
 * Mark samples that have no plottable value (BIDS `n/a` -> NaN) as short ticks
 * along the bottom axis (a "rug"). The trace itself is left gapped (missing data
 * is not interpolated); this surfaces WHERE it is missing — which is otherwise
 * invisible for a dense, decimated series. Decimation-safe: at most one tick per
 * pixel column, so a long run of gaps collapses to a bounded number of ticks.
 *
 * Each series gets its own horizontal lane (by `laneIndex`), stacked upward from
 * the bottom axis, so when two series miss the same sample their ticks sit
 * side-by-side (vertically) rather than overwriting each other.
 */
function drawMissingRug(
  s: GraphSeries,
  xMin: number,
  xMax: number,
  pL: number,
  pW: number,
  plotBottom: number,
  reversed: boolean,
  thick: number,
  laneIndex: number,
  laneH: number,
  color: number[],
  buildLine: BuildLineFn,
  out: LineData[],
): void {
  // Lane laneIndex occupies [yBottom - (laneH-1), yBottom], leaving a 1px gap
  // between adjacent series' lanes.
  const yBottom = plotBottom - laneIndex * laneH
  const yTop = yBottom - Math.max(1, laneH - 1)
  const seen = new Set<number>()
  for (let i = 0; i < s.y.length; i++) {
    if (Number.isFinite(s.y[i])) continue // present sample
    const xv = s.x ? s.x[i] : i
    if (xv < xMin || xv > xMax) continue // outside the visible window
    const px = Math.round(mapSignalX(xv, xMin, xMax, pL, pW, reversed))
    if (px < pL || px > pL + pW || seen.has(px)) continue
    seen.add(px)
    out.push(buildLine(px, yBottom, px, yTop, thick, color))
  }
}

/**
 * Trigger rug: short ticks along the TOP of the plot marking BIDS trigger events
 * (x-positions of numeric, non-zero trigger-column cells). Mirror of
 * `drawMissingRug` (which marks missing samples at the bottom): one tick per
 * pixel column (decimation-safe) within a stacked lane growing DOWN from the top.
 */
function drawTriggerRug(
  triggers: number[],
  xMin: number,
  xMax: number,
  pL: number,
  pW: number,
  plotTop: number,
  reversed: boolean,
  thick: number,
  laneIndex: number,
  laneH: number,
  color: number[],
  buildLine: BuildLineFn,
  out: LineData[],
): void {
  const yTop = plotTop + laneIndex * laneH
  const yBottom = yTop + Math.max(1, laneH - 1)
  const seen = new Set<number>()
  for (const xv of triggers) {
    if (!Number.isFinite(xv) || xv < xMin || xv > xMax) continue // off-window/invalid
    const px = Math.round(mapSignalX(xv, xMin, xMax, pL, pW, reversed))
    if (px < pL || px > pL + pW || seen.has(px)) continue
    seen.add(px)
    out.push(buildLine(px, yTop, px, yBottom, thick, color))
  }
}

function computeBackingColor(
  canvasBackColor: number[],
): [number, number, number, number] {
  const canvasLum = canvasBackColor[0] + canvasBackColor[1] + canvasBackColor[2]
  let r: number, g: number, b: number
  if (canvasLum > 2.7) {
    r = Math.max(0, canvasBackColor[0] - 0.1)
    g = Math.max(0, canvasBackColor[1] - 0.1)
    b = Math.max(0, canvasBackColor[2] - 0.1)
  } else {
    r = Math.min(1, canvasBackColor[0] + 0.15)
    g = Math.min(1, canvasBackColor[1] + 0.15)
    b = Math.min(1, canvasBackColor[2] + 0.15)
  }
  return [r, g, b, 1]
}

function computeFontColor(
  backingColor: [number, number, number, number],
): [number, number, number, number] {
  const lum = backingColor[0] + backingColor[1] + backingColor[2]
  return lum > 1.5 ? [0, 0, 0, 1] : [1, 1, 1, 1]
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
  return x.toFixed(6).replace(/\.?0*$/, '')
}

/**
 * Calculate total width reserved for the graph on the right side.
 * Returns 0 if no graph data.
 */
export function graphTotalWidth(
  data: GraphData | null,
  canvasWidth: number,
  _canvasHeight: number,
): number {
  if (!data) return 0
  if (isSignalMode(data)) {
    if (signalPointCount(data) < 2) return 0
  } else if (data.lines.length === 0 || data.lines[0].length < 2) {
    return 0
  }
  // SLICE_TYPE.NONE (or a signal-only scene) hides the spatial view and hands the
  // whole canvas to the plot — for BOTH the multi-series signal graph and the plain
  // 4D-volume time-course graph (which previously stayed a side strip on NONE). Use
  // the full backing width (NOT capped to GRAPH_MAX_WIDTH, which would leave a blank
  // strip on a >4096-px backing canvas, e.g. 4K/5K or high-DPR).
  if (data.fullCanvas) {
    return Math.max(GRAPH_MIN_WIDTH, canvasWidth)
  }
  const raw = Math.round(canvasWidth * GRAPH_WIDTH_RATIO)
  return Math.max(GRAPH_MIN_WIDTH, Math.min(GRAPH_MAX_WIDTH, raw))
}

/** Layout for multi-series signal mode (real x-axis, windowed y-range). */
function computeSignalGraphLayout(
  data: GraphData,
  canvasWidth: number,
  canvasHeight: number,
  colorbarHeight: number,
  dpr: number,
  totalWidthOverride?: number,
): GraphLayout | null {
  const nPts = signalPointCount(data)
  if (nPts < 2) return null
  const totalWidth =
    totalWidthOverride ?? graphTotalWidth(data, canvasWidth, canvasHeight)
  const height = canvasHeight - colorbarHeight
  const x = canvasWidth - totalWidth
  const baseFontSize = estimateFontSize(canvasWidth, canvasHeight)
  const fontScale = GRAPH_FONT_SCALE
  const fontSize = baseFontSize * fontScale
  const [xMin, xMax] = signalXDomain(data)
  let [mn, mx] = signalYRange(data, xMin, xMax)
  const [spacing, ticMin] = calculateTickSpacing(mn, mx)
  mn = Math.min(ticMin, mn)
  mx = Math.max(Math.ceil(mx / spacing) * spacing, mx)
  const digits = Math.max(0, -1 * Math.floor(Math.log(spacing) / Math.log(10)))
  let maxTextWid = 0
  if (fontSize > 0) {
    let lineH = ticMin
    while (lineH <= mx) {
      const str = lineH.toFixed(digits)
      maxTextWid = Math.max(maxTextWid, str.length * fontSize * FONT_XADV)
      lineH += spacing
    }
    maxTextWid += fontSize * 0.3
  }
  const outerMargin = fontSize * GRAPH_OUTER_MARGIN_EM
  const yGap = fontSize * GRAPH_Y_GAP_EM
  const plotLeft = x + outerMargin + yGap + maxTextWid + yGap
  const plotTop = fontSize * GRAPH_TOP_EM
  const plotWidth = totalWidth - (plotLeft - x) - fontSize * GRAPH_RIGHT_EM
  const plotHeight = height - fontSize * (GRAPH_TOP_EM + GRAPH_BOTTOM_EM)
  if (plotWidth < 20 || plotHeight < 20) return null
  return {
    x,
    y: 0,
    width: totalWidth,
    height,
    plotLTWH: [plotLeft, plotTop, plotWidth, plotHeight],
    nFrames: nPts,
    hasDeferred: false,
    isSignal: true,
    fontScale,
    fontSize,
    dpr,
    // Show the buttons whenever they (left-aligned, ~8.2em span) plus the axis
    // title fit in the plot; the title is then shifted right to clear them (see
    // buildSignalGraphElements). This keeps the controls visible on typical
    // right-side associated graphs, not just wide/full-canvas ones.
    controls:
      nPts > CONTROL_MIN_POINTS &&
      fontSize > 6 &&
      plotWidth >
        fontSize * 8.2 +
          (data.xAxis?.label?.length ?? 6) * fontSize * FONT_XADV +
          fontSize * 1.5
        ? computeGraphControls(
            plotLeft,
            plotTop + plotHeight,
            fontSize,
            [xMin, xMax],
            data.fullXDomain ?? [xMin, xMax],
            data.xAxis?.reversed ?? false,
          )
        : undefined,
  }
}

/**
 * Compute graph layout including the plot area. `totalWidthOverride` lets the
 * caller widen the graph beyond its base width (e.g. when a single narrow slice
 * leaves horizontal slack the graph should fill).
 */
export function computeGraphLayout(
  data: GraphData,
  canvasWidth: number,
  canvasHeight: number,
  colorbarHeight: number,
  dpr: number = 1,
  totalWidthOverride?: number,
): GraphLayout | null {
  if (isSignalMode(data)) {
    return computeSignalGraphLayout(
      data,
      canvasWidth,
      canvasHeight,
      colorbarHeight,
      dpr,
      totalWidthOverride,
    )
  }
  if (data.lines.length === 0 || data.lines[0].length < 2) return null
  const totalWidth =
    totalWidthOverride ?? graphTotalWidth(data, canvasWidth, canvasHeight)
  const availableHeight = canvasHeight - colorbarHeight
  const x = canvasWidth - totalWidth
  const y = 0
  const height = availableHeight
  const baseFontSize = estimateFontSize(canvasWidth, canvasHeight)
  const fontScale = GRAPH_FONT_SCALE
  const fontSize = baseFontSize * fontScale
  // Calculate Y-axis label width (must match buildGraphElements tick range)
  let [mn, mx] = dataMinMax(data)
  const [spacing, ticMin] = calculateTickSpacing(mn, mx)
  mn = Math.min(ticMin, mn)
  mx = Math.max(Math.ceil(mx / spacing) * spacing, mx)
  const digits = Math.max(0, -1 * Math.floor(Math.log(spacing) / Math.log(10)))
  let maxTextWid = 0
  if (fontSize > 0) {
    let lineH = ticMin
    while (lineH <= mx) {
      const str = lineH.toFixed(digits)
      maxTextWid = Math.max(maxTextWid, str.length * fontSize * FONT_XADV)
      lineH += spacing
    }
    maxTextWid += fontSize * 0.3 // padding for glyph width estimation error
  }
  const outerMargin = fontSize * GRAPH_OUTER_MARGIN_EM
  const yGap = fontSize * GRAPH_Y_GAP_EM
  const plotLeft = x + outerMargin + yGap + maxTextWid + yGap
  const plotTop = y + fontSize * GRAPH_TOP_EM
  const plotWidth = totalWidth - (plotLeft - x) - fontSize * GRAPH_RIGHT_EM
  const plotHeight = height - fontSize * (GRAPH_TOP_EM + GRAPH_BOTTOM_EM)
  if (plotWidth < 20 || plotHeight < 20) return null
  return {
    x,
    y,
    width: totalWidth,
    height,
    plotLTWH: [plotLeft, plotTop, plotWidth, plotHeight],
    nFrames: data.lines[0].length,
    hasDeferred: data.nTotalFrame4D > data.lines[0].length,
    isSignal: false,
    fontScale,
    fontSize,
    dpr,
  }
}

function dataMinMax(data: GraphData): [number, number] {
  const cfg = data.graphConfig
  let mn = data.lines[0][0]
  let mx = data.lines[0][0]
  for (const line of data.lines) {
    for (const v of line) {
      mn = Math.min(v, mn)
      mx = Math.max(v, mx)
    }
  }
  if (
    cfg.isRangeCalMinMax &&
    data.calMin < data.calMax &&
    Number.isFinite(data.calMin) &&
    Number.isFinite(data.calMax)
  ) {
    mn = data.calMin
    mx = data.calMax
  }
  if (cfg.normalizeValues && mx > mn) {
    mn = 0
    mx = 1
  }
  if (mn >= mx) mx = mn + 1.0
  return [mn, mx]
}

function normalizeData(data: GraphData): number[][] {
  const cfg = data.graphConfig
  if (!cfg.normalizeValues) return data.lines
  // When isRangeCalMinMax, normalize relative to cal_min..cal_max
  // (so cal_min→0, cal_max→1, out-of-range values can exceed [0,1])
  let mn: number, mx: number
  if (
    cfg.isRangeCalMinMax &&
    data.calMin < data.calMax &&
    Number.isFinite(data.calMin) &&
    Number.isFinite(data.calMax)
  ) {
    mn = data.calMin
    mx = data.calMax
  } else {
    mn = data.lines[0][0]
    mx = data.lines[0][0]
    for (const line of data.lines) {
      for (const v of line) {
        mn = Math.min(v, mn)
        mx = Math.max(v, mx)
      }
    }
  }
  if (mx <= mn) return data.lines
  const range = mx - mn
  return data.lines.map((line) => line.map((v) => (v - mn) / range))
}

/**
 * Build rendering data for the multi-series signal graph: backing, axes,
 * per-series colored lines, an optional legend, and the x-axis label.
 */
function buildSignalGraphElements(
  data: GraphData,
  layout: GraphLayout,
  buildText: BuildTextFn,
  buildLine: BuildLineFn,
  canvasBackColor: number[],
): { labels: GlyphBatch[]; lines: LineData[] } {
  const labels: GlyphBatch[] = []
  const lineSegments: LineData[] = []
  const series = data.series ?? []
  const backingColor = computeBackingColor(canvasBackColor)
  const fontColor = computeFontColor(backingColor)
  const gridColor: number[] = [
    backingColor[0],
    backingColor[1],
    backingColor[2],
    1,
  ]
  const [pL, pT, pW, pH] = layout.plotLTWH
  const noBack = [0, 0, 0, 0]
  const fntScale = layout.fontScale
  const fontSize = layout.fontSize
  // Relative line-width multiplier (data lines only; grid stays at the default).
  const lineWidthMul = data.graphConfig.lineWidth ?? 1
  const lineAlpha = data.graphConfig.lineAlpha ?? 1
  const lineThick = Math.max(
    1,
    Math.ceil(LINE_THICKNESS * layout.dpr * lineWidthMul),
  )
  const gridThick = Math.ceil(LINE_THICKNESS * layout.dpr * 0.5)
  const outerMargin = fontSize * GRAPH_OUTER_MARGIN_EM
  const plotBottom = pT + pH

  const axis = data.xAxis
  const reversed = axis?.reversed ?? false
  const [xMin, xMax] = signalXDomain(data)
  let [yMin, yMax] = signalYRange(data, xMin, xMax)
  const [spacing, ticMin] = calculateTickSpacing(yMin, yMax)
  const digits = Math.max(0, -1 * Math.floor(Math.log(spacing) / Math.log(10)))
  yMin = Math.min(ticMin, yMin)
  yMax = Math.max(Math.ceil(yMax / spacing) * spacing, yMax)
  const scaleH = pH / (yMax - yMin)

  // 1) Backing rectangle
  labels.push({
    data: new Float32Array(0),
    count: 0,
    backColor: backingColor,
    backRect: [
      layout.x + outerMargin,
      layout.y + outerMargin,
      layout.width - outerMargin * 2,
      layout.height - outerMargin * 2,
    ],
    backRadius: 8,
  })
  // 2) Plot background
  labels.push({
    data: new Float32Array(0),
    count: 0,
    backColor: [...canvasBackColor, 1],
    backRect: [pL, pT, pW, pH],
    backRadius: 0,
  })

  // 3) Horizontal grid + Y labels
  let lineH = ticMin
  while (lineH <= yMax) {
    const y = plotBottom - (lineH - yMin) * scaleH
    if (y >= pT - 1 && y <= plotBottom + 1) {
      lineSegments.push(buildLine(pL, y, pL + pW, y, gridThick, gridColor))
      const tb = buildText(
        lineH.toFixed(digits),
        pL - fontSize * GRAPH_Y_GAP_EM,
        y,
        fntScale,
        fontColor,
        1,
        0.5,
        noBack,
      )
      tb.backRect = []
      labels.push(tb)
    }
    lineH += spacing
  }

  // 4) Vertical grid + X labels (real-valued axis, honoring reversed)
  const [xSpacing, xTicMin] = calculateTickSpacing(xMin, xMax)
  const xDigits = Math.max(
    0,
    -1 * Math.floor(Math.log(xSpacing) / Math.log(10)),
  )
  for (let xv = xTicMin; xv <= xMax + xSpacing * 0.5; xv += xSpacing) {
    if (xv < xMin - xSpacing * 0.5) continue
    const sx = mapSignalX(xv, xMin, xMax, pL, pW, reversed)
    if (sx < pL - 1 || sx > pL + pW + 1) continue
    lineSegments.push(buildLine(sx, pT, sx, plotBottom, gridThick, gridColor))
    const tb = buildText(
      xv.toFixed(xDigits),
      sx,
      plotBottom + fontSize * 0.2,
      fntScale,
      fontColor,
      0.5,
      0,
      noBack,
    )
    tb.backRect = []
    labels.push(tb)
  }

  // 5) Data lines, clipped to the x-window and plot area. Dense series (more
  // samples than ~2 per horizontal pixel) are decimated to a per-pixel-column
  // min/max envelope so the line buffer stays bounded by the plot width
  // regardless of sample count.
  const decimateThreshold = Math.max(2, Math.ceil(pW * 2))
  for (let j = 0; j < series.length; j++) {
    const s = series[j]
    const base = seriesColor(s, j)
    // Translucency for overlapping traces: scale the data line's alpha only
    // (legend/rug keep full opacity so they stay legible).
    const color =
      lineAlpha < 1
        ? [base[0], base[1], base[2], (base[3] ?? 1) * lineAlpha]
        : base
    if (s.y.length > decimateThreshold) {
      drawDecimatedSeries(
        s,
        xMin,
        xMax,
        yMin,
        scaleH,
        pL,
        pT,
        pW,
        plotBottom,
        reversed,
        lineThick,
        color,
        buildLine,
        lineSegments,
      )
      continue
    }
    // Connect consecutive finite samples, CLIPPING each segment to the x-window
    // in data space. This draws the segment from an out-of-window neighbour up to
    // the plot edge (e.g. a sparse volume time-course whose first/last in-window
    // sample would otherwise float disconnected from the left/right edge). NaN
    // (missing) samples break the line so gaps are preserved.
    let prevX = 0
    let prevY = 0
    let havePrev = false
    for (let i = 0; i < s.y.length; i++) {
      const xv = seriesX(s, i)
      const yv = s.y[i]
      if (!Number.isFinite(yv)) {
        havePrev = false
        continue
      }
      if (havePrev) {
        const seg = clipSegmentX(prevX, prevY, xv, yv, xMin, xMax)
        if (seg) {
          lineSegments.push(
            buildLine(
              mapSignalX(seg[0], xMin, xMax, pL, pW, reversed),
              mapSignalY(seg[1], yMin, scaleH, pT, plotBottom),
              mapSignalX(seg[2], xMin, xMax, pL, pW, reversed),
              mapSignalY(seg[3], yMin, scaleH, pT, plotBottom),
              lineThick,
              color,
            ),
          )
        }
      }
      prevX = xv
      prevY = yv
      havePrev = true
    }
  }

  // 5a) Missing-data rug: short ticks at the bottom axis marking samples with no
  // value (BIDS `n/a`). Gaps are left in the trace (not interpolated); this is
  // the only on-graph cue for missing data in a dense, decimated series. Each
  // series gets its own stacked lane so coincident gaps don't overwrite.
  const rugLaneH = Math.max(2, Math.round(fontSize * 0.35))
  // Keep the stacked lanes inside a reserved band at the bottom (~20% of plot
  // height); with many series carrying gaps, excess lanes share the top lane
  // rather than climbing into the plot.
  const maxRugLanes = Math.max(
    1,
    Math.floor(((plotBottom - pT) * 0.2) / rugLaneH),
  )
  for (let j = 0; j < series.length; j++) {
    drawMissingRug(
      series[j],
      xMin,
      xMax,
      pL,
      pW,
      plotBottom,
      reversed,
      lineThick,
      Math.min(j, maxRugLanes - 1),
      rugLaneH,
      seriesColor(series[j], j),
      buildLine,
      lineSegments,
    )
  }

  // 5a') Trigger rug: short ticks at the TOP marking BIDS trigger events (a
  // trigger-column cell that is numeric and non-zero). Mirrors the bottom
  // missing-data rug; each signal carrying triggers gets its own stacked lane.
  let trigLane = 0
  for (let j = 0; j < series.length; j++) {
    const trig = series[j].triggers
    if (!trig || trig.length === 0) continue
    drawTriggerRug(
      trig,
      xMin,
      xMax,
      pL,
      pW,
      pT,
      reversed,
      lineThick,
      Math.min(trigLane, maxRugLanes - 1),
      rugLaneH,
      seriesColor(series[j], j),
      buildLine,
      lineSegments,
    )
    trigLane++
  }

  // 5b) Cursor: faint vertical line at the selected x value
  if (
    data.cursorX !== null &&
    data.cursorX !== undefined &&
    data.cursorX >= xMin &&
    data.cursorX <= xMax
  ) {
    const sx = mapSignalX(data.cursorX, xMin, xMax, pL, pW, reversed)
    const faint: number[] = [
      fontColor[0],
      fontColor[1],
      fontColor[2],
      CURSOR_ALPHA,
    ]
    lineSegments.push(buildLine(sx, pT, sx, plotBottom, lineThick, faint))
  }

  // 5c) Annotations: text labels anchored to data-space (x, y) positions. The x
  // is mapped through the visible window (skipped when out of range) so labels
  // pan/zoom with the data. A y of -Inf/+Inf pins the label to the bottom/top of
  // the plot; finite y maps to the value, clamped into the plot area. Edge-pinned
  // labels also draw a faint vertical guide marking the x position (e.g. a
  // spectral peak).
  for (const a of data.annotations ?? []) {
    // Window test rejects out-of-range and NaN x (NaN fails both comparisons).
    if (!(a.x >= xMin && a.x <= xMax)) continue
    const pinBottom = a.y === Number.NEGATIVE_INFINITY
    const pinTop = a.y === Number.POSITIVE_INFINITY
    // Reject a malformed finite-but-NaN y: it has no plot position and must not
    // be treated as an edge sentinel.
    if (!pinBottom && !pinTop && !Number.isFinite(a.y)) continue
    // Skip entirely when the label cannot render (tiny canvas): a bare guide line
    // with no label is just an unexplained vertical mark.
    if (fontSize <= 6) continue
    const sx = mapSignalX(a.x, xMin, xMax, pL, pW, reversed)
    const annColor: [number, number, number, number] = a.color ?? fontColor
    let sy: number
    let alignY: number
    if (pinBottom) {
      sy = plotBottom - fontSize * 0.2
      alignY = 1 // text sits just above the bottom axis
    } else if (pinTop) {
      sy = pT + fontSize * 0.2
      alignY = 0 // text hangs just below the top axis
    } else {
      sy = mapSignalY(a.y, yMin, scaleH, pT, plotBottom)
      alignY = 0.5
    }
    if (pinBottom || pinTop) {
      // Faint full-height guide to tie an edge-pinned label to its x position.
      const guide: number[] = [
        annColor[0],
        annColor[1],
        annColor[2],
        GUIDE_ALPHA,
      ]
      lineSegments.push(buildLine(sx, pT, sx, plotBottom, gridThick, guide))
    }
    const tb = buildText(
      a.text,
      sx,
      sy,
      fntScale,
      annColor,
      0.5,
      alignY,
      noBack,
    )
    tb.backRect = []
    labels.push(tb)
  }

  // 6) Legend (top-right inside plot). Capped so a high-cardinality series set
  // (e.g. non-averaged spectroscopy with many transients) cannot overflow the
  // plot; the overflow is summarized as a final "+N more" row.
  const showLegend = data.showLegend ?? series.length > 1
  if (showLegend && fontSize > 6) {
    const swatch = fontSize * 1.2
    const rowH = fontSize * 1.3
    const maxRows = Math.max(1, Math.floor((pH - fontSize) / rowH))
    const cap = Math.min(series.length, LEGEND_MAX_ROWS, maxRows)
    const showAll = series.length <= cap
    const rows = showAll ? series.length : cap - 1
    let ly = pT + fontSize * 0.6
    const lx = pL + pW - fontSize * 0.5
    for (let j = 0; j < rows; j++) {
      const color = seriesColor(series[j], j)
      lineSegments.push(buildLine(lx - swatch, ly, lx, ly, lineThick, color))
      const tb = buildText(
        series[j].label,
        lx - swatch - fontSize * 0.3,
        ly,
        fntScale,
        fontColor,
        1,
        0.5,
        noBack,
      )
      tb.backRect = []
      labels.push(tb)
      ly += rowH
    }
    if (!showAll) {
      const more = buildText(
        `+${series.length - rows} more`,
        lx,
        ly,
        fntScale,
        fontColor,
        1,
        0.5,
        noBack,
      )
      more.backRect = []
      labels.push(more)
    }
  }

  // 7) X-axis label, centered — but shifted right to clear the pan/zoom buttons
  // when present (the buttons share this row), keeping both visible.
  if (fontSize > 6 && axis) {
    let titleX = pL + pW * 0.5
    if (layout.controls?.length) {
      const buttonsRight = Math.max(...layout.controls.map((c) => c.x + c.w))
      const halfLabel = (axis.label.length * fontSize * FONT_XADV) / 2
      const minCenter = buttonsRight + fontSize * 0.5 + halfLabel
      if (titleX < minCenter) titleX = minCenter
    }
    const tb = buildText(
      axis.label,
      titleX,
      plotBottom + fontSize * 1.5,
      fntScale,
      fontColor,
      0.5,
      0,
      noBack,
    )
    tb.backRect = []
    labels.push(tb)
  }

  // 8) Pan/zoom control buttons (dense graphs only): a bordered box + symbol on
  // the axis-title row. Hit regions come from the same `layout.controls`.
  // Disabled buttons (no-op at the current window) are dimmed toward the panel
  // background so they read as greyed out.
  const dimColor = [
    fontColor[0] * 0.4 + backingColor[0] * 0.6,
    fontColor[1] * 0.4 + backingColor[1] * 0.6,
    fontColor[2] * 0.4 + backingColor[2] * 0.6,
    fontColor[3] ?? 1,
  ]
  for (const c of layout.controls ?? []) {
    const { x: bx, y: by, w: bw, h: bh } = c
    const col = c.disabled ? dimColor : fontColor
    lineSegments.push(buildLine(bx, by, bx + bw, by, gridThick, col))
    lineSegments.push(buildLine(bx + bw, by, bx + bw, by + bh, gridThick, col))
    lineSegments.push(buildLine(bx + bw, by + bh, bx, by + bh, gridThick, col))
    lineSegments.push(buildLine(bx, by + bh, bx, by, gridThick, col))
    const tb = buildText(
      c.label,
      bx + bw * 0.5,
      by + bh * 0.5,
      fntScale,
      col,
      0.5,
      0.5,
      noBack,
    )
    tb.backRect = []
    labels.push(tb)
  }

  return { labels, lines: lineSegments }
}

/**
 * Build rendering data for the frame intensity graph.
 * Returns separate arrays for the font renderer (labels/backings) and line renderer (lines).
 */
export function buildGraphElements(
  data: GraphData,
  layout: GraphLayout,
  buildText: BuildTextFn,
  buildLine: BuildLineFn,
  canvasBackColor: number[],
): { labels: GlyphBatch[]; lines: LineData[] } {
  if (isSignalMode(data)) {
    return buildSignalGraphElements(
      data,
      layout,
      buildText,
      buildLine,
      canvasBackColor,
    )
  }
  const labels: GlyphBatch[] = []
  const lineSegments: LineData[] = []
  const backingColor = computeBackingColor(canvasBackColor)
  const fontColor = computeFontColor(backingColor)
  // Grid lines: same color as backing
  const gridColor: number[] = [
    backingColor[0],
    backingColor[1],
    backingColor[2],
    1,
  ]
  const thinGridColor: number[] = [
    gridColor[0],
    gridColor[1],
    gridColor[2],
    0.5,
  ]
  const [pL, pT, pW, pH] = layout.plotLTWH
  const noBack = [0, 0, 0, 0]
  const fntScale = layout.fontScale
  const fontSize = layout.fontSize
  const lineThick = Math.max(
    1,
    Math.ceil(LINE_THICKNESS * layout.dpr * (data.graphConfig.lineWidth ?? 1)),
  )
  const gridThick = Math.ceil(LINE_THICKNESS * layout.dpr * 0.5)

  const outerMargin = fontSize * GRAPH_OUTER_MARGIN_EM

  // 1) Backing rectangle with rounded corners
  labels.push({
    data: new Float32Array(0),
    count: 0,
    backColor: backingColor,
    backRect: [
      layout.x + outerMargin,
      layout.y + outerMargin,
      layout.width - outerMargin * 2,
      layout.height - outerMargin * 2,
    ],
    backRadius: 8,
  })

  // 2) Plot background (canvas back color)
  labels.push({
    data: new Float32Array(0),
    count: 0,
    backColor: [...canvasBackColor, 1],
    backRect: [pL, pT, pW, pH],
    backRadius: 0,
  })

  // 3) Compute value range and ticks
  const plotLines = normalizeData(data)
  let [mn, mx] = dataMinMax(data)
  const [spacing, ticMin] = calculateTickSpacing(mn, mx)
  const digits = Math.max(0, -1 * Math.floor(Math.log(spacing) / Math.log(10)))
  mn = Math.min(ticMin, mn)
  mx = Math.max(Math.ceil(mx / spacing) * spacing, mx)
  const rangeH = mx - mn
  const scaleH = pH / rangeH
  const scaleW = pW / (plotLines[0].length - 1)
  const plotBottom = pT + pH

  // 4) Horizontal grid lines + Y-axis labels
  let lineH = ticMin
  while (lineH <= mx) {
    const y = plotBottom - (lineH - mn) * scaleH
    if (y >= pT - 1 && y <= plotBottom + 1) {
      lineSegments.push(buildLine(pL, y, pL + pW, y, gridThick, gridColor))
      const str = lineH.toFixed(digits)
      const textBatch = buildText(
        str,
        pL - fontSize * GRAPH_Y_GAP_EM,
        y,
        fntScale,
        fontColor,
        1,
        0.5,
        noBack,
      )
      textBatch.backRect = []
      labels.push(textBatch)
    }
    lineH += spacing
  }

  // 5) Vertical grid lines + X-axis labels
  let stride = 1
  while (plotLines[0].length / stride > 12) {
    stride *= 5
  }
  for (let i = 0; i < plotLines[0].length; i += stride) {
    const x = i * scaleW + pL
    lineSegments.push(
      buildLine(
        x,
        pT,
        x,
        plotBottom,
        gridThick,
        i % (stride * 2) === 0 ? gridColor : thinGridColor,
      ),
    )
    if (i % (stride * 2) === 0) {
      const str = humanize(i)
      const textBatch = buildText(
        str,
        x,
        plotBottom + fontSize * 0.2,
        fntScale,
        fontColor,
        0.5,
        0,
        noBack,
      )
      textBatch.backRect = []
      labels.push(textBatch)
    }
  }

  // 6) Data lines (clamped to plot area)
  let hasAboveMax = false
  let hasBelowMin = false
  for (let j = 0; j < plotLines.length; j++) {
    const lineColor = [LINE_RGB[0], LINE_RGB[1], LINE_RGB[2], 1]
    for (let i = 1; i < plotLines[j].length; i++) {
      const x0 = (i - 1) * scaleW + pL
      const x1 = i * scaleW + pL
      let y0 = plotBottom - (plotLines[j][i - 1] - mn) * scaleH
      let y1 = plotBottom - (plotLines[j][i] - mn) * scaleH
      if (y0 < pT || y1 < pT) hasAboveMax = true
      if (y0 > plotBottom || y1 > plotBottom) hasBelowMin = true
      y0 = Math.max(pT, Math.min(plotBottom, y0))
      y1 = Math.max(pT, Math.min(plotBottom, y1))
      lineSegments.push(buildLine(x0, y0, x1, y1, lineThick, lineColor))
    }
  }

  // 6b) Out-of-range indicator boxes when isRangeCalMinMax is active
  if (data.graphConfig.isRangeCalMinMax) {
    const boxSize = fontSize * 0.6
    const clampColor: [number, number, number, number] = [
      LINE_RGB[0],
      LINE_RGB[1],
      LINE_RGB[2],
      0.8,
    ]
    if (hasAboveMax) {
      labels.push({
        data: new Float32Array(0),
        count: 0,
        backColor: clampColor,
        backRect: [pL + 2, pT + 2, boxSize, boxSize],
        backRadius: 2,
      })
    }
    if (hasBelowMin) {
      labels.push({
        data: new Float32Array(0),
        count: 0,
        backColor: clampColor,
        backRect: [pL + 2, plotBottom - boxSize - 2, boxSize, boxSize],
        backRadius: 2,
      })
    }
  }

  // 7) Selected column (current frame) indicator
  if (data.selectedColumn >= 0 && data.selectedColumn < plotLines[0].length) {
    const x = data.selectedColumn * scaleW + pL
    const selColor = [LINE_RGB[0], LINE_RGB[1], LINE_RGB[2], 1]
    lineSegments.push(buildLine(x, pT, x, plotBottom, lineThick, selColor))
  }

  // 8) "Volume" label below X-axis
  const volumeLabelY = plotBottom + fontSize * 1.5
  if (fontSize > 6) {
    const labelBatch = buildText(
      'Volume',
      pL + pW * 0.5,
      volumeLabelY,
      fntScale,
      fontColor,
      0.5,
      0,
      noBack,
    )
    labelBatch.backRect = []
    labels.push(labelBatch)
  }

  // 9) Ellipsis indicator for deferred frames (same row as "Volume", right-justified)
  if (layout.hasDeferred && fontSize > 6) {
    const ellipsisX =
      layout.x + layout.width - outerMargin - fontSize * GRAPH_Y_GAP_EM
    const ellipsisBatch = buildText(
      '...',
      ellipsisX,
      volumeLabelY,
      fntScale,
      fontColor,
      1,
      0,
      noBack,
    )
    ellipsisBatch.backRect = []
    labels.push(ellipsisBatch)
  }

  return { labels, lines: lineSegments }
}

/**
 * Hit-test the graph area. Returns:
 * - { type: 'frame', frame: number } if a frame column was clicked
 * - { type: 'deferred' } if the ellipsis area was clicked
 * - { type: 'signalCursor', xFrac } if a signal plot location was clicked
 * - null if outside the graph
 */
export function graphHitTest(
  x: number,
  y: number,
  layout: GraphLayout | null,
):
  | { type: 'frame'; frame: number }
  | { type: 'deferred' }
  | { type: 'signalCursor'; xFrac: number }
  | { type: 'graphControl'; id: GraphControlId }
  | null {
  if (!layout) return null
  const [pL, pT, pW, pH] = layout.plotLTWH
  // Signal mode: a click in the plot area selects an x-cursor; elsewhere in the
  // backing area the click is consumed (frame -1) so it does not fall through
  // to tile interaction.
  if (layout.isSignal) {
    // Pan/zoom buttons take priority over the plot-area cursor (disabled ones
    // are inert).
    for (const c of layout.controls ?? []) {
      if (c.disabled) continue
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) {
        return { type: 'graphControl', id: c.id }
      }
    }
    if (x >= pL && x <= pL + pW && y >= pT && y <= pT + pH) {
      return { type: 'signalCursor', xFrac: (x - pL) / pW }
    }
    if (
      x >= layout.x &&
      x <= layout.x + layout.width &&
      y >= layout.y &&
      y <= layout.y + layout.height
    ) {
      return { type: 'frame', frame: -1 }
    }
    return null
  }
  // Check deferred ellipsis click (right-justified, same row as "Volume" label)
  if (layout.hasDeferred) {
    const fs = layout.fontSize
    const ellipsisY = pT + pH + fs * 1.5
    const ellipsisX =
      layout.x + layout.width - fs * (GRAPH_OUTER_MARGIN_EM + GRAPH_Y_GAP_EM)
    if (
      x >= ellipsisX - fs * 2 &&
      x <= ellipsisX &&
      y >= ellipsisY - fs * 0.5 &&
      y <= ellipsisY + fs * 1.5
    ) {
      return { type: 'deferred' }
    }
  }
  // Check plot area click
  if (x >= pL && x <= pL + pW && y >= pT && y <= pT + pH) {
    const frac = (x - pL) / pW
    const frame = Math.round(frac * (plotLines_length(layout) - 1))
    return {
      type: 'frame',
      frame: Math.max(0, Math.min(frame, plotLines_length(layout) - 1)),
    }
  }
  // Check if inside graph backing area at all (consume click to prevent tile interaction)
  if (
    x >= layout.x &&
    x <= layout.x + layout.width &&
    y >= layout.y &&
    y <= layout.y + layout.height
  ) {
    return { type: 'frame', frame: -1 }
  }
  return null
}

function plotLines_length(layout: GraphLayout): number {
  return layout.nFrames
}

/**
 * Map a plot-relative screen fraction (0 = left edge, 1 = right edge) to an
 * x-axis data value for signal mode, honoring the reversed (ppm) convention.
 */
export function signalXValueAtFrac(data: GraphData, frac: number): number {
  const [xMin, xMax] = signalXDomain(data)
  const reversed = data.xAxis?.reversed ?? false
  const t = reversed ? 1 - frac : frac
  return xMin + t * (xMax - xMin)
}

/** Inverse of {@link signalXValueAtFrac}: x-axis data value -> plot fraction. */
export function signalFracAtXValue(data: GraphData, xValue: number): number {
  const [xMin, xMax] = signalXDomain(data)
  if (xMax <= xMin) return 0
  const t = (xValue - xMin) / (xMax - xMin)
  return data.xAxis?.reversed ? 1 - t : t
}

/** A series value sampled at an x location, for the status-bar readout. */
export type SignalValueAt = {
  label: string
  value: number
  color: [number, number, number, number]
}

/**
 * Sample every series at the data point nearest a given x value. Used to report
 * the values under the signal cursor.
 */
export function signalValuesAt(
  data: GraphData,
  xValue: number,
): SignalValueAt[] {
  const series = data.series ?? []
  // Constrain the readout to the visible x-window so it never reports a sample
  // outside the plotted domain (e.g. physio logged before/after the scan).
  const ax = data.xAxis
  const lo = ax && ax.min !== null ? ax.min : Number.NEGATIVE_INFINITY
  const hi = ax && ax.max !== null ? ax.max : Number.POSITIVE_INFINITY
  return series.map((s, i) => {
    let best = -1
    let bestDist = Number.POSITIVE_INFINITY
    for (let k = 0; k < s.y.length; k++) {
      const xv = seriesX(s, k)
      if (xv < lo || xv > hi) continue
      const d = Math.abs(xv - xValue)
      if (d < bestDist) {
        bestDist = d
        best = k
      }
    }
    // Prefer un-normalized values for the readout when present.
    const arr = s.rawY ?? s.y
    const value = best >= 0 ? arr[best] : Number.NaN
    return { label: s.label, value, color: seriesColor(s, i) }
  })
}
