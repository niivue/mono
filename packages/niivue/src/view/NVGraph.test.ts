import { describe, expect, test } from 'bun:test'
import type { GraphConfig } from '@/NVTypes'
import type { GlyphBatch } from './NVFont'
import {
  buildGraphElements,
  clipSegmentX,
  computeGraphLayout,
  type GraphData,
  type GraphSeries,
  graphHitTest,
  graphTotalWidth,
  signalFracAtXValue,
  signalValuesAt,
  signalXValueAtFrac,
} from './NVGraph'
import type { LineData } from './NVLine'

const CFG: GraphConfig = { normalizeValues: false, isRangeCalMinMax: false }

function signalData(
  series: GraphSeries[],
  extra: Partial<GraphData> = {},
): GraphData {
  return {
    lines: [],
    selectedColumn: -1,
    calMin: 0,
    calMax: 0,
    nTotalFrame4D: 0,
    graphConfig: CFG,
    series,
    ...extra,
  }
}

// Recording stub builders.
type TextCall = { str: string; x: number; y: number; color?: number[] }
type LineCall = {
  x0: number
  y0: number
  x1: number
  y1: number
  thick: number
  color: number[]
}

function makeStubs() {
  const texts: TextCall[] = []
  const lines: LineCall[] = []
  const buildText = (
    str: string,
    x: number,
    y: number,
    _scale: number,
    color?: number[],
  ): GlyphBatch => {
    texts.push({ str, x, y, color })
    return {
      data: new Float32Array(0),
      count: 0,
      backColor: [],
      backRect: [],
      backRadius: 0,
    }
  }
  const buildLine = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    thick: number,
    color: number[],
  ): LineData => {
    lines.push({ x0, y0, x1, y1, thick, color })
    return { data: new Float32Array(0) }
  }
  return { texts, lines, buildText, buildLine }
}

const W = 800
const H = 600

describe('signal-mode layout', () => {
  test('graphTotalWidthPositiveForTwoPoints', () => {
    const data = signalData([{ label: 'a', x: null, y: [1, 2, 3] }])
    expect(graphTotalWidth(data, W, H)).toBeGreaterThan(0)
  })

  test('graphTotalWidthZeroForSinglePoint', () => {
    const data = signalData([{ label: 'a', x: null, y: [1] }])
    expect(graphTotalWidth(data, W, H)).toBe(0)
  })
})

describe('volume-mode fullCanvas (SLICE_TYPE.NONE hands the canvas to the plot)', () => {
  function volumeData(extra: Partial<GraphData> = {}): GraphData {
    return {
      lines: [[1, 2, 3, 2, 1]],
      selectedColumn: 0,
      calMin: 0,
      calMax: 0,
      nTotalFrame4D: 5,
      graphConfig: CFG,
      ...extra,
    }
  }
  test('side strip by default', () => {
    const w = graphTotalWidth(volumeData(), W, H)
    expect(w).toBeGreaterThan(0)
    expect(w).toBeLessThan(W) // narrow strip beside the slices
  })
  test('fills the canvas when fullCanvas (the regressed case)', () => {
    expect(graphTotalWidth(volumeData({ fullCanvas: true }), W, H)).toBe(W)
  })
  test('fills a >4096-px backing canvas (not capped to GRAPH_MAX_WIDTH)', () => {
    // 4K/5K or high-DPR backing widths must not leave a blank strip on NONE.
    expect(graphTotalWidth(volumeData({ fullCanvas: true }), 5120, H)).toBe(
      5120,
    )
  })

  test('computeLayoutFlagsSignalMode', () => {
    const data = signalData([{ label: 'a', x: null, y: [1, 2, 3, 4] }])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    expect(layout).not.toBeNull()
    expect(layout?.isSignal).toBe(true)
    const [, , pW, pH] = layout?.plotLTWH ?? [0, 0, 0, 0]
    expect(pW).toBeGreaterThan(20)
    expect(pH).toBeGreaterThan(20)
  })
})

describe('signal-mode rendering', () => {
  function dataLines(lines: LineCall[]): LineCall[] {
    // data traces use the thicker line; grid lines are thinner
    const maxThick = Math.max(...lines.map((l) => l.thick))
    return lines.filter((l) => l.thick === maxThick)
  }

  test('eachSeriesGetsDistinctColor', () => {
    const data = signalData([
      { label: 'A', x: [0, 1, 2], y: [1, 2, 3] },
      { label: 'B', x: [0, 1, 2], y: [3, 2, 1] },
    ])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const colors = new Set(dataLines(lines).map((l) => l.color.join(',')))
    expect(colors.size).toBe(2)
  })

  test('legendRendersSeriesLabels', () => {
    const data = signalData([
      { label: 'cardiac', x: null, y: [1, 2, 3] },
      { label: 'respiratory', x: null, y: [3, 2, 1] },
    ])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { texts, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const labels = texts.map((t) => t.str)
    expect(labels).toContain('cardiac')
    expect(labels).toContain('respiratory')
  })

  test('reversedAxisFlipsXMapping', () => {
    const series: GraphSeries[] = [{ label: 'a', x: [0, 10], y: [5, 5] }]
    const fwd = signalData(series, {
      xAxis: { label: 'x', reversed: false, min: 0, max: 10 },
    })
    const rev = signalData(series, {
      xAxis: { label: 'ppm', reversed: true, min: 0, max: 10 },
    })
    const layout = computeGraphLayout(fwd, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const sFwd = makeStubs()
    buildGraphElements(fwd, layout, sFwd.buildText, sFwd.buildLine, [0, 0, 0])
    const sRev = makeStubs()
    buildGraphElements(rev, layout, sRev.buildText, sRev.buildLine, [0, 0, 0])
    const segFwd = dataLines(sFwd.lines)[0]
    const segRev = dataLines(sRev.lines)[0]
    // Forward: first point (x=0) left of second (x=10). Reversed: opposite.
    expect(segFwd.x0).toBeLessThan(segFwd.x1)
    expect(segRev.x0).toBeGreaterThan(segRev.x1)
  })

  test('xWindowExcludesOutOfRangeSpikeFromYScale', () => {
    // Spike of 100 sits outside the [0,1] window; in-window max is 2 and
    // should map near the top of the plot (range must ignore the spike).
    const data = signalData([
      { label: 'a', x: [0, 1, 2, 3], y: [1, 2, 100, 2] },
    ])
    const windowed = signalData(data.series ?? [], {
      xAxis: { label: 'x', reversed: false, min: 0, max: 1 },
    })
    const layout = computeGraphLayout(windowed, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, pT, , pH] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(windowed, layout, buildText, buildLine, [0, 0, 0])
    const segs = dataLines(lines)
    // only one in-window segment (x=0 -> x=1); its top endpoint near plot top
    const topY = Math.min(...segs.flatMap((s) => [s.y0, s.y1]))
    expect(topY).toBeLessThan(pT + 0.4 * pH)
  })
})

describe('missing-data rug (NaN gaps)', () => {
  // Rug ticks are short VERTICAL lane segments whose bottom sits AT the plot
  // bottom (lane 0) or above it (stacked lanes) — never below. That cleanly
  // separates them from full-height grid verticals (too tall) and from x-axis
  // tick marks (which sit just below the plot bottom in the label gutter).
  function rugTicks(lines: LineCall[], pT: number, pH: number): LineCall[] {
    const bottom = pT + pH
    return lines.filter(
      (l) =>
        l.x0 === l.x1 && // vertical
        Math.abs(l.y1 - l.y0) < 0.25 * pH && // short (not a full grid vertical)
        Math.max(l.y0, l.y1) <= bottom + 1, // at/above the plot bottom, not below
    )
  }

  test('drawsATickPerMissingSample', () => {
    // gaps at x=1 and x=3 -> two rug ticks
    const data = signalData([
      { label: 'a', x: [0, 1, 2, 3, 4], y: [1, NaN, 3, NaN, 5] },
    ])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, pT, , pH] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    expect(rugTicks(lines, pT, pH).length).toBe(2)
  })

  test('coincidentGapsStackIntoSeparateLanes', () => {
    // both series miss x=1; their ticks must not overwrite (different y lanes)
    const data = signalData([
      { label: 'a', x: [0, 1, 2], y: [1, NaN, 3] },
      { label: 'b', x: [0, 1, 2], y: [3, NaN, 1] },
    ])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, pT, , pH] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const ticks = rugTicks(lines, pT, pH)
    expect(ticks.length).toBe(2)
    // same x column, different lanes -> different y ranges
    expect(ticks[0].x0).toBeCloseTo(ticks[1].x0, 5)
    expect(Math.max(ticks[0].y0, ticks[0].y1)).not.toBeCloseTo(
      Math.max(ticks[1].y0, ticks[1].y1),
      5,
    )
  })

  test('decimatesToAtMostOneTickPerPixelColumn', () => {
    // a long all-missing series cannot emit more ticks than the plot is wide
    const n = 4000
    const x = Array.from({ length: n }, (_, i) => i)
    const y = Array.from({ length: n }, () => NaN)
    const data = signalData([{ label: 'a', x, y }])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, pT, pW, pH] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const ticks = rugTicks(lines, pT, pH)
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.length).toBeLessThanOrEqual(Math.ceil(pW) + 1)
  })
})

describe('trigger rug (BIDS triggers)', () => {
  // Trigger ticks are short VERTICAL lane segments whose TOP sits AT the plot top
  // (lane 0) or below it (stacked lanes) — never near the bottom. Mirror of the
  // missing-data rug helper but anchored to pT instead of the plot bottom.
  function triggerTicks(lines: LineCall[], pT: number, pH: number): LineCall[] {
    return lines.filter(
      (l) =>
        l.x0 === l.x1 && // vertical
        Math.abs(l.y1 - l.y0) < 0.25 * pH && // short (not a full grid vertical)
        Math.min(l.y0, l.y1) >= pT - 1 && // top endpoint at/below the plot top
        Math.max(l.y0, l.y1) <= pT + 0.25 * pH, // within the top band, not bottom
    )
  }

  test('drawsATickPerVisibleTrigger', () => {
    const data = signalData([
      { label: 'a', x: [0, 1, 2, 3, 4], y: [1, 2, 3, 4, 5], triggers: [1, 3] },
    ])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, pT, , pH] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    expect(triggerTicks(lines, pT, pH).length).toBe(2)
  })

  test('clipsTriggersToVisibleWindow', () => {
    // triggers at x=1,3,5,7 but window is [0,4] -> only 1 and 3 draw
    const data = signalData(
      [{ label: 'a', x: [0, 2, 4], y: [1, 2, 3], triggers: [1, 3, 5, 7] }],
      { xAxis: { label: 'x', reversed: false, min: 0, max: 4 } },
    )
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, pT, , pH] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    expect(triggerTicks(lines, pT, pH).length).toBe(2)
  })

  test('decimatesToAtMostOneTickPerPixelColumn', () => {
    const n = 4000
    const triggers = Array.from({ length: n }, (_, i) => i)
    const data = signalData([
      { label: 'a', x: [0, n - 1], y: [1, 1], triggers },
    ])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, pT, pW, pH] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const ticks = triggerTicks(lines, pT, pH)
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.length).toBeLessThanOrEqual(Math.ceil(pW) + 1)
  })

  test('multipleSignalsStackIntoSeparateLanes', () => {
    const data = signalData([
      { label: 'a', x: [0, 1, 2], y: [1, 2, 3], triggers: [1] },
      { label: 'b', x: [0, 1, 2], y: [3, 2, 1], triggers: [1] },
    ])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, pT, , pH] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const ticks = triggerTicks(lines, pT, pH)
    expect(ticks.length).toBe(2)
    expect(ticks[0].x0).toBeCloseTo(ticks[1].x0, 5)
    // different lanes -> different y ranges
    expect(Math.max(ticks[0].y0, ticks[0].y1)).not.toBeCloseTo(
      Math.max(ticks[1].y0, ticks[1].y1),
      5,
    )
  })

  test('carriesCustomSeriesColorIntoTicks', () => {
    const data = signalData([
      {
        label: 'a',
        x: [0, 1, 2],
        y: [1, 2, 3],
        triggers: [1],
        color: [0.1, 0.2, 0.3, 1],
      },
    ])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, pT, , pH] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const ticks = triggerTicks(lines, pT, pH)
    expect(ticks.length).toBe(1)
    expect(ticks[0].color).toEqual([0.1, 0.2, 0.3, 1])
  })
})

describe('signal-mode hit test + cursor', () => {
  test('plotClickReturnsSignalCursorFraction', () => {
    const data = signalData([{ label: 'a', x: null, y: [1, 2, 3] }])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [pL, pT, pW, pH] = layout.plotLTWH
    const hit = graphHitTest(pL + pW * 0.5, pT + pH * 0.5, layout)
    expect(hit?.type).toBe('signalCursor')
    if (hit?.type === 'signalCursor') expect(hit.xFrac).toBeCloseTo(0.5, 5)
  })

  test('backingButNotPlotConsumedAsFrameMinusOne', () => {
    const data = signalData([{ label: 'a', x: null, y: [1, 2, 3] }])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    // top-left of backing, above/left of the plot area
    const hit = graphHitTest(layout.x + 2, layout.y + 2, layout)
    expect(hit).toEqual({ type: 'frame', frame: -1 })
  })

  test('outsideReturnsNull', () => {
    const data = signalData([{ label: 'a', x: null, y: [1, 2, 3] }])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    expect(graphHitTest(0, 0, layout)).toBeNull()
  })

  test('cursorDrawsFaintVerticalLine', () => {
    const data = signalData([{ label: 'a', x: [0, 10], y: [1, 2] }], {
      xAxis: { label: 'x', reversed: false, min: 0, max: 10 },
      cursorX: 5,
    })
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const cursor = lines.find(
      (l) => l.color[3] === 0.5 && Math.abs(l.x0 - l.x1) < 0.001,
    )
    expect(cursor).toBeDefined()
    const [pL, , pW] = layout.plotLTWH
    expect(cursor?.x0).toBeCloseTo(pL + 0.5 * pW, 1)
  })
})

describe('signal-mode annotations', () => {
  const series: GraphSeries[] = [
    { label: 'spec', x: [1, 2, 3, 4], y: [0, 5, 2, 1] },
  ]

  test('annotationTextRenderedWhenInsideWindow', () => {
    const data = signalData(series, {
      xAxis: { label: 'ppm', reversed: true, min: 1, max: 4 },
      annotations: [{ text: 'NAA', x: 2, y: Number.NEGATIVE_INFINITY }],
    })
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { texts, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    expect(texts.map((t) => t.str)).toContain('NAA')
  })

  test('annotationHiddenWhenOutsideWindow', () => {
    const data = signalData(series, {
      xAxis: { label: 'ppm', reversed: true, min: 1, max: 4 },
      annotations: [{ text: 'OOR', x: 9, y: Number.NEGATIVE_INFINITY }],
    })
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { texts, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    expect(texts.map((t) => t.str)).not.toContain('OOR')
  })

  test('negativeInfinityPinsToBottomPositiveInfinityToTop', () => {
    const data = signalData(series, {
      xAxis: { label: 'ppm', reversed: false, min: 1, max: 4 },
      annotations: [
        { text: 'bot', x: 2, y: Number.NEGATIVE_INFINITY },
        { text: 'top', x: 3, y: Number.POSITIVE_INFINITY },
      ],
    })
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { texts, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const [, pT, , pH] = layout.plotLTWH
    const bot = texts.find((t) => t.str === 'bot')
    const top = texts.find((t) => t.str === 'top')
    expect(bot).toBeDefined()
    expect(top).toBeDefined()
    // bottom-pinned label sits below the top-pinned one
    expect((bot?.y ?? 0) > (top?.y ?? 0)).toBe(true)
    expect(top?.y ?? 0).toBeLessThan(pT + pH * 0.5)
  })

  test('edgePinnedAnnotationDrawsGuideAtMappedX', () => {
    const data = signalData(series, {
      xAxis: { label: 'ppm', reversed: true, min: 1, max: 4 },
      annotations: [
        { text: 'NAA', x: 2, y: Number.NEGATIVE_INFINITY, color: [1, 0, 0, 1] },
      ],
    })
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const guide = lines.find(
      (l) =>
        l.color[0] === 1 &&
        l.color[3] === 0.35 &&
        Math.abs(l.x0 - l.x1) < 0.001,
    )
    expect(guide).toBeDefined()
    // reversed axis: t=(2-1)/(4-1)=1/3, drawn at (1-t)=2/3 across the plot
    const [pL, , pW] = layout.plotLTWH
    expect(guide?.x0).toBeCloseTo(pL + (2 / 3) * pW, 1)
  })

  test('finiteYAnnotationDrawsNoGuide', () => {
    const data = signalData(series, {
      xAxis: { label: 'ppm', reversed: false, min: 1, max: 4 },
      annotations: [{ text: 'mid', x: 2, y: 3 }],
    })
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { lines, texts, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    expect(texts.map((t) => t.str)).toContain('mid')
    expect(lines.some((l) => l.color[3] === 0.35)).toBe(false)
  })

  test('nanYAnnotationSkippedNoTextNoGuideNoNaNPosition', () => {
    const data = signalData(series, {
      xAxis: { label: 'ppm', reversed: false, min: 1, max: 4 },
      annotations: [{ text: 'bad', x: 2, y: Number.NaN }],
    })
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { lines, texts, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    // Malformed NaN y: no label, no spurious guide, no NaN screen positions.
    expect(texts.map((t) => t.str)).not.toContain('bad')
    expect(lines.some((l) => l.color[3] === 0.35)).toBe(false)
    expect(
      texts.every((t) => Number.isFinite(t.x) && Number.isFinite(t.y)),
    ).toBe(true)
    expect(
      lines.every(
        (l) =>
          Number.isFinite(l.x0) &&
          Number.isFinite(l.y0) &&
          Number.isFinite(l.x1) &&
          Number.isFinite(l.y1),
      ),
    ).toBe(true)
  })

  test('nanXAnnotationSkipped', () => {
    const data = signalData(series, {
      xAxis: { label: 'ppm', reversed: false, min: 1, max: 4 },
      annotations: [
        { text: 'badx', x: Number.NaN, y: Number.NEGATIVE_INFINITY },
      ],
    })
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { texts, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    expect(texts.map((t) => t.str)).not.toContain('badx')
  })
})

describe('signal-mode performance bounds', () => {
  function dataLines(lines: LineCall[]): LineCall[] {
    const maxThick = Math.max(...lines.map((l) => l.thick))
    return lines.filter((l) => l.thick === maxThick)
  }

  test('denseSeriesDecimatedToPlotWidth', () => {
    const n = 5000
    const y = new Float32Array(n)
    for (let i = 0; i < n; i++) y[i] = Math.sin(i * 0.1)
    const data = signalData([{ label: 'dense', x: null, y }])
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const [, , pW] = layout.plotLTWH
    const { lines, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const segs = dataLines(lines)
    // connected envelope: at most ~2 segments per pixel column (connector + bar),
    // never ~5000 segments
    expect(segs.length).toBeLessThanOrEqual(2 * (Math.ceil(pW) + 1))
    expect(segs.length).toBeLessThan(n)
  })

  test('legendCappedWithMoreRow', () => {
    const series: GraphSeries[] = []
    for (let j = 0; j < 30; j++) {
      series.push({ label: `S${j}`, x: null, y: [1, 2, 3] })
    }
    const data = signalData(series, { showLegend: true })
    const layout = computeGraphLayout(data, W, H, 0, 1)
    if (!layout) throw new Error('no layout')
    const { texts, buildText, buildLine } = makeStubs()
    buildGraphElements(data, layout, buildText, buildLine, [0, 0, 0])
    const labels = texts.map((t) => t.str)
    expect(labels.some((l) => /^\+\d+ more$/.test(l))).toBe(true)
    expect(labels).not.toContain('S29') // not every series labelled
  })
})

describe('signal cursor mapping', () => {
  test('xValueAtFracForwardAndReversed', () => {
    const fwd = signalData([{ label: 'a', x: [0, 10], y: [1, 2] }], {
      xAxis: { label: 'x', reversed: false, min: 0, max: 10 },
    })
    expect(signalXValueAtFrac(fwd, 0)).toBeCloseTo(0, 5)
    expect(signalXValueAtFrac(fwd, 1)).toBeCloseTo(10, 5)
    const rev = signalData([{ label: 'a', x: [0, 10], y: [1, 2] }], {
      xAxis: { label: 'ppm', reversed: true, min: 0, max: 10 },
    })
    expect(signalXValueAtFrac(rev, 0)).toBeCloseTo(10, 5)
    expect(signalXValueAtFrac(rev, 1)).toBeCloseTo(0, 5)
  })

  test('valuesAtNearestSample', () => {
    const d = signalData([
      { label: 'a', x: [0, 1, 2], y: [10, 20, 30] },
      { label: 'b', x: [0, 1, 2], y: [5, 6, 7] },
    ])
    const v = signalValuesAt(d, 1.1)
    expect(v.length).toBe(2)
    expect(v[0].label).toBe('a')
    expect(v[0].value).toBe(20)
    expect(v[1].value).toBe(6)
  })

  test('fracAtXValueInvertsXValueAtFrac', () => {
    for (const reversed of [false, true]) {
      const d = signalData([{ label: 'a', x: [0, 10], y: [1, 2] }], {
        xAxis: { label: 'x', reversed, min: 2, max: 8 },
      })
      for (const frac of [0, 0.25, 0.5, 1]) {
        const xv = signalXValueAtFrac(d, frac)
        expect(signalFracAtXValue(d, xv)).toBeCloseTo(frac, 5)
      }
    }
  })

  test('valuesAtPrefersRawYWhenPresent', () => {
    // Display y is normalized [0,1]; rawY carries the real values for readout.
    const d = signalData([
      { label: 'bold', x: [0, 1, 2], y: [0, 0.5, 1], rawY: [100, 150, 200] },
    ])
    const v = signalValuesAt(d, 1)
    expect(v[0].value).toBe(150)
  })

  test('valuesAtConstrainedToWindow', () => {
    // Samples at x=2,3 are outside the [0,1] window and must not be reported.
    const d = signalData(
      [{ label: 'a', x: [0, 1, 2, 3], y: [10, 20, 30, 40] }],
      {
        xAxis: { label: 'x', reversed: false, min: 0, max: 1 },
      },
    )
    expect(signalValuesAt(d, 0.9)[0].value).toBe(20)
  })
})

describe('signal-mode pan/zoom controls', () => {
  // 100 samples over x in [0,99] on a full-canvas graph so it is wide enough
  // for the controls to be laid out.
  const N = 100
  const x = Float32Array.from({ length: N }, (_, i) => i)
  const y = Float32Array.from({ length: N }, (_, i) => Math.sin(i * 0.3))
  const layoutFor = (extra: Partial<GraphData>) => {
    const data = signalData([{ label: 'a', x, y }], {
      fullCanvas: true,
      ...extra,
    })
    return computeGraphLayout(data, W, H, 0, 1)
  }
  const by = (L: ReturnType<typeof computeGraphLayout>, id: string) =>
    L?.controls?.find((c) => c.id === id)

  test('noControlsBelowPointThreshold', () => {
    const data = signalData([{ label: 'a', x: null, y: [1, 2, 3, 4] }], {
      fullCanvas: true,
    })
    expect(computeGraphLayout(data, W, H, 0, 1)?.controls).toBeUndefined()
  })

  test('fullView_zoomOutAndPanDisabled_zoomInEnabled', () => {
    const L = layoutFor({
      xAxis: { label: 't', reversed: false, min: 0, max: 99 },
      fullXDomain: [0, 99],
    })
    expect(L?.controls?.length).toBe(4)
    expect(by(L, 'zoomIn')?.disabled).toBe(false)
    expect(by(L, 'zoomOut')?.disabled).toBe(true)
    expect(by(L, 'panLeft')?.disabled).toBe(true)
    expect(by(L, 'panRight')?.disabled).toBe(true)
  })

  test('windowedMiddle_allEnabled', () => {
    const L = layoutFor({
      xAxis: { label: 't', reversed: false, min: 40, max: 60 },
      fullXDomain: [0, 99],
    })
    expect(by(L, 'panLeft')?.disabled).toBe(false)
    expect(by(L, 'panRight')?.disabled).toBe(false)
    expect(by(L, 'zoomOut')?.disabled).toBe(false)
  })

  test('windowedAtLeftEdge_panLeftDisabled', () => {
    const L = layoutFor({
      xAxis: { label: 't', reversed: false, min: 0, max: 20 },
      fullXDomain: [0, 99],
    })
    expect(by(L, 'panLeft')?.disabled).toBe(true)
    expect(by(L, 'panRight')?.disabled).toBe(false)
  })

  test('reversedAxis_swapsScreenEdges', () => {
    // Window at the data MIN on a reversed (ppm) axis = the screen-RIGHT edge.
    const L = layoutFor({
      xAxis: { label: 'ppm', reversed: true, min: 0, max: 20 },
      fullXDomain: [0, 99],
    })
    expect(by(L, 'panRight')?.disabled).toBe(true)
    expect(by(L, 'panLeft')?.disabled).toBe(false)
  })

  test('hitTest_enabledControlReturnsId_disabledSkipped', () => {
    const L = layoutFor({
      xAxis: { label: 't', reversed: false, min: 40, max: 60 },
      fullXDomain: [0, 99],
    })
    const zin = by(L, 'zoomIn')
    if (!zin) throw new Error('no zoomIn control')
    expect(graphHitTest(zin.x + zin.w / 2, zin.y + zin.h / 2, L)).toEqual({
      type: 'graphControl',
      id: 'zoomIn',
    })
    // At full view panLeft is disabled -> hit-test must NOT report it.
    const Lfull = layoutFor({
      xAxis: { label: 't', reversed: false, min: 0, max: 99 },
      fullXDomain: [0, 99],
    })
    const pl = by(Lfull, 'panLeft')
    if (!pl) throw new Error('no panLeft control')
    expect(
      graphHitTest(pl.x + pl.w / 2, pl.y + pl.h / 2, Lfull)?.type,
    ).not.toBe('graphControl')
  })

  test('controlsVisibleOnWideSideStripGraph', () => {
    // NOT full-canvas (side strip), but a wide canvas -> the relaxed gate (button
    // span + label width) should still show the controls.
    const data = signalData([{ label: 'a', x, y }], {
      xAxis: { label: 't', reversed: false, min: 0, max: 99 },
      fullXDomain: [0, 99],
    })
    expect(computeGraphLayout(data, 2400, 800, 0, 1)?.controls?.length).toBe(4)
  })

  test('axisTitleNeverLeftOfPlotCentreWhenControlsPresent', () => {
    // The title is shifted right (never left) to clear the left-aligned buttons.
    const data = signalData([{ label: 'a', x, y }], {
      xAxis: { label: 'Time (s)', reversed: false, min: 40, max: 60 },
      fullXDomain: [0, 99],
    })
    const L = computeGraphLayout(data, 2400, 800, 0, 1)
    if (!L?.controls?.length) throw new Error('expected controls')
    const [pL, , pW] = L.plotLTWH
    const { texts, buildText, buildLine } = makeStubs()
    buildGraphElements(data, L, buildText, buildLine, [0, 0, 0])
    const title = texts.find((t) => t.str === 'Time (s)')
    expect(title).toBeDefined()
    expect(title?.x).toBeGreaterThanOrEqual(pL + pW * 0.5)
  })
})

describe('clipSegmentX (edge interpolation)', () => {
  test('bothInside_unchanged', () => {
    expect(clipSegmentX(2, 10, 8, 40, 0, 10)).toEqual([2, 10, 8, 40])
  })
  test('leftNeighbourOutside_clipsToMinAndInterpolatesY', () => {
    // segment from (-10,0) to (10,100); at x=0 y interpolates to 50
    const c = clipSegmentX(-10, 0, 10, 100, 0, 10)
    expect(c?.[0]).toBe(0)
    expect(c?.[1]).toBeCloseTo(50, 5)
    expect(c?.[2]).toBe(10)
  })
  test('rightNeighbourOutside_clipsToMax', () => {
    const c = clipSegmentX(5, 0, 25, 200, 0, 10)
    expect(c?.[2]).toBe(10)
    expect(c?.[3]).toBeCloseTo(50, 5) // (10-5)/(25-5)*200
  })
  test('entirelyOutside_null', () => {
    expect(clipSegmentX(20, 0, 30, 0, 0, 10)).toBeNull()
  })
  test('verticalInRange_kept', () => {
    expect(clipSegmentX(5, 0, 5, 9, 0, 10)).toEqual([5, 0, 5, 9])
  })
})
