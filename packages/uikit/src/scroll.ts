// Pure row-scrolling model shared by every UIKit container that shows a list
// taller than its viewport: menu and select popups today, dialogs and list
// boxes later. Scrolling is by whole rows, so the viewport always starts at a
// row boundary and a container only ever draws rows that lie fully inside it.
// That is what lets the rect and text overlays draw a scrolled list without a
// GPU scissor. A WheelAccumulator turns raw wheel deltas into row steps, and
// buildScrollArrow draws the chevron a container shows on a scroll strip.
// No GPU and no DOM here.

import { buildLine, type LineData } from './line'
import type { RGBA } from './text/layout'

/** An axis-aligned box in canvas pixels. */
export interface UIKitBox {
  x: number
  y: number
  width: number
  height: number
}

/** The run of rows a viewport shows, by index. */
export interface ScrollRange {
  /** Index of the first visible row. */
  first: number
  /** Index after the last visible row. */
  end: number
}

/** A scroll range plus what `scrollWindow` learned while fitting it. */
export interface ScrollWindow extends ScrollRange {
  /** The largest `first` at which the tail of the list still fills the viewport. */
  maxFirst: number
  /** Total height of the visible rows (at most the viewport height). */
  usedHeight: number
}

/**
 * The rows that fit in a viewport of `viewport` height starting at row
 * `first`, after clamping `first` into [0, maxFirst] so the list never
 * scrolls past its end. Rows are given by their heights in order. A row
 * taller than the viewport is never shown.
 */
export function scrollWindow(
  heights: readonly number[],
  viewport: number,
  first: number,
): ScrollWindow {
  const n = heights.length
  let maxFirst = n
  let tail = 0
  for (let i = n - 1; i >= 0; i--) {
    if (tail + heights[i] > viewport) break
    tail += heights[i]
    maxFirst = i
  }
  const start = Math.max(0, Math.min(Math.floor(first), maxFirst))
  let end = start
  let usedHeight = 0
  while (end < n && usedHeight + heights[end] <= viewport) {
    usedHeight += heights[end]
    end++
  }
  return { first: start, end, maxFirst, usedHeight }
}

/**
 * The `first` row that brings row `index` into a viewport currently showing
 * `shown`, moving as little as possible: unchanged when the row is already
 * visible, the row itself when it lies above, and otherwise the earliest row
 * from which `index` is still the last one that fits.
 */
export function revealRow(
  heights: readonly number[],
  viewport: number,
  shown: ScrollRange,
  index: number,
): number {
  if (index < 0 || index >= heights.length) return shown.first
  if (index >= shown.first && index < shown.end) return shown.first
  if (index < shown.first) return index
  let first = index
  let used = heights[index]
  while (first > 0 && used + heights[first - 1] <= viewport) {
    used += heights[first - 1]
    first--
  }
  return first
}

/** True when rows precede the shown range. */
export function canScrollUp(shown: ScrollRange): boolean {
  return shown.first > 0
}

/** True when rows follow the shown range. */
export function canScrollDown(shown: ScrollRange, rowCount: number): boolean {
  return shown.end < rowCount
}

/**
 * Turns a stream of wheel deltas (pixels) into whole row steps, carrying the
 * remainder so a trackpad's small deltas add up. `rowStep` is the number of
 * pixels per row.
 */
export class WheelAccumulator {
  private carry = 0

  constructor(private readonly rowStep: number) {}

  /** Feed a delta; returns the number of rows to scroll (negative is up). */
  add(delta: number): number {
    if (!Number.isFinite(delta) || this.rowStep <= 0) return 0
    this.carry += delta
    const steps = Math.trunc(this.carry / this.rowStep)
    this.carry -= steps * this.rowStep
    return steps
  }

  /** Drop any carried remainder (when the scrolled container closes). */
  reset(): void {
    this.carry = 0
  }
}

/** The look of the strips a container reserves at each end of a scrolled list. */
export interface ScrollStripStyle {
  /** Height of each strip. */
  height: number
  /** Width of the chevron drawn on an active strip. */
  arrowSize: number
  /** Chevron stroke width. */
  arrowWidth: number
  arrowColor: RGBA
}

/**
 * The chevron on a scroll strip: pointing up for `direction` -1, down for 1,
 * centred in `strip`.
 */
export function buildScrollArrow(
  strip: UIKitBox,
  direction: -1 | 1,
  style: ScrollStripStyle,
): LineData[] {
  const cx = strip.x + strip.width / 2
  const cy = strip.y + strip.height / 2
  const half = style.arrowSize / 2
  const rise = (style.arrowSize / 4) * direction
  return [
    buildLine(
      cx - half,
      cy - rise,
      cx,
      cy + rise,
      style.arrowWidth,
      style.arrowColor,
    ),
    buildLine(
      cx,
      cy + rise,
      cx + half,
      cy - rise,
      style.arrowWidth,
      style.arrowColor,
    ),
  ]
}
