// Pure dialog model for UIKit: style resolution, word wrapping, the layout of
// a panel (title, message, a content box for hosted widgets, a row of action
// buttons) centered in the canvas or placed at a point, and the geometry for
// its scrim, panel and text. No GPU and no DOM here; UIKitDialogOverlay wires
// it to the pointer, the keyboard and the draw hook, and draws the buttons
// through a button overlay.

import type { ButtonStyle } from './button'
import { buildRect, type RectData } from './rect'
import type { UIKitBox } from './scroll'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { UIKitTextItem } from './textOverlay'

/** Every visual knob on a dialog. All lengths are in canvas pixels. */
export interface DialogStyle {
  /** Color laid over the whole canvas behind the panel. */
  scrim: RGBA
  fill: RGBA
  border: RGBA
  borderWidth: number
  radius: number
  /** Panel width when the spec gives none. */
  width: number
  /** Space between the panel edge and its contents. */
  padding: number
  /** Vertical space between the title, message, content box and buttons. */
  gap: number
  titleColor: RGBA
  titleSizePx: number
  textColor: RGBA
  textSizePx: number
  /** Message line height as a multiple of `textSizePx`. */
  lineHeight: number
  /** Space between action buttons. */
  buttonGap: number
  /** Style overrides for the action buttons. */
  button: Partial<ButtonStyle>
  /** Further overrides for the button with the `default` role. */
  defaultButton: Partial<ButtonStyle>
}

export const DEFAULT_DIALOG_STYLE: DialogStyle = {
  scrim: [0, 0, 0, 0.45],
  fill: [0.12, 0.13, 0.17, 0.98],
  border: [0.6, 0.66, 0.78, 1],
  borderWidth: 1,
  radius: 8,
  width: 360,
  padding: 18,
  gap: 12,
  titleColor: [1, 1, 1, 1],
  titleSizePx: 18,
  textColor: [1, 1, 1, 0.88],
  textSizePx: 14,
  lineHeight: 1.45,
  buttonGap: 8,
  button: {},
  defaultButton: {
    fill: [0.25, 0.47, 0.85, 1],
    hoverFill: [0.32, 0.54, 0.92, 1],
    border: [0.55, 0.7, 1, 1],
  },
}

export type DialogButtonRole = 'default' | 'cancel' | 'normal'

export interface DialogButtonSpec {
  /** The result `onClose` reports when this button closes the dialog. */
  id: string
  label: string
  /**
   * `default` is what Enter presses (drawn in the accent style); `cancel` is
   * what Escape presses. Default `normal`.
   */
  role?: DialogButtonRole
  enabled?: boolean
}

/** The panel's boxes the host needs to place widgets, in spec units. */
export interface DialogBoxes {
  panel: UIKitBox
  /** The space reserved by `contentHeight`, between the message and the buttons. */
  content: UIKitBox
}

export interface DialogSpec {
  /** Stable key: the handle for opening, closing and the callbacks. */
  id: string
  title?: string
  /** Body text; wrapped to the panel width, with '\n' forcing a line break. */
  message?: string
  /** Top-left corner of the panel. Omit both to center it in the canvas. */
  x?: number
  y?: number
  /** Panel width. Default: the style's `width`. */
  width?: number
  /** Height reserved for hosted widgets between the message and the buttons. */
  contentHeight?: number
  /** Action buttons, drawn right-aligned in the order given. */
  buttons?: readonly DialogButtonSpec[]
  /** A press on the scrim closes the dialog with a null result. Default false. */
  closeOnScrim?: boolean
  /** Per-dialog overrides of the overlay's default style. */
  style?: Partial<DialogStyle>
  /**
   * Fired when the panel is placed or moves (first draw, a canvas resize),
   * with its boxes in spec units: position hosted widgets here.
   */
  onLayout?: (boxes: DialogBoxes, id: string) => void
  /** Fired when the dialog closes: the button id, or null for Escape and the scrim. */
  onClose?: (result: string | null, id: string) => void
}

/** The dialog's boxes in canvas pixels. */
export interface DialogLayout {
  panel: UIKitBox
  /** Title baseline, or null without a title. */
  title: { x: number; y: number } | null
  /** Wrapped message lines with their baselines. */
  lines: { str: string; x: number; y: number }[]
  content: UIKitBox
  /** Resting boxes for the action buttons, right-aligned. */
  buttons: { id: string; box: UIKitBox }[]
}

/** What `layoutDialog` needs to know about each button: its resting size. */
export interface DialogButtonSize {
  id: string
  width: number
  height: number
}

export function resolveDialogStyle(
  base: DialogStyle,
  override?: Partial<DialogStyle>,
): DialogStyle {
  return override ? { ...base, ...override } : base
}

/**
 * Break `text` into lines no wider than `maxWidth`: at '\n', else at the last
 * space that fits; a single word wider than the line stays whole.
 */
export function wrapText(
  metrics: UIKitFontMetrics,
  text: string,
  sizePx: number,
  maxWidth: number,
): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ')
    let line = ''
    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`
      if (line !== '' && measureWidth(metrics, candidate, sizePx) > maxWidth) {
        out.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    out.push(line)
  }
  return out
}

/**
 * The panel's boxes for a spec, centered in `bounds` unless the spec gives a
 * position. `buttonSizes` are the action buttons' resting sizes in order.
 */
export function layoutDialog(
  spec: DialogSpec,
  style: DialogStyle,
  metrics: UIKitFontMetrics,
  buttonSizes: readonly DialogButtonSize[],
  bounds: { width: number; height: number },
): DialogLayout {
  const width = spec.width ?? style.width
  const inner = Math.max(0, width - 2 * style.padding)
  const titleCap = capHeight(metrics) * style.titleSizePx
  const textCap = capHeight(metrics) * style.textSizePx
  const lineH = style.textSizePx * style.lineHeight
  const lines = spec.message
    ? wrapText(metrics, spec.message, style.textSizePx, inner)
    : []
  const buttonH = buttonSizes.reduce((h, b) => Math.max(h, b.height), 0)
  const contentH = spec.contentHeight ?? 0

  // Stack the parts top to bottom, a gap between each present pair.
  let height = style.padding
  const titleTop = height
  if (spec.title) height += titleCap + style.gap
  const linesTop = height
  if (lines.length > 0) height += lines.length * lineH + style.gap
  const contentTop = height
  if (contentH > 0) height += contentH + style.gap
  if (buttonSizes.length > 0) height += buttonH
  else height -= style.gap
  height += style.padding
  height = Math.ceil(Math.max(height, 2 * style.padding))

  const x =
    spec.x !== undefined && spec.y !== undefined
      ? spec.x
      : Math.round((bounds.width - width) / 2)
  const y =
    spec.x !== undefined && spec.y !== undefined
      ? spec.y
      : Math.round((bounds.height - height) / 2)
  const left = x + style.padding

  // The button row hugs the panel bottom, so the ceil above never leaves a gap.
  const buttons: { id: string; box: UIKitBox }[] = []
  const rowTop = buttonSizes.length > 0 ? height - style.padding - buttonH : 0
  let right = x + width - style.padding
  for (let i = buttonSizes.length - 1; i >= 0; i--) {
    const b = buttonSizes[i]
    right -= b.width
    buttons.unshift({
      id: b.id,
      box: {
        x: right,
        y: y + rowTop + (buttonH - b.height) / 2,
        width: b.width,
        height: b.height,
      },
    })
    right -= style.buttonGap
  }

  return {
    panel: { x, y, width, height },
    title: spec.title ? { x: left, y: y + titleTop + titleCap } : null,
    lines: lines.map((str, i) => ({
      str,
      x: left,
      y: y + linesTop + i * lineH + textCap + (lineH - textCap) / 2,
    })),
    content: { x: left, y: y + contentTop, width: inner, height: contentH },
    buttons,
  }
}

/** Scale every length in a spec and style by `k` (CSS pixels to canvas pixels). */
export function scaleDialog(
  spec: DialogSpec,
  style: DialogStyle,
  k: number,
): { spec: DialogSpec; style: DialogStyle } {
  if (k === 1) return { spec, style }
  return {
    spec: {
      ...spec,
      x: spec.x === undefined ? undefined : spec.x * k,
      y: spec.y === undefined ? undefined : spec.y * k,
      width: spec.width === undefined ? undefined : spec.width * k,
      contentHeight:
        spec.contentHeight === undefined ? undefined : spec.contentHeight * k,
    },
    style: {
      ...style,
      borderWidth: style.borderWidth * k,
      radius: style.radius * k,
      width: style.width * k,
      padding: style.padding * k,
      gap: style.gap * k,
      titleSizePx: style.titleSizePx * k,
      textSizePx: style.textSizePx * k,
      buttonGap: style.buttonGap * k,
    },
  }
}

/** True when canvas point (px, py) lies inside the panel. */
export function dialogContains(
  layout: DialogLayout,
  px: number,
  py: number,
): boolean {
  const b = layout.panel
  return px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height
}

/**
 * The draw data for an open dialog: the scrim over `bounds`, the panel, the
 * title and the message lines. The action buttons are a button overlay's.
 */
export function buildDialog(
  spec: DialogSpec,
  style: DialogStyle,
  layout: DialogLayout,
  bounds: { width: number; height: number },
): { rects: RectData[]; text: UIKitTextItem[] } {
  const rects: RectData[] = [
    buildRect({
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height,
      fill: style.scrim,
    }),
    buildRect({
      ...layout.panel,
      radius: style.radius,
      borderWidth: style.borderWidth,
      fill: style.fill,
      border: style.border,
    }),
  ]
  const text: UIKitTextItem[] = []
  if (layout.title && spec.title) {
    text.push({
      str: spec.title,
      x: layout.title.x,
      y: layout.title.y,
      sizePx: style.titleSizePx,
      align: 0,
      color: style.titleColor,
    })
  }
  for (const line of layout.lines) {
    if (line.str === '') continue
    text.push({
      str: line.str,
      x: line.x,
      y: line.y,
      sizePx: style.textSizePx,
      align: 0,
      color: style.textColor,
    })
  }
  return { rects, text }
}
