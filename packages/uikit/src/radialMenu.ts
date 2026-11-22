// Pure radial menu model for UIKit: rings of items (labelled pills or color
// swatches) around a point, as a pencil's squeeze palette shows them. Layout,
// hit-testing and draw geometry only; UIKitRadialMenuOverlay wires it up.

import { mixColor } from './button'
import type { UIKitGeometry } from './overlayParts'
import { buildRect, type RectData, rectContains } from './rect'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { UIKitTextItem } from './textOverlay'

export interface RadialMenuItem {
  /** Passed to `onSelect`. */
  id: string
  /** The pill's text. A swatch draws none; its label is for assistive use. */
  label: string
  /** Draw a swatch filled with this color instead of a labelled pill. */
  color?: RGBA
  /** Which ring, 0 innermost. Default 0. */
  ring?: number
  /** Ringed as the current choice (the tool or color in use). */
  selected?: boolean
  /** A disabled item draws dimmed and can't be chosen. Default true. */
  enabled?: boolean
}

/** Every visual knob. All lengths are in canvas pixels. */
export interface RadialMenuStyle {
  /** Height of a pill and side of a swatch; the minimum touch target. */
  itemSize: number
  /** Space between items, between rings and around the outer ring. */
  gap: number
  /** Radius of the innermost ring's item centres, at the least. */
  innerRadius: number
  /** Space either side of a pill's label. */
  paddingX: number
  /** The disc behind the rings, and its rim (drawn `borderWidth` wide). */
  backdrop: RGBA
  backdropBorder: RGBA
  fill: RGBA
  hoverFill: RGBA
  border: RGBA
  borderWidth: number
  /** The ring around a selected item. */
  selectedBorder: RGBA
  selectedBorderWidth: number
  textColor: RGBA
  disabledTextColor: RGBA
  textSizePx: number
  /** Scale of the item under the pointer. */
  hoverScale: number
}

export const DEFAULT_RADIAL_MENU_STYLE: RadialMenuStyle = {
  itemSize: 44,
  gap: 6,
  innerRadius: 56,
  paddingX: 10,
  backdrop: [0.08, 0.09, 0.12, 0.92],
  backdropBorder: [0.6, 0.66, 0.78, 0.35],
  fill: [0.17, 0.19, 0.24, 0.96],
  hoverFill: [0.25, 0.47, 0.85, 1],
  border: [0.6, 0.66, 0.78, 0.6],
  borderWidth: 1,
  selectedBorder: [1, 1, 1, 1],
  selectedBorderWidth: 3,
  textColor: [1, 1, 1, 1],
  disabledTextColor: [1, 1, 1, 0.4],
  textSizePx: 13,
  hoverScale: 1.12,
}

/** One item's face, in canvas pixels. */
export interface RadialItemLayout {
  x: number
  y: number
  width: number
  height: number
}

/** The backdrop disc and the item faces (in `items` order), in canvas pixels. */
export interface RadialMenuLayout {
  cx: number
  cy: number
  radius: number
  items: RadialItemLayout[]
}

/** An area the menu must stay inside, in canvas pixels. */
export interface RadialMenuBounds {
  x: number
  y: number
  width: number
  height: number
}

export function resolveRadialMenuStyle(
  base: RadialMenuStyle,
  override?: Partial<RadialMenuStyle>,
): RadialMenuStyle {
  return override ? { ...base, ...override } : base
}

/** Scale every length in a style by `k` (CSS pixels to canvas pixels). */
export function scaleRadialMenuStyle(
  style: RadialMenuStyle,
  k: number,
): RadialMenuStyle {
  if (k === 1) return style
  return {
    ...style,
    itemSize: style.itemSize * k,
    gap: style.gap * k,
    innerRadius: style.innerRadius * k,
    paddingX: style.paddingX * k,
    borderWidth: style.borderWidth * k,
    selectedBorderWidth: style.selectedBorderWidth * k,
    textSizePx: style.textSizePx * k,
  }
}

/**
 * Each ring's items spaced evenly from 12 o'clock, clockwise, far enough out
 * that neighbours don't touch; the disc is pulled inside `bounds` so a menu
 * opened at an edge stays whole.
 */
export function layoutRadialMenu(
  items: readonly RadialMenuItem[],
  x: number,
  y: number,
  style: RadialMenuStyle,
  metrics: UIKitFontMetrics,
  bounds: RadialMenuBounds | null,
): RadialMenuLayout {
  const widths = items.map((item) =>
    item.color
      ? style.itemSize
      : Math.max(
          style.itemSize,
          Math.ceil(
            measureWidth(metrics, item.label, style.textSizePx) +
              2 * style.paddingX,
          ),
        ),
  )
  const rings = [...new Set(items.map((item) => item.ring ?? 0))].sort(
    (a, b) => a - b,
  )
  const ringRadius = new Map<number, number>()
  let radius = 0
  let previousExtent = 0
  for (const ring of rings) {
    const members = items.flatMap((item, i) =>
      (item.ring ?? 0) === ring ? [i] : [],
    )
    // A pill's reach from its centre in any direction is half its width.
    const extent = Math.max(...members.map((i) => widths[i]))
    const clearsPrevious =
      ringRadius.size === 0
        ? style.innerRadius
        : radius + (previousExtent + extent) / 2 + style.gap
    // Neighbours a chord apart: each face fits in a circle of its width.
    const fitsAround =
      members.length > 1
        ? (extent + style.gap) / (2 * Math.sin(Math.PI / members.length))
        : 0
    radius = Math.max(clearsPrevious, fitsAround)
    ringRadius.set(ring, radius)
    previousExtent = extent
  }
  const discRadius = radius + previousExtent / 2 + style.gap

  const clamp = (v: number, lo: number, size: number): number =>
    size <= 2 * discRadius
      ? lo + size / 2
      : Math.min(Math.max(v, lo + discRadius), lo + size - discRadius)
  const cx = bounds ? clamp(x, bounds.x, bounds.width) : x
  const cy = bounds ? clamp(y, bounds.y, bounds.height) : y

  const counts = new Map<number, number>()
  const seen = new Map<number, number>()
  for (const item of items) {
    const ring = item.ring ?? 0
    counts.set(ring, (counts.get(ring) ?? 0) + 1)
  }
  const faces = items.map((item, i) => {
    const ring = item.ring ?? 0
    const index = seen.get(ring) ?? 0
    seen.set(ring, index + 1)
    const angle =
      -Math.PI / 2 + (2 * Math.PI * index) / (counts.get(ring) as number)
    const r = ringRadius.get(ring) as number
    return {
      x: cx + r * Math.cos(angle) - widths[i] / 2,
      y: cy + r * Math.sin(angle) - style.itemSize / 2,
      width: widths[i],
      height: style.itemSize,
    }
  })
  return { cx, cy, radius: discRadius, items: faces }
}

/** The index of the enabled item under (x, y), or -1. */
export function radialItemAt(
  items: readonly RadialMenuItem[],
  layout: RadialMenuLayout,
  x: number,
  y: number,
): number {
  return layout.items.findIndex(
    (face, i) => items[i].enabled !== false && rectContains(face, x, y),
  )
}

/** True when (x, y) is on the backdrop disc. */
export function radialMenuContains(
  layout: RadialMenuLayout,
  x: number,
  y: number,
): boolean {
  return Math.hypot(x - layout.cx, y - layout.cy) <= layout.radius
}

/** The backdrop, then each item, the hovered one enlarged. */
export function buildRadialMenu(
  items: readonly RadialMenuItem[],
  style: RadialMenuStyle,
  metrics: UIKitFontMetrics,
  layout: RadialMenuLayout,
  hover: number,
): UIKitGeometry {
  const rects: RectData[] = [
    buildRect({
      x: layout.cx - layout.radius,
      y: layout.cy - layout.radius,
      width: 2 * layout.radius,
      height: 2 * layout.radius,
      radius: layout.radius,
      fill: style.backdrop,
      border: style.backdropBorder,
      borderWidth: style.borderWidth,
    }),
  ]
  const text: UIKitTextItem[] = []
  const baseline = (capHeight(metrics) * style.textSizePx) / 2
  items.forEach((item, i) => {
    const face = layout.items[i]
    const enabled = item.enabled !== false
    const k = i === hover && enabled ? style.hoverScale : 1
    const width = face.width * k
    const height = face.height * k
    const cx = face.x + face.width / 2
    const cy = face.y + face.height / 2
    let fill = item.color ?? (i === hover ? style.hoverFill : style.fill)
    if (!enabled) fill = mixColor(fill, style.backdrop, 0.6)
    rects.push(
      buildRect({
        x: cx - width / 2,
        y: cy - height / 2,
        width,
        height,
        radius: height / 2,
        fill,
        border: item.selected ? style.selectedBorder : style.border,
        borderWidth: item.selected
          ? style.selectedBorderWidth
          : style.borderWidth,
      }),
    )
    if (!item.color) {
      text.push({
        str: item.label,
        x: cx,
        y: cy + baseline * k,
        sizePx: style.textSizePx * k,
        align: 0.5,
        color: enabled ? style.textColor : style.disabledTextColor,
      })
    }
  })
  return { rects, lines: [], text }
}
