// A UIKit overlay of selects (drop-down lists) drawn into the scene through the
// niivue overlay hook. Each select is a menu button showing the chosen option
// whose popup lists every option; the pointer and popup behaviour (open on
// press, highlight under the pointer, release or Enter to choose, outside
// press or Escape to dismiss, modal while open) comes from a private
// UIKitMenuOverlay. On top of that a focused closed select changes its value
// straight from the keyboard: ArrowUp/Down step through the enabled options,
// Home and End jump to the ends, and Enter, Space or Alt+ArrowDown open the
// list on the current option.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import type { ButtonLayout, ButtonStyle } from './button'
import { resolveButtonStyle } from './button'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import {
  DEFAULT_MENU_BUTTON_STYLE,
  DEFAULT_MENU_STYLE,
  type MenuBounds,
  type MenuPopupLayout,
  type MenuStyle,
  resolveMenuStyle,
} from './menu'
import { UIKitMenuOverlay } from './menuOverlay'
import {
  endSelectValue,
  type SelectOption,
  type SelectSpec,
  selectIndex,
  selectMenuSpec,
  selectOption,
  stepSelectValue,
} from './select'
import type { UIKitFont } from './text/font'

export interface UIKitSelectOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default button style for every select; a spec's `buttonStyle` overrides per key. */
  buttonStyle?: Partial<ButtonStyle>
  /** Default popup style for every select; a spec's `style` overrides per key. */
  style?: Partial<MenuStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
}

interface SelectEntry {
  spec: SelectSpec
  value: string | null
}

export class UIKitSelectOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  readonly hoverCursor = 'pointer'
  private readonly font: UIKitFont
  private readonly menu: UIKitMenuOverlay
  private readonly entries = new Map<string, SelectEntry>()
  private readonly baseButtonStyle: ButtonStyle
  private readonly baseStyle: MenuStyle

  constructor(font: UIKitFont, options: UIKitSelectOverlayOptions = {}) {
    this.font = font
    this.baseButtonStyle = resolveButtonStyle(
      DEFAULT_MENU_BUTTON_STYLE,
      options.buttonStyle,
    )
    this.baseStyle = resolveMenuStyle(DEFAULT_MENU_STYLE, options.style)
    this.menu = new UIKitMenuOverlay(font, options)
  }

  /**
   * Add a select, or replace the one with the same id. A replacement takes the
   * new spec's value; an open replaced select closes.
   */
  addSelect(spec: SelectSpec): void {
    const value = selectOption(spec.options, spec.value) ? spec.value : null
    const entry = this.entries.get(spec.id)
    if (entry) {
      entry.spec = spec
      entry.value = value
    } else {
      this.entries.set(spec.id, { spec, value })
    }
    this.sync(spec.id)
  }

  /** Replace the whole select set. */
  setSelects(specs: readonly SelectSpec[]): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) this.removeSelect(id)
    }
    for (const spec of specs) this.addSelect(spec)
  }

  removeSelect(id: string): void {
    if (!this.entries.delete(id)) return
    this.menu.removeMenu(id)
  }

  /** Patch one select's spec. The value is kept unless the patch sets `value`. */
  updateSelect(id: string, patch: Partial<Omit<SelectSpec, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const value = 'value' in patch ? (patch.value ?? null) : entry.value
    this.addSelect({ ...entry.spec, ...patch, id, value })
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateSelect(id, { enabled })
  }

  /** Replace a select's options (closing it if open). A value no longer offered clears. */
  setOptions(id: string, options: readonly SelectOption[]): void {
    this.updateSelect(id, { options })
  }

  getOptions(id: string): readonly SelectOption[] {
    return this.entries.get(id)?.spec.options ?? []
  }

  /** Set a select's value from code. Does not fire `onChange`. Unknown values clear it. */
  setValue(id: string, value: string | null): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const next = selectOption(entry.spec.options, value) ? value : null
    if (next === entry.value) return
    entry.value = next
    this.sync(id)
  }

  getValue(id: string): string | null {
    return this.entries.get(id)?.value ?? null
  }

  /** The ids of all selects, in draw order. */
  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /** A select button's box in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): ButtonLayout | null {
    return this.menu.getLayout(id)
  }

  /** The open list's panel and rows in spec units, or null when none is open. */
  getPopupLayout(): MenuPopupLayout | null {
    return this.menu.getPopupLayout()
  }

  /** The id of the select whose list is open, if any. */
  get openSelect(): string | null {
    return this.menu.openMenu
  }

  isOpen(id: string): boolean {
    return this.menu.isOpen(id)
  }

  /** The index of the highlighted option in the open list, or -1. */
  get highlightedIndex(): number {
    return this.menu.highlightedIndex
  }

  /** The select with keyboard focus, if any. */
  get focusedSelect(): string | null {
    return this.menu.focusedMenu
  }

  /** Close an open list without choosing (the control layer's outside-press hook). */
  dismiss(): void {
    this.menu.dismiss()
  }

  /** True while a list is open: the overlay then wants every event first. */
  isModal(): boolean {
    return this.menu.isModal()
  }

  /** Open a select's list with the current option highlighted (closing any other). */
  open(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.spec.enabled === false) return
    this.menu.open(id, selectIndex(entry.spec.options, entry.value))
  }

  /** Close the open list, if any, without choosing. */
  close(): void {
    this.menu.close()
  }

  /** Give a select keyboard focus, or null to clear. Disabled selects refuse. */
  focus(id: string | null): void {
    this.menu.focus(id)
  }

  hitTest(x: number, y: number): boolean {
    return this.menu.hitTest(x, y)
  }

  pointerDown(x: number, y: number): boolean {
    const wasOpen = this.menu.openMenu
    const consumed = this.menu.pointerDown(x, y)
    const nowOpen = this.menu.openMenu
    if (nowOpen !== null && nowOpen !== wasOpen) this.open(nowOpen)
    return consumed
  }

  pointerMove(x: number, y: number): boolean {
    return this.menu.pointerMove(x, y)
  }

  pointerUp(x: number, y: number): boolean {
    return this.menu.pointerUp(x, y)
  }

  pointerCancel(): void {
    this.menu.pointerCancel()
  }

  /**
   * The area popups must stay inside, in canvas pixels. `drawOverlay`
   * refreshes it from every frame; call it yourself when driving the overlay
   * without one. A list taller than the bounds scrolls.
   */
  setBounds(bounds: MenuBounds | null): void {
    this.menu.setBounds(bounds)
  }

  /** An open popup scrolls with the wheel; a closed select ignores it. */
  wheel(x: number, y: number, deltaX: number, deltaY: number): boolean {
    return this.menu.wheel(x, y, deltaX, deltaY)
  }

  /**
   * Open: the list handles the key (arrows move, Enter or Space choose, Escape
   * closes). Closed and focused: ArrowUp/Down step the value (Shift or
   * PageUp/PageDown by ten), Home and End jump to the ends, Enter, Space or
   * Alt+ArrowDown open the list on the current option.
   */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.menu.isModal()) return this.menu.keyDown(e)
    const id = this.menu.focusedMenu
    const entry = id !== null ? this.entries.get(id) : undefined
    if (id === null || !entry || entry.spec.enabled === false) return false
    const options = entry.spec.options
    const big = e.shiftKey ? 10 : 1
    let next: string | null | undefined
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        if (e.altKey) {
          this.open(id)
          return true
        }
        next = stepSelectValue(options, entry.value, 1, big)
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        next = stepSelectValue(options, entry.value, -1, big)
        break
      case 'PageDown':
        next = stepSelectValue(options, entry.value, 1, 10)
        break
      case 'PageUp':
        next = stepSelectValue(options, entry.value, -1, 10)
        break
      case 'Home':
        next = endSelectValue(options, entry.value, 'first')
        break
      case 'End':
        next = endSelectValue(options, entry.value, 'last')
        break
      case 'Enter':
      case ' ':
        this.open(id)
        return true
      default:
        return false
    }
    if (next !== undefined && next !== entry.value) this.choose(id, next)
    return true
  }

  blur(): void {
    this.menu.blur()
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.menu.bindLayer(layer)
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    this.menu.drawOverlay(frame)
  }

  /** Draw the open list; a control layer calls this after every widget. */
  drawPopup(frame: UIKitOverlayFrame): void {
    this.menu.drawPopup(frame)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.menu.destroy()
  }

  /** Apply a user choice: update the value, the button label, and fire `onChange`. */
  private choose(id: string, value: string | null): void {
    const entry = this.entries.get(id)
    if (!entry || value === null || value === entry.value) return
    entry.value = value
    this.sync(id)
    entry.spec.onChange?.(value, id)
  }

  /** Push an entry's current spec and value into the menu model. */
  private sync(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const buttonStyle = resolveButtonStyle(
      this.baseButtonStyle,
      entry.spec.buttonStyle,
    )
    const style = resolveMenuStyle(this.baseStyle, entry.spec.style)
    const menuSpec = selectMenuSpec(
      { ...entry.spec, value: entry.value },
      buttonStyle,
      style,
      this.font.metrics,
    )
    this.menu.addMenu({
      ...menuSpec,
      onChange: (itemId, checked) => {
        if (checked) this.choose(id, itemId)
      },
    })
  }
}
