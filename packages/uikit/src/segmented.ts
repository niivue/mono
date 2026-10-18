// Pure segmented control model for UIKit: a row of equal-width segments in one
// rounded track, exactly one of which is selected (a compact radio group, like
// a row of mode buttons). This file holds style resolution, layout, the value
// arithmetic for keyboard stepping, and the geometry for one visual state. No
// GPU and no DOM here; UIKitSegmentedOverlay wires it to the pointer, the
// keyboard and the overlay draw hook.

import { mixColor } from './button'
import { buildLine, type LineData } from './line'
import { buildRect, type RectData } from './rect'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { UIKitTextItem } from './textOverlay'
import { buildFocusRing } from './toggle'

/** Every visual knob on a segmented control. All lengths are in canvas pixels. */
export interface SegmentedStyle {
  /** Control height, unless the spec fixes one. */
  height: number
  /** Space between a segment's edge and its label (sets the segment width). */
  paddingX: number
  /** Space between the track edge and the segment faces. */
  inset: number
  /** Corner radius of the track; segment faces use what is left after the inset. */
  radius: number
  trackFill: RGBA
  trackBorder: RGBA
  trackBorderWidth: number
  /** Face of the selected segment. */
  selectedFill: RGBA
  /** Face of an unselected segment under the pointer. */
  hoverFill: RGBA
  /** Face of a segment while the pointer holds it down. */
  pressedFill: RGBA
  textColor: RGBA
  selectedTextColor: RGBA
  disabledTextColor: RGBA
  /** Label em size. */
  textSizePx: number
  /** Rule between two adjacent unselected segments. */
  dividerColor: RGBA
  /** Focus ring color (around the track while the control has keyboard focus). */
  focusRing: RGBA
  focusRingWidth: number
}

export const DEFAULT_SEGMENTED_STYLE: SegmentedStyle = {
  height: 28,
  paddingX: 12,
  inset: 2,
  radius: 6,
  trackFill: [0.12, 0.13, 0.17, 0.96],
  trackBorder: [0.6, 0.66, 0.78, 1],
  trackBorderWidth: 1,
  selectedFill: [0.25, 0.47, 0.85, 1],
  hoverFill: [0.24, 0.27, 0.34, 0.96],
  pressedFill: [0.09, 0.1, 0.13, 1],
  textColor: [1, 1, 1, 1],
  selectedTextColor: [1, 1, 1, 1],
  disabledTextColor: [1, 1, 1, 0.45],
  textSizePx: 14,
  dividerColor: [0.6, 0.66, 0.78, 0.4],
  focusRing: [0.55, 0.7, 1, 0.9],
  focusRingWidth: 2,
}

export interface SegmentSpec {
  /** The value reported to `onChange` and held by the control. Unique per control. */
  value: string
  label: string
  /** A disabled segment draws dimmed and cannot be chosen. Default true. */
  enabled?: boolean
}

export interface SegmentedSpec {
  /** Stable key: the handle for updates, pointer tracking and the callback. */
  id: string
  /** Top-left corner of the track, in canvas pixels. */
  x: number
  y: number
  segments: readonly SegmentSpec[]
  /** The selected segment's value, or null for none. */
  value: string | null
  /** Width of every segment. Defaults to the widest label plus padding. */
  segmentWidth?: number
  /** Control height. Defaults to the style's. */
  height?: number
  /** A disabled control draws dimmed and ignores input. Default true. */
  enabled?: boolean
  /** Per-control overrides of the overlay's default style. */
  style?: Partial<SegmentedStyle>
  /** Fired when the user selects a different segment (pointer or keyboard), not by `setValue`. */
  onChange?: (value: string, id: string) => void
}

/** One segment's face, in canvas pixels. */
export interface SegmentLayout {
  index: number
  x: number
  y: number
  width: number
  height: number
}

/** The track and its segments, in canvas pixels. */
export interface SegmentedLayout {
  x: number
  y: number
  width: number
  height: number
  segments: SegmentLayout[]
}

/** The transient state that changes how a segmented control looks. */
export interface SegmentedVisual {
  /** Index of the selected segment, or -1. */
  selected: number
  /** Index of the segment under the pointer, or -1. */
  hover: number
  /** Index of the segment the pointer holds down, or -1. */
  pressed: number
  focused: boolean
  enabled: boolean
}

export function resolveSegmentedStyle(
  base: SegmentedStyle,
  override?: Partial<SegmentedStyle>,
): SegmentedStyle {
  return override ? { ...base, ...override } : base
}

/** The track for a spec, with equal-width segment faces inside the inset. */
export function layoutSegmented(
  spec: SegmentedSpec,
  style: SegmentedStyle,
  metrics: UIKitFontMetrics,
): SegmentedLayout {
  const size = style.textSizePx
  let labelW = 0
  for (const s of spec.segments) {
    labelW = Math.max(labelW, measureWidth(metrics, s.label, size))
  }
  const segW = spec.segmentWidth ?? Math.ceil(labelW + 2 * style.paddingX)
  const height = spec.height ?? style.height
  const n = spec.segments.length
  const width = n * segW + 2 * style.inset
  const segments: SegmentLayout[] = spec.segments.map((_, index) => ({
    index,
    x: spec.x + style.inset + index * segW,
    y: spec.y + style.inset,
    width: segW,
    height: height - 2 * style.inset,
  }))
  return { x: spec.x, y: spec.y, width, height, segments }
}

/** Scale every length in a spec and style by `k` (CSS pixels to canvas pixels). */
export function scaleSegmented(
  spec: SegmentedSpec,
  style: SegmentedStyle,
  k: number,
): { spec: SegmentedSpec; style: SegmentedStyle } {
  if (k === 1) return { spec, style }
  return {
    spec: {
      ...spec,
      x: spec.x * k,
      y: spec.y * k,
      segmentWidth:
        spec.segmentWidth === undefined ? undefined : spec.segmentWidth * k,
      height: spec.height === undefined ? undefined : spec.height * k,
    },
    style: {
      ...style,
      height: style.height * k,
      paddingX: style.paddingX * k,
      inset: style.inset * k,
      radius: style.radius * k,
      trackBorderWidth: style.trackBorderWidth * k,
      textSizePx: style.textSizePx * k,
      focusRingWidth: style.focusRingWidth * k,
    },
  }
}

/** True when canvas point (px, py) lies inside the track. */
export function segmentedContains(
  layout: SegmentedLayout,
  px: number,
  py: number,
): boolean {
  return (
    px >= layout.x &&
    px < layout.x + layout.width &&
    py >= layout.y &&
    py < layout.y + layout.height
  )
}

/**
 * The index of the segment under a canvas point, or -1. The inset around the
 * faces counts toward the nearest segment, so the whole track is clickable.
 */
export function segmentAt(
  layout: SegmentedLayout,
  px: number,
  py: number,
): number {
  if (!segmentedContains(layout, px, py) || layout.segments.length === 0)
    return -1
  const first = layout.segments[0]
  const i = Math.floor((px - first.x) / first.width)
  return Math.max(0, Math.min(layout.segments.length - 1, i))
}

/** The index of the segment holding `value`, or -1. */
export function segmentIndex(
  segments: readonly SegmentSpec[],
  value: string | null,
): number {
  return value === null ? -1 : segments.findIndex((s) => s.value === value)
}

/**
 * The value of the next enabled segment from the current one in `direction`,
 * wrapping around like a radio group. From no value, the first step lands on
 * the first (or last) enabled segment. Returns the current value when no
 * segment is enabled.
 */
export function stepSegmentValue(
  segments: readonly SegmentSpec[],
  value: string | null,
  direction: 1 | -1,
): string | null {
  const n = segments.length
  if (n === 0) return value
  const from = segmentIndex(segments, value)
  let i = from < 0 ? (direction > 0 ? -1 : n) : from
  for (let step = 0; step < n; step++) {
    i = (i + direction + n) % n
    if (segments[i].enabled !== false) return segments[i].value
  }
  return value
}

/** The first or last enabled segment's value, or the current one when there is none. */
export function endSegmentValue(
  segments: readonly SegmentSpec[],
  value: string | null,
  end: 'first' | 'last',
): string | null {
  const enabled = segments.filter((s) => s.enabled !== false)
  if (enabled.length === 0) return value
  return enabled[end === 'first' ? 0 : enabled.length - 1].value
}

/**
 * The draw data for one segmented control in one visual state: a focus ring
 * when focused, the track, a face under the selected segment and under a
 * hovered or pressed one, dividers between adjacent plain segments, and the
 * centred labels.
 */
export function buildSegmented(
  spec: SegmentedSpec,
  style: SegmentedStyle,
  metrics: UIKitFontMetrics,
  layout: SegmentedLayout,
  visual: SegmentedVisual,
): { rects: RectData[]; lines: LineData[]; text: UIKitTextItem[] } {
  const rects: RectData[] = []
  const lines: LineData[] = []
  const text: UIKitTextItem[] = []
  const dim = (c: RGBA): RGBA =>
    visual.enabled ? c : mixColor(c, [c[0], c[1], c[2], 0], 0.5)
  if (visual.focused && visual.enabled) {
    rects.push(
      buildFocusRing(
        layout,
        style.radius,
        style.focusRing,
        style.focusRingWidth,
      ),
    )
  }
  rects.push(
    buildRect({
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
      radius: style.radius,
      borderWidth: style.trackBorderWidth,
      fill: dim(style.trackFill),
      border: dim(style.trackBorder),
    }),
  )
  const faceRadius = Math.max(0, style.radius - style.inset)
  const baselineDrop = (capHeight(metrics) * style.textSizePx) / 2
  const faced = new Set<number>()
  layout.segments.forEach((seg, i) => {
    const s = spec.segments[i]
    const segEnabled = visual.enabled && s.enabled !== false
    let fill: RGBA | null = null
    if (i === visual.selected) fill = style.selectedFill
    else if (segEnabled && i === visual.pressed) fill = style.pressedFill
    else if (segEnabled && i === visual.hover) fill = style.hoverFill
    if (fill) {
      faced.add(i)
      rects.push(
        buildRect({
          x: seg.x,
          y: seg.y,
          width: seg.width,
          height: seg.height,
          radius: faceRadius,
          fill: dim(fill),
        }),
      )
    }
    let color: RGBA
    if (!segEnabled) color = style.disabledTextColor
    else if (i === visual.selected) color = style.selectedTextColor
    else color = style.textColor
    text.push({
      str: s.label,
      x: seg.x + seg.width / 2,
      y: seg.y + seg.height / 2 + baselineDrop,
      sizePx: style.textSizePx,
      align: 0.5,
      color,
    })
  })
  for (let i = 1; i < layout.segments.length; i++) {
    if (faced.has(i - 1) || faced.has(i)) continue
    const seg = layout.segments[i]
    const pad = seg.height * 0.2
    lines.push(
      buildLine(
        seg.x,
        seg.y + pad,
        seg.x,
        seg.y + seg.height - pad,
        1,
        dim(style.dividerColor),
      ),
    )
  }
  return { rects, lines, text }
}
