// Pure file picker model for UIKit: the canvas half of `<input type="file">`.
// A picker is a push button ("Choose file...") beside a readout of what was
// chosen ("No file chosen", one name, or "3 files"). The button is laid out
// and drawn by a button overlay; this module sizes the row, places the
// readout and trims a long name to the space left. The chooser itself is a
// host bridge (see host.ts), so nothing here touches the DOM.

import {
  type ButtonLayout,
  type ButtonStyle,
  DEFAULT_BUTTON_STYLE,
  layoutButton,
  resolveButtonStyle,
} from './button'
import type { UIKitFontMetrics } from './text/font'
import {
  autoOutlineColor,
  capHeight,
  measureWidth,
  type RGBA,
} from './text/layout'
import type { UIKitTextItem } from './textOverlay'

/** Every visual knob on a file picker. All lengths are in canvas pixels. */
export interface FilePickerStyle {
  /** Overrides for the "Choose file" button. */
  button: Partial<ButtonStyle>
  /** Space between the button and the readout. */
  gap: number
  /** Readout color once something was chosen. */
  textColor: RGBA
  /** Readout color while nothing is chosen (the placeholder). */
  emptyTextColor: RGBA
  disabledTextColor: RGBA
  /** Readout em size. */
  textSizePx: number
  /** Halo outline width around the readout (it sits on the scene); 0 draws none. */
  textOutlineWidth: number
  /** Halo color; null picks black or white against the readout color. */
  textOutlineColor: RGBA | null
  /** Readout width when the spec gives no width. */
  readoutWidth: number
}

export const DEFAULT_FILE_PICKER_STYLE: FilePickerStyle = {
  button: {},
  gap: 10,
  textColor: [0.92, 0.92, 0.95, 1],
  emptyTextColor: [0.65, 0.65, 0.7, 1],
  disabledTextColor: [0.5, 0.5, 0.55, 1],
  textSizePx: 14,
  textOutlineWidth: 1,
  textOutlineColor: null,
  readoutWidth: 160,
}

export interface FilePickerSpec {
  /** Stable key: the handle for updates and the callbacks. */
  id: string
  /** Button label. Default "Choose file...". */
  label?: string
  /** Top-left corner of the row, in canvas pixels. */
  x: number
  y: number
  /** Width of the whole row; the readout gets what the button leaves. */
  width?: number
  /** Readout while nothing is chosen. Default "No file chosen". */
  placeholder?: string
  /** `accept` for the host chooser: ".nii,.nii.gz" or MIME types. */
  accept?: string
  multiple?: boolean
  /** Choose a directory (every file inside it) instead of files. */
  directory?: boolean
  /** A disabled picker draws dimmed and ignores the pointer. Default true. */
  enabled?: boolean
  /** Per-picker overrides of the overlay's default style. */
  style?: Partial<FilePickerStyle>
  /** Fired with the chosen files once the chooser closes with a choice. */
  onPick?: (files: File[], id: string) => void
  /** Fired when the chooser closes without a choice. */
  onCancel?: (id: string) => void
}

export const DEFAULT_FILE_PICKER_LABEL = 'Choose file...'
export const DEFAULT_FILE_PICKER_PLACEHOLDER = 'No file chosen'

/** The resting boxes of a picker, in canvas pixels. */
export interface FilePickerLayout {
  x: number
  y: number
  width: number
  height: number
  button: ButtonLayout
  /** Left edge and baseline of the readout. */
  textX: number
  baseline: number
  /** Space available to the readout. */
  readoutWidth: number
}

export interface FilePickerVisual {
  /** Names of the chosen files; empty shows the placeholder. */
  names: readonly string[]
  enabled: boolean
}

export function resolveFilePickerStyle(
  base: FilePickerStyle,
  override?: Partial<FilePickerStyle>,
): FilePickerStyle {
  if (!override) return base
  return {
    ...base,
    ...override,
    button: { ...base.button, ...override.button },
  }
}

/** The button style a picker's button is laid out and drawn with. */
export function filePickerButtonStyle(style: FilePickerStyle): ButtonStyle {
  return resolveButtonStyle(DEFAULT_BUTTON_STYLE, style.button)
}

/** What the readout says for a set of chosen names. */
export function filePickerSummary(
  names: readonly string[],
  placeholder = DEFAULT_FILE_PICKER_PLACEHOLDER,
): string {
  if (names.length === 0) return placeholder
  if (names.length === 1) return names[0]
  return `${names.length} files`
}

/**
 * Trim a string to `maxWidth` at `sizePx`, keeping its tail (a file's
 * extension is the informative end) behind a leading "...".
 */
export function ellipsizeStart(
  metrics: UIKitFontMetrics,
  str: string,
  sizePx: number,
  maxWidth: number,
): string {
  if (measureWidth(metrics, str, sizePx) <= maxWidth) return str
  const dots = '...'
  const room = maxWidth - measureWidth(metrics, dots, sizePx)
  if (room < 0) return ''
  const chars = [...str]
  let start = chars.length
  let width = 0
  while (start > 0) {
    const w = measureWidth(metrics, chars[start - 1], sizePx)
    if (width + w > room) break
    width += w
    start--
  }
  if (start === chars.length) return dots
  return dots + chars.slice(start).join('')
}

export function layoutFilePicker(
  spec: FilePickerSpec,
  style: FilePickerStyle,
  metrics: UIKitFontMetrics,
): FilePickerLayout {
  const button = layoutButton(
    {
      id: spec.id,
      label: spec.label ?? DEFAULT_FILE_PICKER_LABEL,
      x: spec.x,
      y: spec.y,
    },
    filePickerButtonStyle(style),
    metrics,
  )
  const textX = button.x + button.width + style.gap
  const width = spec.width ?? button.width + style.gap + style.readoutWidth
  const readoutWidth = Math.max(0, spec.x + width - textX)
  const cap = capHeight(metrics) * style.textSizePx
  return {
    x: spec.x,
    y: spec.y,
    width,
    height: button.height,
    button,
    textX,
    baseline: button.y + button.height / 2 + cap / 2,
    readoutWidth,
  }
}

/**
 * Scale a spec and style by `k` (CSS to device pixels). The button overrides
 * come back as a full button style, so a layout of the result agrees with a
 * button overlay scaling the same picker.
 */
export function scaleFilePicker(
  spec: FilePickerSpec,
  style: FilePickerStyle,
  k: number,
): { spec: FilePickerSpec; style: FilePickerStyle } {
  if (k === 1) return { spec, style }
  const base = filePickerButtonStyle(style)
  const button: ButtonStyle = {
    ...base,
    textSizePx: base.textSizePx * k,
    paddingX: base.paddingX * k,
    paddingY: base.paddingY * k,
    radius: base.radius * k,
    borderWidth: base.borderWidth * k,
  }
  return {
    spec: {
      ...spec,
      x: spec.x * k,
      y: spec.y * k,
      width: spec.width === undefined ? undefined : spec.width * k,
    },
    style: {
      ...style,
      button,
      gap: style.gap * k,
      textSizePx: style.textSizePx * k,
      textOutlineWidth: style.textOutlineWidth * k,
      readoutWidth: style.readoutWidth * k,
    },
  }
}

/** The readout text of a picker; its button is drawn by a button overlay. */
export function buildFilePicker(
  spec: FilePickerSpec,
  style: FilePickerStyle,
  layout: FilePickerLayout,
  metrics: UIKitFontMetrics,
  visual: FilePickerVisual,
): { text: UIKitTextItem[] } {
  const summary = filePickerSummary(visual.names, spec.placeholder)
  const str = ellipsizeStart(
    metrics,
    summary,
    style.textSizePx,
    layout.readoutWidth,
  )
  if (str === '') return { text: [] }
  const color = !visual.enabled
    ? style.disabledTextColor
    : visual.names.length === 0
      ? style.emptyTextColor
      : style.textColor
  const outline =
    style.textOutlineWidth > 0
      ? {
          outlineWidthPx: style.textOutlineWidth,
          outlineColor: style.textOutlineColor ?? autoOutlineColor(color),
        }
      : {}
  return {
    text: [
      {
        str,
        x: layout.textX,
        y: layout.baseline,
        sizePx: style.textSizePx,
        align: 0,
        color,
        ...outline,
      },
    ],
  }
}
