// Pure tool palette model for UIKit: a floating drawing toolbar after the
// iPad's own, with upright tools rising from a tray (the selected one raised)
// or flat shape keys (the selected one filled with the ink),
// color swatches, brush widths and action buttons such as Undo. Layout,
// hit-testing and draw geometry only; UIKitToolPaletteOverlay wires it up.

import { buildLine, type LineData } from './line'
import type { UIKitGeometry } from './overlayParts'
import { buildRect, type RectData, rectContains } from './rect'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { UIKitTextItem } from './textOverlay'

/**
 * How a tool is drawn: a fine pen, a broad marker, a wand or an eraser standing
 * up from the tray, or a flat key showing a shape.
 */
export type ToolLook =
  | 'pen'
  | 'marker'
  | 'wand'
  | 'eraser'
  | 'freehand'
  | 'rectangle'
  | 'ellipse'
  | 'arrow'
  | 'spline'
  | 'livewire'

export interface ToolPaletteTool {
  id: string
  /** The caption under the tool. */
  label: string
  look: ToolLook
}

export interface ToolPaletteColor {
  id: string
  label: string
  color: RGBA
}

export interface ToolPaletteWidth {
  id: string
  label: string
}

export interface ToolPaletteAction {
  id: string
  label: string
  /** Draw an icon in place of the label. */
  icon?: 'undo' | 'redo'
  /** Default true. */
  enabled?: boolean
}

export interface ToolPaletteSpec {
  /** The tray's top-left; tools rise above it. */
  x: number
  y: number
  /** Wider than this, whole sections wrap to new rows; tools stay on top. */
  maxWidth?: number
  actions?: readonly ToolPaletteAction[]
  tools: readonly ToolPaletteTool[]
  tool: string
  colors?: readonly ToolPaletteColor[]
  /** The selected color's id; its color inks the tools' tips. */
  color?: string
  /** Thinnest first. Empty hides them (a tool without a width). */
  widths?: readonly ToolPaletteWidth[]
  width?: string
}

/** Every visual knob. All lengths are in canvas pixels. */
export interface ToolPaletteStyle {
  /** One row of the tray. */
  rowHeight: number
  padding: number
  gap: number
  /** Space either side of a section divider. */
  sectionGap: number
  /** A tool's slot and barrel widths. */
  toolSlot: number
  toolWidth: number
  /** How far a tool stands above the tray, and the selected and hovered one's extra lift. */
  toolRise: number
  selectedLift: number
  hoverLift: number
  swatchSize: number
  /** The thinnest and broadest width dot. */
  minDot: number
  maxDot: number
  fill: RGBA
  border: RGBA
  borderWidth: number
  hoverFill: RGBA
  /** An unpicked shape key. */
  keyFill: RGBA
  barrel: RGBA
  barrelEdge: RGBA
  eraser: RGBA
  wand: RGBA
  /** The ring around the selected swatch. */
  selectedBorder: RGBA
  textColor: RGBA
  disabledTextColor: RGBA
  /** The tools' captions. */
  captionSizePx: number
  textSizePx: number
}

export const DEFAULT_TOOL_PALETTE_STYLE: ToolPaletteStyle = {
  rowHeight: 56,
  padding: 10,
  gap: 6,
  sectionGap: 10,
  toolSlot: 40,
  toolWidth: 22,
  toolRise: 14,
  selectedLift: 12,
  hoverLift: 5,
  swatchSize: 28,
  minDot: 5,
  maxDot: 18,
  fill: [0.13, 0.14, 0.17, 0.96],
  border: [0.6, 0.66, 0.78, 0.35],
  borderWidth: 1,
  hoverFill: [1, 1, 1, 0.12],
  keyFill: [1, 1, 1, 0.06],
  barrel: [0.94, 0.94, 0.96, 1],
  barrelEdge: [0.55, 0.57, 0.62, 1],
  eraser: [0.97, 0.87, 0.86, 1],
  wand: [0.32, 0.33, 0.38, 1],
  selectedBorder: [1, 1, 1, 1],
  textColor: [1, 1, 1, 0.92],
  disabledTextColor: [1, 1, 1, 0.35],
  captionSizePx: 10,
  textSizePx: 13,
}

export type ToolPaletteItemKind = 'action' | 'tool' | 'color' | 'width'

/** A pressable part: its kind, its index and id in that list, and its hit box. */
export interface ToolPaletteItem {
  kind: ToolPaletteItemKind
  index: number
  id: string
  enabled: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface ToolPaletteLayout {
  /** The tray. */
  x: number
  y: number
  width: number
  height: number
  items: ToolPaletteItem[]
  /** Section dividers, as x positions in their row. */
  dividers: { x: number; y: number }[]
}

/** Scale every length in a style by `k` (CSS pixels to canvas pixels). */
export function scaleToolPaletteStyle(
  style: ToolPaletteStyle,
  k: number,
): ToolPaletteStyle {
  if (k === 1) return style
  const scaled = { ...style }
  for (const key of [
    'rowHeight',
    'padding',
    'gap',
    'sectionGap',
    'toolSlot',
    'toolWidth',
    'toolRise',
    'selectedLift',
    'hoverLift',
    'swatchSize',
    'minDot',
    'maxDot',
    'borderWidth',
    'captionSizePx',
    'textSizePx',
  ] as const) {
    scaled[key] = style[key] * k
  }
  return scaled
}

// Shape tools are flat keys in the tray; the rest stand up out of it.
const KEY_LOOKS: ReadonlySet<ToolLook> = new Set([
  'freehand',
  'rectangle',
  'ellipse',
  'arrow',
  'spline',
  'livewire',
])

/** The highest a tool reaches above the tray (selected and hovered); 0 for keys only. */
export function toolPaletteReach(
  style: ToolPaletteStyle,
  tools: readonly ToolPaletteTool[],
): number {
  return tools.every(({ look }) => KEY_LOOKS.has(look))
    ? 0
    : style.toolRise + style.selectedLift + style.hoverLift
}

/**
 * Sections left to right (actions, tools, colors, widths), a section that
 * would pass `maxWidth` starting a new row. Scaled spec positions are the caller's.
 */
export function layoutToolPalette(
  spec: ToolPaletteSpec,
  x: number,
  y: number,
  maxWidth: number,
  style: ToolPaletteStyle,
  metrics: UIKitFontMetrics,
): ToolPaletteLayout {
  const square = style.rowHeight - 2 * style.padding
  const reach = toolPaletteReach(style, spec.tools)
  const actionWidth = (action: ToolPaletteAction): number =>
    action.icon
      ? square
      : Math.max(
          square,
          measureWidth(metrics, action.label, style.textSizePx) +
            2 * style.padding,
        )
  type Part = Pick<ToolPaletteItem, 'kind' | 'index' | 'id' | 'enabled'> & {
    width: number
  }
  const sections: Part[][] = [
    (spec.actions ?? []).map((action, index) => ({
      kind: 'action',
      index,
      id: action.id,
      enabled: action.enabled !== false,
      width: actionWidth(action),
    })),
    spec.tools.map(({ id }, index) => ({
      kind: 'tool',
      index,
      id,
      enabled: true,
      width: style.toolSlot,
    })),
    (spec.colors ?? []).map(({ id }, index) => ({
      kind: 'color',
      index,
      id,
      enabled: true,
      width: style.swatchSize * (32 / 28),
    })),
    (spec.widths ?? []).map(({ id }, index) => ({
      kind: 'width',
      index,
      id,
      enabled: true,
      width: style.maxDot * (30 / 18),
    })),
  ]
  const rowWidth = (row: Part[][]): number => {
    const items = row.flat()
    return (
      2 * style.padding +
      items.reduce((sum, part) => sum + part.width, 0) +
      (items.length - row.length) * style.gap +
      Math.max(0, row.length - 1) * (2 * style.sectionGap + style.borderWidth)
    )
  }
  // Whole sections wrap: one that doesn't fit starts the next row. Tools stay
  // on the first row, since they stand up over the row above: tools that don't
  // fit beside the actions take the first row alone, the actions below them.
  const rows: Part[][][] = [[]]
  for (const section of sections) {
    if (!section.length) continue
    const row = rows[rows.length - 1]
    if (!row.length || rowWidth([...row, section]) <= maxWidth)
      row.push(section)
    else if (section[0].kind === 'tool') rows.unshift([section])
    else rows.push([section])
  }
  const width = Math.max(...rows.map(rowWidth))

  const items: ToolPaletteItem[] = []
  const dividers: { x: number; y: number }[] = []
  rows.forEach((row, r) => {
    const rowY = y + r * style.rowHeight
    let cursor = x + style.padding
    row.forEach((section, s) => {
      if (s > 0) {
        cursor += style.sectionGap
        dividers.push({ x: cursor, y: rowY })
        cursor += style.borderWidth + style.sectionGap
      }
      section.forEach((part, i) => {
        if (i > 0) cursor += style.gap
        // An upright tool's hit box runs from its raised tip down through the
        // tray; a flat key's stays in the tray.
        const upright =
          part.kind === 'tool' && !KEY_LOOKS.has(spec.tools[part.index].look)
        const top = upright ? rowY - reach : rowY
        items.push({
          kind: part.kind,
          index: part.index,
          id: part.id,
          enabled: part.enabled,
          x: cursor,
          y: top,
          width: part.width,
          height: rowY + style.rowHeight - top,
        })
        cursor += part.width
      })
    })
  })
  return {
    x,
    y,
    width,
    height: rows.length * style.rowHeight,
    items,
    dividers,
  }
}

/** The enabled item under (x, y), or -1. */
export function toolPaletteItemAt(
  layout: ToolPaletteLayout,
  x: number,
  y: number,
): number {
  return layout.items.findIndex(
    (item) => item.enabled && rectContains(item, x, y),
  )
}

/** True over the tray or a tool standing above it. */
export function toolPaletteContains(
  layout: ToolPaletteLayout,
  x: number,
  y: number,
): boolean {
  return (
    rectContains(layout, x, y) ||
    layout.items.some(
      (item) => item.kind === 'tool' && rectContains(item, x, y),
    )
  )
}

/**
 * The tray, then the tools and their captions, swatches, width dots and
 * actions. `hover` is an item index or -1.
 */
export function buildToolPalette(
  spec: ToolPaletteSpec,
  style: ToolPaletteStyle,
  metrics: UIKitFontMetrics,
  layout: ToolPaletteLayout,
  hover: number,
): UIKitGeometry {
  const rects: RectData[] = []
  const lines: LineData[] = []
  const text: UIKitTextItem[] = []
  const ink =
    spec.colors?.find((color) => color.id === spec.color)?.color ??
    style.textColor
  const capOf = (size: number): number => (capHeight(metrics) * size) / 2

  rects.push(
    buildRect({
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
      radius: Math.min(style.rowHeight / 2, 22 * (style.rowHeight / 56)),
      fill: style.fill,
      border: style.border,
      borderWidth: style.borderWidth,
    }),
  )
  for (const divider of layout.dividers) {
    const inset = style.rowHeight * 0.25
    lines.push(
      buildLine(
        divider.x,
        divider.y + inset,
        divider.x,
        divider.y + style.rowHeight - inset,
        Math.max(1, style.borderWidth),
        style.border,
      ),
    )
  }

  // Tools stand just above their captions.
  const lip = style.rowHeight * 0.36
  const reach = toolPaletteReach(style, spec.tools)
  layout.items.forEach((item, i) => {
    if (item.kind !== 'tool') return
    const tool = spec.tools[item.index]
    const key = KEY_LOOKS.has(tool.look)
    const rowY = key ? item.y : item.y + reach
    const cx = item.x + item.width / 2
    if (key) {
      // The picked key fills with the ink; its shape turns dark on it.
      const picked = tool.id === spec.tool
      const keyTop = rowY + style.padding * 0.4
      const keyHeight = style.rowHeight - lip - style.padding * 0.4
      rects.push(
        buildRect({
          x: item.x + 1,
          y: keyTop,
          width: item.width - 2,
          height: keyHeight,
          radius: style.rowHeight * 0.14,
          fill: picked ? ink : i === hover ? style.hoverFill : style.keyFill,
        }),
      )
      shapeGlyph(
        rects,
        lines,
        tool.look,
        cx,
        keyTop + keyHeight / 2,
        Math.min(item.width, keyHeight) * 0.3,
        Math.max(1.5, style.rowHeight / 28),
        picked ? glyphOn(ink, style) : style.textColor,
      )
    } else {
      const lift =
        (tool.id === spec.tool ? style.selectedLift : 0) +
        (i === hover ? style.hoverLift : 0)
      buildTool(
        rects,
        lines,
        tool.look,
        cx,
        rowY - style.toolRise - lift,
        rowY + style.rowHeight - lip - style.rowHeight / 28,
        style,
        ink,
      )
    }
    text.push({
      str: tool.label,
      x: cx,
      y:
        rowY +
        style.rowHeight -
        lip / 2 -
        style.rowHeight / 28 +
        capOf(style.captionSizePx),
      sizePx: style.captionSizePx,
      align: 0.5,
      color: tool.id === spec.tool ? style.textColor : style.disabledTextColor,
    })
  })

  const widthCount = spec.widths?.length ?? 0
  layout.items.forEach((item, i) => {
    const cx = item.x + item.width / 2
    const cy = item.y + item.height / 2
    if (item.kind === 'color') {
      const color = spec.colors?.[item.index]
      if (!color) return
      const selected = color.id === spec.color
      const size = style.swatchSize * (i === hover ? 1.08 : 1)
      if (selected) {
        const ring = size * (36 / 28)
        rects.push(
          buildRect({
            x: cx - ring / 2,
            y: cy - ring / 2,
            width: ring,
            height: ring,
            radius: ring / 2,
            fill: [0, 0, 0, 0],
            border: style.selectedBorder,
            borderWidth: 2 * (style.swatchSize / 28),
          }),
        )
      }
      rects.push(
        buildRect({
          x: cx - size / 2,
          y: cy - size / 2,
          width: size,
          height: size,
          radius: size / 2,
          fill: color.color,
          border: style.border,
          borderWidth: style.borderWidth,
        }),
      )
    } else if (item.kind === 'width') {
      const width = spec.widths?.[item.index]
      if (!width) return
      const selected = width.id === spec.width
      if (selected || i === hover) {
        const back = style.maxDot * (28 / 18)
        rects.push(
          buildRect({
            x: cx - back / 2,
            y: cy - back / 2,
            width: back,
            height: back,
            radius: back / 2,
            fill: selected ? [1, 1, 1, 0.2] : style.hoverFill,
          }),
        )
      }
      const t = widthCount > 1 ? item.index / (widthCount - 1) : 1
      const dot = style.minDot + t * (style.maxDot - style.minDot)
      rects.push(
        buildRect({
          x: cx - dot / 2,
          y: cy - dot / 2,
          width: dot,
          height: dot,
          radius: dot / 2,
          fill: style.textColor,
        }),
      )
    } else if (item.kind === 'action') {
      const action = spec.actions?.[item.index]
      if (!action) return
      const enabled = action.enabled !== false
      const color = enabled ? style.textColor : style.disabledTextColor
      if (i === hover && enabled) {
        const side = style.rowHeight - 2 * style.padding
        rects.push(
          buildRect({
            x: item.x,
            y: cy - side / 2,
            width: item.width,
            height: side,
            radius: side / 2,
            fill: style.hoverFill,
          }),
        )
      }
      if (action.icon) {
        historyIcon(lines, cx, cy, style.rowHeight * 0.16, color, action.icon)
      } else {
        text.push({
          str: action.label,
          x: cx,
          y: cy + capOf(style.textSizePx),
          sizePx: style.textSizePx,
          align: 0.5,
          color,
        })
      }
    }
  })
  return { rects, lines, text }
}

// One upright tool from its tip at `top` down to `foot`.
function buildTool(
  rects: RectData[],
  lines: LineData[],
  look: ToolLook,
  cx: number,
  top: number,
  foot: number,
  style: ToolPaletteStyle,
  ink: RGBA,
): void {
  const w = style.toolWidth
  const u = w / 22
  const barrel = (y: number, fill: RGBA, radius: number): void => {
    rects.push(
      buildRect({
        x: cx - w / 2,
        y,
        width: w,
        height: foot - y,
        radius,
        fill,
        border: style.barrelEdge,
        borderWidth: style.borderWidth,
      }),
    )
  }
  const band = (y: number, fill: RGBA): void => {
    rects.push(buildRect({ x: cx - w / 2, y, width: w, height: 4 * u, fill }))
  }
  if (look === 'pen') {
    // A cone to a fine inked point.
    barrel(top + 14 * u, style.barrel, 3 * u)
    rects.push(
      buildRect({
        x: cx - 6 * u,
        y: top + 6 * u,
        width: 12 * u,
        height: 10 * u,
        radius: 2 * u,
        fill: style.barrelEdge,
      }),
      buildRect({
        x: cx - 2 * u,
        y: top,
        width: 4 * u,
        height: 8 * u,
        radius: 2 * u,
        fill: ink,
      }),
    )
    band(top + 22 * u, ink)
  } else if (look === 'marker') {
    // A broad, square inked nib.
    barrel(top + 10 * u, style.barrel, 3 * u)
    rects.push(
      buildRect({
        x: cx - 8 * u,
        y: top,
        width: 16 * u,
        height: 12 * u,
        radius: 2 * u,
        fill: ink,
        border: style.barrelEdge,
        borderWidth: style.borderWidth,
      }),
    )
    band(top + 20 * u, ink)
  } else if (look === 'wand') {
    // A slim rod under an inked spark.
    rects.push(
      buildRect({
        x: cx - 4 * u,
        y: top + 12 * u,
        width: 8 * u,
        height: foot - top - 12 * u,
        radius: 2 * u,
        fill: style.wand,
      }),
    )
    const cy = top + 6 * u
    const r = 7 * u
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 4
      const dx = Math.cos(a) * (k % 2 ? r * 0.7 : r)
      const dy = Math.sin(a) * (k % 2 ? r * 0.7 : r)
      lines.push(buildLine(cx - dx, cy - dy, cx + dx, cy + dy, 2 * u, ink))
    }
  } else {
    // Eraser: a soft block, rounded at the end that erases.
    barrel(top, style.eraser, 8 * u)
    band(top + 16 * u, style.barrelEdge)
  }
}

// WCAG relative luminance of an sRGB color.
function luminance([r, g, b]: RGBA): number {
  const lin = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** The tray fill or the text color, whichever stands out more on `ink`, opaque. */
export function glyphOn(ink: RGBA, style: ToolPaletteStyle): RGBA {
  // A translucent ink shows the tray through it.
  const over = (k: number): number =>
    ink[k] * ink[3] + style.fill[k] * (1 - ink[3])
  const seen: RGBA = [over(0), over(1), over(2), 1]
  const contrast = (c: RGBA): number => {
    const [a, b] = [luminance(seen), luminance(c)]
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  const [r, g, b] =
    contrast(style.fill) >= contrast(style.textColor)
      ? style.fill
      : style.textColor
  return [r, g, b, 1]
}

// A shape about 2r across centred on (cx, cy), stroked `t` thick.
function shapeGlyph(
  rects: RectData[],
  lines: LineData[],
  look: ToolLook,
  cx: number,
  cy: number,
  r: number,
  t: number,
  ink: RGBA,
): void {
  const path = (points: [number, number][]): void => {
    for (let k = 1; k < points.length; k++) {
      const [a, b] = [points[k - 1], points[k]]
      lines.push(buildLine(a[0], a[1], b[0], b[1], t, ink))
    }
  }
  const dot = (x: number, y: number): void => {
    rects.push(
      buildRect({
        x: x - t,
        y: y - t,
        width: 2 * t,
        height: 2 * t,
        radius: t,
        fill: ink,
      }),
    )
  }
  const sample = (
    f: (s: number) => [number, number],
    steps = 12,
  ): [number, number][] =>
    Array.from({ length: steps + 1 }, (_, k) => f(k / steps))
  const outline = (h: number, radius: number): void => {
    rects.push(
      buildRect({
        x: cx - r,
        y: cy - h,
        width: 2 * r,
        height: 2 * h,
        radius,
        fill: [0, 0, 0, 0],
        border: ink,
        borderWidth: t,
      }),
    )
  }
  if (look === 'rectangle') {
    outline(r * 0.7, t / 2)
  } else if (look === 'ellipse') {
    // A rounded rect wider than tall would be a capsule: trace the curve.
    path(
      sample(
        (s) => [
          cx + r * Math.cos(2 * Math.PI * s),
          cy + r * 0.7 * Math.sin(2 * Math.PI * s),
        ],
        24,
      ),
    )
  } else if (look === 'arrow') {
    const [tx, ty] = [cx + r, cy - r]
    path([
      [cx - r, cy + r],
      [tx, ty],
    ])
    path([
      [tx - r * 0.8, ty],
      [tx, ty],
      [tx, ty + r * 0.8],
    ])
  } else if (look === 'freehand') {
    // A loose scribble.
    path(
      sample((s) => [
        cx - r + 2 * r * s,
        cy + r * 0.55 * Math.sin(s * 3.5 * Math.PI),
      ]),
    )
  } else if (look === 'spline') {
    // One smooth S through two control points.
    path(
      sample((s) => [cx - r + 2 * r * s, cy + r * 0.6 * Math.cos(s * Math.PI)]),
    )
    dot(cx - r, cy + r * 0.6)
    dot(cx + r, cy - r * 0.6)
  } else {
    // Livewire: a jagged edge-hugging trace between seed points.
    const points: [number, number][] = [
      [cx - r, cy + r * 0.5],
      [cx - r * 0.4, cy - r * 0.4],
      [cx + r * 0.1, cy + r * 0.2],
      [cx + r * 0.5, cy - r * 0.6],
      [cx + r, cy - r * 0.1],
    ]
    path(points)
    dot(...points[0])
    dot(...points[4])
  }
}

// Undo: a counter-clockwise hook ending in an arrowhead, about `r` across;
// redo mirrors it.
function historyIcon(
  lines: LineData[],
  cx: number,
  cy: number,
  r: number,
  color: RGBA,
  icon: 'undo' | 'redo',
): void {
  const from = lines.length
  const thickness = Math.max(1.5, r / 4.5)
  const steps = 8
  // From the right, round the top and down the left: a half turn.
  let px = cx + r
  let py = cy + r * 0.3
  for (let k = 1; k <= steps; k++) {
    const a = (k / steps) * Math.PI
    const nx = cx + r * Math.cos(a)
    const ny = cy + r * 0.3 - r * Math.sin(a)
    lines.push(buildLine(px, py, nx, ny, thickness, color))
    px = nx
    py = ny
  }
  const head = r * 0.55
  lines.push(
    buildLine(px, py, px - head * 0.6, py - head * 0.8, thickness, color),
    buildLine(px, py, px + head * 0.8, py - head * 0.5, thickness, color),
  )
  if (icon === 'redo') {
    for (const { data } of lines.slice(from)) {
      data[0] = 2 * cx - data[0]
      data[2] = 2 * cx - data[2]
    }
  }
}
