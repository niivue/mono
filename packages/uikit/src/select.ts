// Pure select (drop-down list) model for UIKit. A select is a menu button whose
// label is the chosen option and whose popup lists every option as an
// exclusive radio group, so this file only maps a `SelectSpec` onto the menu
// model (see menu.ts for layout and geometry) and holds the value arithmetic:
// the shown label, the button width that fits every option, and stepping the
// value with the keyboard. No GPU and no DOM here; UIKitSelectOverlay wires it
// to the pointer, the keyboard and the overlay draw hook.

import type { ButtonStyle } from './button'
import type { MenuButtonSpec, MenuItemSpec, MenuStyle } from './menu'
import type { UIKitFontMetrics } from './text/font'
import { measureWidth } from './text/layout'

export interface SelectOption {
  /** The value reported to `onChange` and held by the select. Unique per select. */
  value: string
  label: string
  /** A disabled option draws dimmed and cannot be chosen. Default true. */
  enabled?: boolean
}

export interface SelectSpec {
  /** Stable key: the handle for updates, open state and the callback. */
  id: string
  /** Top-left corner of the button, in canvas pixels. */
  x: number
  y: number
  /**
   * Fixed button size. Width defaults to the widest option label (and the
   * placeholder) so the button keeps its size as the value changes; height
   * defaults to the label plus padding.
   */
  width?: number
  height?: number
  options: readonly SelectOption[]
  /** The chosen option's value, or null for none (the placeholder shows). */
  value: string | null
  /** Shown while nothing is chosen. Default ''. */
  placeholder?: string
  /** A disabled select draws dimmed and ignores input. Default true. */
  enabled?: boolean
  /** Per-select overrides of the overlay's default button style. */
  buttonStyle?: Partial<ButtonStyle>
  /** Per-select overrides of the overlay's default popup style. */
  style?: Partial<MenuStyle>
  /** Fired when the user chooses a different option (pointer or keyboard), not by `setValue`. */
  onChange?: (value: string, id: string) => void
}

/** The radio group every select's options share in the menu model. */
export const SELECT_GROUP = 'select'

/** The option holding `value`, if any. */
export function selectOption(
  options: readonly SelectOption[],
  value: string | null,
): SelectOption | null {
  if (value === null) return null
  return options.find((o) => o.value === value) ?? null
}

/** The text the button shows: the chosen option's label, else the placeholder. */
export function selectLabel(spec: SelectSpec): string {
  return selectOption(spec.options, spec.value)?.label ?? spec.placeholder ?? ''
}

/**
 * The button width that fits the widest option label and the placeholder,
 * plus padding and the chevron. Used when the spec fixes no width.
 */
export function selectWidth(
  spec: SelectSpec,
  buttonStyle: ButtonStyle,
  style: MenuStyle,
  metrics: UIKitFontMetrics,
): number {
  const size = buttonStyle.textSizePx
  let labelW = measureWidth(metrics, spec.placeholder ?? '', size)
  for (const o of spec.options) {
    labelW = Math.max(labelW, measureWidth(metrics, o.label, size))
  }
  return Math.ceil(
    labelW + 2 * buttonStyle.paddingX + style.chevronGap + style.chevronSize,
  )
}

/** The options as menu items: one radio group with the chosen option checked. */
export function selectItems(spec: SelectSpec): MenuItemSpec[] {
  return spec.options.map((o) => ({
    id: o.value,
    label: o.label,
    kind: 'radio',
    group: SELECT_GROUP,
    checked: o.value === spec.value,
    enabled: o.enabled,
  }))
}

/**
 * The `MenuButtonSpec` a select draws and behaves as. Callbacks are left off:
 * the select overlay reports value changes through its own `onChange`.
 */
export function selectMenuSpec(
  spec: SelectSpec,
  buttonStyle: ButtonStyle,
  style: MenuStyle,
  metrics: UIKitFontMetrics,
): MenuButtonSpec {
  return {
    id: spec.id,
    label: selectLabel(spec),
    x: spec.x,
    y: spec.y,
    width: spec.width ?? selectWidth(spec, buttonStyle, style, metrics),
    height: spec.height,
    items: selectItems(spec),
    enabled: spec.enabled,
    buttonStyle: spec.buttonStyle,
    style: spec.style,
  }
}

/** The index of the option holding `value`, or -1. */
export function selectIndex(
  options: readonly SelectOption[],
  value: string | null,
): number {
  return value === null ? -1 : options.findIndex((o) => o.value === value)
}

/**
 * The value `count` enabled options away from the current one in `direction`
 * without wrapping (the ends stop), like a closed native select on arrow keys.
 * From no value, the first step lands on the first (or last) enabled option.
 * Returns the current value when nothing lies that way.
 */
export function stepSelectValue(
  options: readonly SelectOption[],
  value: string | null,
  direction: 1 | -1,
  count = 1,
): string | null {
  const enabled = options.filter((o) => o.enabled !== false)
  if (enabled.length === 0) return value
  const at = value === null ? -1 : enabled.findIndex((o) => o.value === value)
  let next: number
  if (at < 0) {
    next = direction > 0 ? 0 : enabled.length - 1
  } else {
    next = Math.max(0, Math.min(enabled.length - 1, at + direction * count))
  }
  return enabled[next].value
}

/** The first or last enabled option's value, or the current one when there is none. */
export function endSelectValue(
  options: readonly SelectOption[],
  value: string | null,
  end: 'first' | 'last',
): string | null {
  const enabled = options.filter((o) => o.enabled !== false)
  if (enabled.length === 0) return value
  return enabled[end === 'first' ? 0 : enabled.length - 1].value
}
