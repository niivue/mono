import type { GraphConfig } from "@/NVTypes";
import type { BuildTextFn, GlyphBatch } from "./NVFont";
import type { BuildLineFn, LineData } from "./NVLine";
import { estimateFontSize } from "./NVUILayout";

export type GraphData = {
  lines: number[][];
  selectedColumn: number;
  calMin: number;
  calMax: number;
  nTotalFrame4D: number;
  graphConfig: GraphConfig;
};

export type GraphLayout = {
  /** Left edge of the graph area in canvas pixels */
  x: number;
  /** Top edge of the graph area in canvas pixels */
  y: number;
  /** Total width of the graph (including margins/labels) */
  width: number;
  /** Total height of the graph */
  height: number;
  /** Plot area (inner area where lines are drawn) [left, top, width, height] */
  plotLTWH: number[];
  /** Number of data points (frames) */
  nFrames: number;
  /** Whether extra frames exist beyond what is loaded */
  hasDeferred: boolean;
  /** Font scale multiplier for buildText (same convention as legend) */
  fontScale: number;
  /** Estimated font pixel size for positioning calculations */
  fontSize: number;
  /** Device pixel ratio for line thickness scaling */
  dpr: number;
};

// Layout constants (em = multiples of fontSize for DPI-consistent spacing)
const GRAPH_OUTER_MARGIN_EM = 0.6; // Backing rect inset from canvas edge
const GRAPH_TOP_EM = 1.5; // Top padding above plot area
const GRAPH_BOTTOM_EM = 4.0; // Bottom: X-axis tick labels + "Volume" label + padding
const GRAPH_RIGHT_EM = 1.5; // Right padding (room for rightmost X label overhang)
const GRAPH_Y_GAP_EM = 0.3; // Gap between Y-axis labels and plot left edge
const GRAPH_WIDTH_RATIO = 0.25;
const GRAPH_MIN_WIDTH = 120;
const GRAPH_MAX_WIDTH = 4096;
const FONT_XADV = 0.55;
const GRAPH_FONT_SCALE = 0.7; // Multiplier for buildText (same convention as legend's 0.8)
const LINE_THICKNESS = 2; // Base thickness for all lines (scaled by DPR)
const LINE_RGB = [0.8, 0, 0];

function computeBackingColor(
  canvasBackColor: number[],
): [number, number, number, number] {
  const canvasLum =
    canvasBackColor[0] + canvasBackColor[1] + canvasBackColor[2];
  let r: number, g: number, b: number;
  if (canvasLum > 2.7) {
    r = Math.max(0, canvasBackColor[0] - 0.1);
    g = Math.max(0, canvasBackColor[1] - 0.1);
    b = Math.max(0, canvasBackColor[2] - 0.1);
  } else {
    r = Math.min(1, canvasBackColor[0] + 0.15);
    g = Math.min(1, canvasBackColor[1] + 0.15);
    b = Math.min(1, canvasBackColor[2] + 0.15);
  }
  return [r, g, b, 1];
}

function computeFontColor(
  backingColor: [number, number, number, number],
): [number, number, number, number] {
  const lum = backingColor[0] + backingColor[1] + backingColor[2];
  return lum > 1.5 ? [0, 0, 0, 1] : [1, 1, 1, 1];
}

function nice(x: number, round: boolean): number {
  const exp = Math.floor(Math.log(x) / Math.log(10));
  const f = x / 10 ** exp;
  let nf: number;
  if (round) {
    if (f < 1.5) nf = 1;
    else if (f < 3) nf = 2;
    else if (f < 7) nf = 5;
    else nf = 10;
  } else {
    if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 5) nf = 5;
    else nf = 10;
  }
  return nf * 10 ** exp;
}

function calculateTickSpacing(
  min: number,
  max: number,
): [spacing: number, ticMin: number, ticMax: number] {
  const range = max - min;
  if (range <= 0) return [1, min, max];
  const maxTicks = 5;
  const niceRange = nice(range, false);
  const spacing = nice(niceRange / (maxTicks - 1), true);
  const ticMin = Math.floor(min / spacing) * spacing;
  const ticMax = Math.ceil(max / spacing) * spacing;
  return [spacing, ticMin, ticMax];
}

function humanize(x: number): string {
  return x.toFixed(6).replace(/\.?0*$/, "");
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
  if (!data || data.lines.length === 0 || data.lines[0].length < 2) return 0;
  const raw = Math.round(canvasWidth * GRAPH_WIDTH_RATIO);
  return Math.max(GRAPH_MIN_WIDTH, Math.min(GRAPH_MAX_WIDTH, raw));
}

/**
 * Compute graph layout including the plot area.
 */
export function computeGraphLayout(
  data: GraphData,
  canvasWidth: number,
  canvasHeight: number,
  colorbarHeight: number,
  dpr: number = 1,
): GraphLayout | null {
  if (data.lines.length === 0 || data.lines[0].length < 2) return null;
  const totalWidth = graphTotalWidth(data, canvasWidth, canvasHeight);
  const availableHeight = canvasHeight - colorbarHeight;
  const x = canvasWidth - totalWidth;
  const y = 0;
  const height = availableHeight;
  const baseFontSize = estimateFontSize(canvasWidth, canvasHeight);
  const fontScale = GRAPH_FONT_SCALE;
  const fontSize = baseFontSize * fontScale;
  // Calculate Y-axis label width (must match buildGraphElements tick range)
  let [mn, mx] = dataMinMax(data);
  const [spacing, ticMin] = calculateTickSpacing(mn, mx);
  mn = Math.min(ticMin, mn);
  mx = Math.max(Math.ceil(mx / spacing) * spacing, mx);
  const digits = Math.max(0, -1 * Math.floor(Math.log(spacing) / Math.log(10)));
  let maxTextWid = 0;
  if (fontSize > 0) {
    let lineH = ticMin;
    while (lineH <= mx) {
      const str = lineH.toFixed(digits);
      maxTextWid = Math.max(maxTextWid, str.length * fontSize * FONT_XADV);
      lineH += spacing;
    }
    maxTextWid += fontSize * 0.3; // padding for glyph width estimation error
  }
  const outerMargin = fontSize * GRAPH_OUTER_MARGIN_EM;
  const yGap = fontSize * GRAPH_Y_GAP_EM;
  const plotLeft = x + outerMargin + yGap + maxTextWid + yGap;
  const plotTop = y + fontSize * GRAPH_TOP_EM;
  const plotWidth = totalWidth - (plotLeft - x) - fontSize * GRAPH_RIGHT_EM;
  const plotHeight = height - fontSize * (GRAPH_TOP_EM + GRAPH_BOTTOM_EM);
  if (plotWidth < 20 || plotHeight < 20) return null;
  return {
    x,
    y,
    width: totalWidth,
    height,
    plotLTWH: [plotLeft, plotTop, plotWidth, plotHeight],
    nFrames: data.lines[0].length,
    hasDeferred: data.nTotalFrame4D > data.lines[0].length,
    fontScale,
    fontSize,
    dpr,
  };
}

function dataMinMax(data: GraphData): [number, number] {
  const cfg = data.graphConfig;
  let mn = data.lines[0][0];
  let mx = data.lines[0][0];
  for (const line of data.lines) {
    for (const v of line) {
      mn = Math.min(v, mn);
      mx = Math.max(v, mx);
    }
  }
  if (
    cfg.isRangeCalMinMax &&
    data.calMin < data.calMax &&
    Number.isFinite(data.calMin) &&
    Number.isFinite(data.calMax)
  ) {
    mn = data.calMin;
    mx = data.calMax;
  }
  if (cfg.normalizeValues && mx > mn) {
    mn = 0;
    mx = 1;
  }
  if (mn >= mx) mx = mn + 1.0;
  return [mn, mx];
}

function normalizeData(data: GraphData): number[][] {
  const cfg = data.graphConfig;
  if (!cfg.normalizeValues) return data.lines;
  // When isRangeCalMinMax, normalize relative to cal_min..cal_max
  // (so cal_min→0, cal_max→1, out-of-range values can exceed [0,1])
  let mn: number, mx: number;
  if (
    cfg.isRangeCalMinMax &&
    data.calMin < data.calMax &&
    Number.isFinite(data.calMin) &&
    Number.isFinite(data.calMax)
  ) {
    mn = data.calMin;
    mx = data.calMax;
  } else {
    mn = data.lines[0][0];
    mx = data.lines[0][0];
    for (const line of data.lines) {
      for (const v of line) {
        mn = Math.min(v, mn);
        mx = Math.max(v, mx);
      }
    }
  }
  if (mx <= mn) return data.lines;
  const range = mx - mn;
  return data.lines.map((line) => line.map((v) => (v - mn) / range));
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
  const labels: GlyphBatch[] = [];
  const lineSegments: LineData[] = [];
  const backingColor = computeBackingColor(canvasBackColor);
  const fontColor = computeFontColor(backingColor);
  // Grid lines: same color as backing
  const gridColor: number[] = [
    backingColor[0],
    backingColor[1],
    backingColor[2],
    1,
  ];
  const thinGridColor: number[] = [
    gridColor[0],
    gridColor[1],
    gridColor[2],
    0.5,
  ];
  const [pL, pT, pW, pH] = layout.plotLTWH;
  const noBack = [0, 0, 0, 0];
  const fntScale = layout.fontScale;
  const fontSize = layout.fontSize;
  const lineThick = Math.ceil(LINE_THICKNESS * layout.dpr);
  const gridThick = Math.ceil(LINE_THICKNESS * layout.dpr * 0.5);

  const outerMargin = fontSize * GRAPH_OUTER_MARGIN_EM;

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
  });

  // 2) Plot background (canvas back color)
  labels.push({
    data: new Float32Array(0),
    count: 0,
    backColor: [...canvasBackColor, 1],
    backRect: [pL, pT, pW, pH],
    backRadius: 0,
  });

  // 3) Compute value range and ticks
  const plotLines = normalizeData(data);
  let [mn, mx] = dataMinMax(data);
  const [spacing, ticMin] = calculateTickSpacing(mn, mx);
  const digits = Math.max(0, -1 * Math.floor(Math.log(spacing) / Math.log(10)));
  mn = Math.min(ticMin, mn);
  mx = Math.max(Math.ceil(mx / spacing) * spacing, mx);
  const rangeH = mx - mn;
  const scaleH = pH / rangeH;
  const scaleW = pW / (plotLines[0].length - 1);
  const plotBottom = pT + pH;

  // 4) Horizontal grid lines + Y-axis labels
  let lineH = ticMin;
  while (lineH <= mx) {
    const y = plotBottom - (lineH - mn) * scaleH;
    if (y >= pT - 1 && y <= plotBottom + 1) {
      lineSegments.push(buildLine(pL, y, pL + pW, y, gridThick, gridColor));
      const str = lineH.toFixed(digits);
      const textBatch = buildText(
        str,
        pL - fontSize * GRAPH_Y_GAP_EM,
        y,
        fntScale,
        fontColor,
        1,
        0.5,
        noBack,
      );
      textBatch.backRect = [];
      labels.push(textBatch);
    }
    lineH += spacing;
  }

  // 5) Vertical grid lines + X-axis labels
  let stride = 1;
  while (plotLines[0].length / stride > 12) {
    stride *= 5;
  }
  for (let i = 0; i < plotLines[0].length; i += stride) {
    const x = i * scaleW + pL;
    lineSegments.push(
      buildLine(
        x,
        pT,
        x,
        plotBottom,
        gridThick,
        i % (stride * 2) === 0 ? gridColor : thinGridColor,
      ),
    );
    if (i % (stride * 2) === 0) {
      const str = humanize(i);
      const textBatch = buildText(
        str,
        x,
        plotBottom + fontSize * 0.2,
        fntScale,
        fontColor,
        0.5,
        0,
        noBack,
      );
      textBatch.backRect = [];
      labels.push(textBatch);
    }
  }

  // 6) Data lines (clamped to plot area)
  let hasAboveMax = false;
  let hasBelowMin = false;
  for (let j = 0; j < plotLines.length; j++) {
    const lineColor = [LINE_RGB[0], LINE_RGB[1], LINE_RGB[2], 1];
    for (let i = 1; i < plotLines[j].length; i++) {
      const x0 = (i - 1) * scaleW + pL;
      const x1 = i * scaleW + pL;
      let y0 = plotBottom - (plotLines[j][i - 1] - mn) * scaleH;
      let y1 = plotBottom - (plotLines[j][i] - mn) * scaleH;
      if (y0 < pT || y1 < pT) hasAboveMax = true;
      if (y0 > plotBottom || y1 > plotBottom) hasBelowMin = true;
      y0 = Math.max(pT, Math.min(plotBottom, y0));
      y1 = Math.max(pT, Math.min(plotBottom, y1));
      lineSegments.push(buildLine(x0, y0, x1, y1, lineThick, lineColor));
    }
  }

  // 6b) Out-of-range indicator boxes when isRangeCalMinMax is active
  if (data.graphConfig.isRangeCalMinMax) {
    const boxSize = fontSize * 0.6;
    const clampColor: [number, number, number, number] = [
      LINE_RGB[0],
      LINE_RGB[1],
      LINE_RGB[2],
      0.8,
    ];
    if (hasAboveMax) {
      labels.push({
        data: new Float32Array(0),
        count: 0,
        backColor: clampColor,
        backRect: [pL + 2, pT + 2, boxSize, boxSize],
        backRadius: 2,
      });
    }
    if (hasBelowMin) {
      labels.push({
        data: new Float32Array(0),
        count: 0,
        backColor: clampColor,
        backRect: [pL + 2, plotBottom - boxSize - 2, boxSize, boxSize],
        backRadius: 2,
      });
    }
  }

  // 7) Selected column (current frame) indicator
  if (data.selectedColumn >= 0 && data.selectedColumn < plotLines[0].length) {
    const x = data.selectedColumn * scaleW + pL;
    const selColor = [LINE_RGB[0], LINE_RGB[1], LINE_RGB[2], 1];
    lineSegments.push(buildLine(x, pT, x, plotBottom, lineThick, selColor));
  }

  // 8) "Volume" label below X-axis
  const volumeLabelY = plotBottom + fontSize * 1.5;
  if (fontSize > 6) {
    const labelBatch = buildText(
      "Volume",
      pL + pW * 0.5,
      volumeLabelY,
      fntScale,
      fontColor,
      0.5,
      0,
      noBack,
    );
    labelBatch.backRect = [];
    labels.push(labelBatch);
  }

  // 9) Ellipsis indicator for deferred frames (same row as "Volume", right-justified)
  if (layout.hasDeferred && fontSize > 6) {
    const ellipsisX =
      layout.x + layout.width - outerMargin - fontSize * GRAPH_Y_GAP_EM;
    const ellipsisBatch = buildText(
      "...",
      ellipsisX,
      volumeLabelY,
      fntScale,
      fontColor,
      1,
      0,
      noBack,
    );
    ellipsisBatch.backRect = [];
    labels.push(ellipsisBatch);
  }

  return { labels, lines: lineSegments };
}

/**
 * Hit-test the graph area. Returns:
 * - { type: 'frame', frame: number } if a frame column was clicked
 * - { type: 'deferred' } if the ellipsis area was clicked
 * - null if outside the graph
 */
export function graphHitTest(
  x: number,
  y: number,
  layout: GraphLayout | null,
): { type: "frame"; frame: number } | { type: "deferred" } | null {
  if (!layout) return null;
  const [pL, pT, pW, pH] = layout.plotLTWH;
  // Check deferred ellipsis click (right-justified, same row as "Volume" label)
  if (layout.hasDeferred) {
    const fs = layout.fontSize;
    const ellipsisY = pT + pH + fs * 1.5;
    const ellipsisX =
      layout.x + layout.width - fs * (GRAPH_OUTER_MARGIN_EM + GRAPH_Y_GAP_EM);
    if (
      x >= ellipsisX - fs * 2 &&
      x <= ellipsisX &&
      y >= ellipsisY - fs * 0.5 &&
      y <= ellipsisY + fs * 1.5
    ) {
      return { type: "deferred" };
    }
  }
  // Check plot area click
  if (x >= pL && x <= pL + pW && y >= pT && y <= pT + pH) {
    const frac = (x - pL) / pW;
    const frame = Math.round(frac * (plotLines_length(layout) - 1));
    return {
      type: "frame",
      frame: Math.max(0, Math.min(frame, plotLines_length(layout) - 1)),
    };
  }
  // Check if inside graph backing area at all (consume click to prevent tile interaction)
  if (
    x >= layout.x &&
    x <= layout.x + layout.width &&
    y >= layout.y &&
    y <= layout.y + layout.height
  ) {
    return { type: "frame", frame: -1 };
  }
  return null;
}

function plotLines_length(layout: GraphLayout): number {
  return layout.nFrames;
}
