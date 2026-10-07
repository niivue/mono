// A UIKit overlay of menu buttons drawn into the scene through the niivue
// overlay hook. Pressing a button opens its popup; while one is open the
// overlay is modal (a `UIKitControls` layer sends it every pointer and key
// event first). Moving over rows highlights them, releasing or pressing Enter
// on a highlighted row activates it (check items flip, radio items take their
// group, actions just fire) and closes the menu. A press outside the popup, or
// Escape, closes it without activating. Arrow keys, Home and End move the
// highlight; a focused closed button opens on Enter, Space or ArrowDown.
// A popup that fits neither below nor above its button scrolls by whole rows
// (see scroll.ts): the wheel, a press on either end strip, and keyboard moves
// that leave the visible rows all scroll it, and the highlight is always kept
// in view.
//
// The popup is drawn after every other widget through `drawPopup` when the
// overlay sits in a control layer, so it never ends up under a later widget.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import {
  type ButtonLayout,
  type ButtonStyle,
  buttonContains,
  resolveButtonStyle,
} from './button'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import type { LineData } from './line'
import { UIKitLineOverlay } from './lineOverlay'
import {
  activateMenuItem,
  buildMenuButton,
  buildMenuPopup,
  DEFAULT_MENU_BUTTON_STYLE,
  DEFAULT_MENU_STYLE,
  isMenuItemSelectable,
  layoutMenuButton,
  layoutMenuPopup,
  type MenuBounds,
  type MenuButtonSpec,
  type MenuItemSpec,
  type MenuPopupLayout,
  type MenuStyle,
  menuRevealRow,
  menuRowAt,
  menuScrollStripAt,
  nextSelectableIndex,
  popupContains,
  resolveMenuStyle,
  scaleMenu,
} from './menu'
import type { RectData } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import { WheelAccumulator } from './scroll'
import type { UIKitFont } from './text/font'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'

export interface UIKitMenuOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default button style for every menu; a spec's `buttonStyle` overrides per key. */
  buttonStyle?: Partial<ButtonStyle>
  /** Default popup style for every menu; a spec's `style` overrides per key. */
  style?: Partial<MenuStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
}

interface MenuEntry {
  spec: MenuButtonSpec
  buttonStyle: ButtonStyle
  style: MenuStyle
  layout: ButtonLayout | null
  /** Current item states (the spec's items with `checked` kept up to date). */
  items: MenuItemSpec[]
  hover: boolean
}

export class UIKitMenuOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  readonly hoverCursor = 'pointer'
  private readonly font: UIKitFont
  private readonly rects = new UIKitRectOverlay()
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private readonly popupRects = new UIKitRectOverlay()
  private readonly popupLines = new UIKitLineOverlay()
  private readonly popupText: UIKitTextOverlay
  private readonly entries = new Map<string, MenuEntry>()
  private baseButtonStyle: ButtonStyle
  private baseStyle: MenuStyle
  private readonly cssUnits: boolean
  private requestRedraw: (() => void) | null
  private inLayer = false
  private scale = 1
  private geometryDirty = true
  private popupDirty = true
  private bounds: MenuBounds | null = null
  private openId: string | null = null
  private popup: MenuPopupLayout | null = null
  private highlight = -1
  /** First visible row of a scrolled popup (the layout clamps it). */
  private firstRow = 0
  private wheelCarry: WheelAccumulator | null = null
  /** The button the pointer went down on and still holds. */
  private pressedId: string | null = null
  /** Whether the held press opened the menu (a release then keeps it open). */
  private pressOpened = false
  private hoverId: string | null = null
  private focusedId: string | null = null

  constructor(font: UIKitFont, options: UIKitMenuOverlayOptions = {}) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    this.popupText = new UIKitTextOverlay(font)
    this.baseButtonStyle = resolveButtonStyle(
      DEFAULT_MENU_BUTTON_STYLE,
      options.buttonStyle,
    )
    this.baseStyle = resolveMenuStyle(DEFAULT_MENU_STYLE, options.style)
    this.cssUnits = options.cssUnits ?? false
    this.requestRedraw = options.requestRedraw ?? null
  }

  /**
   * Add a menu, or replace the one with the same id. A replacement takes the
   * new spec's items and their `checked` states; an open replaced menu closes.
   */
  addMenu(spec: MenuButtonSpec): void {
    const existing = this.entries.get(spec.id)
    const buttonStyle = resolveButtonStyle(
      this.baseButtonStyle,
      spec.buttonStyle,
    )
    const style = resolveMenuStyle(this.baseStyle, spec.style)
    const items = spec.items.map((item) => ({ ...item }))
    if (existing) {
      existing.spec = spec
      existing.buttonStyle = buttonStyle
      existing.style = style
      existing.layout = null
      existing.items = items
      if (this.openId === spec.id) this.close()
    } else {
      this.entries.set(spec.id, {
        spec,
        buttonStyle,
        style,
        layout: null,
        items,
        hover: false,
      })
    }
    this.invalidate()
  }

  /** Replace the whole menu set. */
  setMenus(specs: readonly MenuButtonSpec[]): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) this.removeMenu(id)
    }
    for (const spec of specs) this.addMenu(spec)
  }

  removeMenu(id: string): void {
    if (!this.entries.has(id)) return
    if (this.openId === id) this.close()
    this.entries.delete(id)
    if (this.pressedId === id) this.pressedId = null
    if (this.hoverId === id) this.hoverId = null
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
  }

  /** Patch one menu's spec. Items are kept unless the patch sets `items`. */
  updateMenu(id: string, patch: Partial<Omit<MenuButtonSpec, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const items = patch.items ?? entry.items
    this.addMenu({ ...entry.spec, ...patch, id, items })
    if (entry.spec.enabled === false && this.focusedId === id)
      this.focusedId = null
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateMenu(id, { enabled })
  }

  /** Replace a menu's items (closing it if open). */
  setItems(id: string, items: readonly MenuItemSpec[]): void {
    this.updateMenu(id, { items })
  }

  /** The current items of a menu (with live `checked` states), or an empty list. */
  getItems(id: string): readonly MenuItemSpec[] {
    return this.entries.get(id)?.items ?? []
  }

  /** A check or radio item's current state. */
  isItemChecked(menuId: string, itemId: string): boolean {
    return (
      this.entries.get(menuId)?.items.find((i) => i.id === itemId)?.checked ??
      false
    )
  }

  /**
   * Set a check or radio item's state from code. Fires no callbacks. Checking
   * a radio unchecks the rest of its group; unchecking one leaves the group empty.
   */
  setItemChecked(menuId: string, itemId: string, checked: boolean): void {
    const entry = this.entries.get(menuId)
    if (!entry) return
    const index = entry.items.findIndex((i) => i.id === itemId)
    const item = entry.items[index]
    if (!item || (item.kind !== 'check' && item.kind !== 'radio')) return
    if (item.kind === 'radio' && checked) {
      const group = item.group ?? ''
      entry.items = entry.items.map((i) =>
        i.kind === 'radio' && (i.group ?? '') === group
          ? { ...i, checked: i.id === itemId }
          : i,
      )
    } else {
      entry.items = entry.items.map((i) =>
        i.id === itemId ? { ...i, checked } : i,
      )
    }
    this.invalidate()
  }

  /** The ids of all menus, in draw order. */
  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /** A menu button's box in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): ButtonLayout | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const l = this.layoutOf(entry)
    const k = this.scale
    return k === 1
      ? l
      : { x: l.x / k, y: l.y / k, width: l.width / k, height: l.height / k }
  }

  /** The open popup's panel and rows in spec units, or null when no menu is open. */
  getPopupLayout(): MenuPopupLayout | null {
    const l = this.popupLayout()
    if (!l) return null
    const k = this.scale
    if (k === 1) return l
    const s = (r: { x: number; y: number; width: number; height: number }) => ({
      x: r.x / k,
      y: r.y / k,
      width: r.width / k,
      height: r.height / k,
    })
    return {
      ...l,
      ...s(l),
      rows: l.rows.map((r) => ({ index: r.index, ...s(r) })),
      scrollUp: l.scrollUp && s(l.scrollUp),
      scrollDown: l.scrollDown && s(l.scrollDown),
    }
  }

  /** The id of the open menu, if any. */
  get openMenu(): string | null {
    return this.openId
  }

  isOpen(id: string): boolean {
    return this.openId === id
  }

  /** The index of the highlighted item in the open menu, or -1. */
  get highlightedIndex(): number {
    return this.openId === null ? -1 : this.highlight
  }

  /** The menu button with keyboard focus, if any. */
  get focusedMenu(): string | null {
    return this.focusedId
  }

  /** Close an open popup without choosing (the control layer's outside-press hook). */
  dismiss(): void {
    this.close()
  }

  /** True while a popup is open: the overlay then wants every event first. */
  isModal(): boolean {
    return this.openId !== null
  }

  /**
   * The area popups must stay inside, in canvas pixels. `drawOverlay` refreshes
   * it from every frame; call it yourself when driving the overlay without one.
   */
  setBounds(bounds: MenuBounds | null): void {
    const b = this.bounds
    if (
      b === bounds ||
      (b &&
        bounds &&
        b.x === bounds.x &&
        b.y === bounds.y &&
        b.width === bounds.width &&
        b.height === bounds.height)
    ) {
      return
    }
    this.bounds = bounds ? { ...bounds } : null
    this.popup = null
    this.popupDirty = true
  }

  /**
   * Open a menu's popup (closing any other) with `highlightIndex` highlighted,
   * or nothing by default. Opening the already open menu only moves the highlight.
   */
  open(id: string, highlightIndex = -1): void {
    const entry = this.entries.get(id)
    if (!entry || entry.spec.enabled === false) return
    if (this.openId === id) {
      this.setHighlight(highlightIndex)
      return
    }
    this.openId = id
    this.popup = null
    this.highlight = highlightIndex
    this.firstRow = 0
    this.wheelCarry = null
    this.focus(id)
    this.invalidate()
  }

  /** Close the open popup, if any, without activating anything. */
  close(): void {
    if (this.openId === null) return
    this.openId = null
    this.popup = null
    this.highlight = -1
    this.firstRow = 0
    this.wheelCarry = null
    this.invalidate()
  }

  /** Give a menu button keyboard focus, or null to clear. Disabled buttons refuse. */
  focus(id: string | null): void {
    const entry = id !== null ? this.entries.get(id) : undefined
    const next = entry && entry.spec.enabled !== false ? id : null
    if (next === this.focusedId) return
    this.focusedId = next
    this.invalidate()
  }

  hitTest(x: number, y: number): boolean {
    const popup = this.popupLayout()
    if (popup && popupContains(popup, x, y)) return true
    return this.hitEntry(x, y) !== null
  }

  pointerDown(x: number, y: number): boolean {
    const hit = this.hitEntry(x, y)
    if (this.openId !== null) {
      const popup = this.popupLayout()
      if (popup && popupContains(popup, x, y)) {
        const strip = menuScrollStripAt(popup, x, y)
        if (strip !== 0) this.scrollBy(strip, x, y)
        else this.setHighlight(menuRowAt(popup, x, y))
        this.pressedId = null
        return true
      }
      const wasOpen = this.openId
      this.close()
      if (hit && hit.spec.id !== wasOpen) {
        this.pressedId = hit.spec.id
        this.pressOpened = true
        this.open(hit.spec.id)
      } else {
        this.pressedId = null
      }
      // The press that dismissed a menu is spent: it must not reach the scene.
      return true
    }
    if (!hit) return false
    this.pressedId = hit.spec.id
    this.pressOpened = true
    this.open(hit.spec.id)
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.openId !== null) {
      const popup = this.popupLayout()
      const row =
        popup && popupContains(popup, x, y) ? menuRowAt(popup, x, y) : -1
      const entry = this.entries.get(this.openId)
      const item = entry && row >= 0 ? entry.items[row] : undefined
      // Leaving the rows keeps the last keyboard highlight, like a native menu.
      if (item) this.setHighlight(isMenuItemSelectable(item) ? row : -1)
      return true
    }
    const hit = this.hitEntry(x, y)
    const id = hit ? hit.spec.id : null
    if (id !== this.hoverId) {
      const prev = this.hoverId ? this.entries.get(this.hoverId) : null
      if (prev) prev.hover = false
      if (hit) hit.hover = true
      this.hoverId = id
      this.invalidate()
    }
    return this.pressedId !== null
  }

  /** Activates the highlighted row when released over it; a release on the button keeps the menu open. */
  pointerUp(x: number, y: number): boolean {
    const held = this.pressedId !== null || this.openId !== null
    const pressed = this.pressedId
    this.pressedId = null
    if (this.openId === null) return held
    if (pressed === this.openId && this.pressOpened) {
      // The press opened this menu: releasing over the button leaves it open.
      this.pressOpened = false
      const entry = this.entries.get(this.openId)
      if (entry && buttonContains(this.layoutOf(entry), x, y)) return true
    }
    const popup = this.popupLayout()
    if (popup && popupContains(popup, x, y)) {
      const row = menuRowAt(popup, x, y)
      if (row >= 0) this.activate(row)
    }
    return held
  }

  pointerCancel(): void {
    this.pressedId = null
    this.pressOpened = false
  }

  /**
   * While a popup is open the wheel scrolls it by rows (a trackpad's small
   * deltas add up) and the row under the pointer takes the highlight. Every
   * wheel turn is consumed while a menu is up; a closed menu ignores it.
   */
  wheel(x: number, y: number, _deltaX: number, deltaY: number): boolean {
    if (this.openId === null) return false
    const entry = this.entries.get(this.openId)
    const popup = this.popupLayout()
    if (!entry || !popup?.scrollable) return true
    this.wheelCarry ??= new WheelAccumulator(entry.style.itemHeight)
    const steps = this.wheelCarry.add(deltaY)
    if (steps !== 0) this.scrollBy(steps, x, y)
    return true
  }

  /**
   * Open: arrows, Home and End move the highlight, Enter or Space activate it,
   * Escape closes; every other key is swallowed while the menu is up. Closed
   * and focused: Enter, Space or ArrowDown open the menu on its first item,
   * ArrowUp on its last.
   */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.openId !== null) {
      const entry = this.entries.get(this.openId)
      if (!entry) return false
      const items = entry.items
      switch (e.key) {
        case 'ArrowDown':
          this.setHighlight(nextSelectableIndex(items, this.highlight, 1))
          break
        case 'ArrowUp':
          this.setHighlight(nextSelectableIndex(items, this.highlight, -1))
          break
        case 'Home':
          this.setHighlight(nextSelectableIndex(items, -1, 1))
          break
        case 'End':
          this.setHighlight(nextSelectableIndex(items, -1, -1))
          break
        case 'Enter':
        case ' ':
          if (this.highlight >= 0) this.activate(this.highlight)
          break
        case 'Escape':
        case 'Tab':
          this.close()
          break
        default:
          break
      }
      return true
    }
    if (this.focusedId === null) return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false) return false
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      this.open(this.focusedId)
      this.setHighlight(nextSelectableIndex(entry.items, -1, 1))
      return true
    }
    if (e.key === 'ArrowUp') {
      this.open(this.focusedId)
      this.setHighlight(nextSelectableIndex(entry.items, -1, -1))
      return true
    }
    return false
  }

  blur(): void {
    this.focus(null)
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.requestRedraw ??= () => layer.requestRedraw()
    this.inLayer = true
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    this.setBounds(frame.bounds)
    if (this.entries.size === 0) return
    const scale = this.cssUnits ? frame.dpr : 1
    if (scale !== this.scale) {
      this.scale = scale
      for (const entry of this.entries.values()) entry.layout = null
      this.popup = null
      this.geometryDirty = true
      this.popupDirty = true
    }
    if (this.geometryDirty) this.rebuild()
    this.rects.drawOverlay(frame)
    this.lines.drawOverlay(frame)
    this.labels.drawOverlay(frame)
    if (!this.inLayer) this.drawPopup(frame)
  }

  /** Draw the open popup; a control layer calls this after every widget. */
  drawPopup(frame: UIKitOverlayFrame): void {
    if (this.openId === null) return
    this.setBounds(frame.bounds)
    if (this.popupDirty) this.rebuildPopup()
    this.popupRects.drawOverlay(frame)
    this.popupLines.drawOverlay(frame)
    this.popupText.drawOverlay(frame)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.rects.destroy()
    this.lines.destroy()
    this.labels.destroy()
    this.popupRects.destroy()
    this.popupLines.destroy()
    this.popupText.destroy()
  }

  private invalidate(): void {
    this.geometryDirty = true
    this.popupDirty = true
    this.requestRedraw?.()
  }

  /**
   * Scroll the open popup by `rows` (negative is up), drop a highlight that
   * scrolled out of view, and re-highlight whatever row is now under (x, y).
   */
  private scrollBy(rows: number, x: number, y: number): void {
    const popup = this.popupLayout()
    if (!popup?.scrollable) return
    const highlight = this.highlight
    this.highlight = -1
    this.firstRow = Math.max(0, popup.firstRow + rows)
    this.popup = null
    const next = this.popupLayout()
    if (next && highlight >= next.firstRow && highlight < next.endRow) {
      this.highlight = highlight
    }
    this.popupDirty = true
    this.requestRedraw?.()
    this.pointerMove(x, y)
  }

  private setHighlight(index: number): void {
    if (index === this.highlight) return
    this.highlight = index
    // A highlight outside the visible rows needs a fresh layout to reveal it.
    const popup = this.popup
    if (
      popup?.scrollable &&
      index >= 0 &&
      (index < popup.firstRow || index >= popup.endRow)
    ) {
      this.popup = null
    }
    this.popupDirty = true
    this.requestRedraw?.()
  }

  /** Apply an item's state change, fire the callbacks, and close the menu. */
  private activate(index: number): void {
    const id = this.openId
    const entry = id !== null ? this.entries.get(id) : undefined
    if (id === null || !entry) return
    const item = entry.items[index]
    if (!item || !isMenuItemSelectable(item)) return
    const result = activateMenuItem(entry.items, index)
    entry.items = result.items
    this.close()
    for (const c of result.changed) entry.spec.onChange?.(c.id, c.checked, id)
    item.onSelect?.(item.id)
    entry.spec.onSelect?.(item.id, id)
  }

  private scaled(entry: MenuEntry) {
    return scaleMenu(entry.spec, entry.buttonStyle, entry.style, this.scale)
  }

  private layoutOf(entry: MenuEntry): ButtonLayout {
    if (!entry.layout) {
      const { spec, buttonStyle, style } = this.scaled(entry)
      entry.layout = layoutMenuButton(
        spec,
        buttonStyle,
        style,
        this.font.metrics,
      )
    }
    return entry.layout
  }

  private popupLayout(): MenuPopupLayout | null {
    if (this.openId === null) return null
    if (!this.popup) {
      const entry = this.entries.get(this.openId)
      if (!entry) return null
      const { style } = this.scaled(entry)
      const button = this.layoutOf(entry)
      let popup = layoutMenuPopup(
        entry.items,
        style,
        this.font.metrics,
        button,
        this.bounds,
        this.firstRow,
      )
      // Keep the highlight in view: after opening on an item, a keyboard
      // move past the visible rows, or a resize that hid it.
      const first = menuRevealRow(entry.items, style, popup, this.highlight)
      if (first !== popup.firstRow) {
        popup = layoutMenuPopup(
          entry.items,
          style,
          this.font.metrics,
          button,
          this.bounds,
          first,
        )
      }
      this.firstRow = popup.firstRow
      this.popup = popup
    }
    return this.popup
  }

  /** The topmost (last added) enabled menu button under a canvas point. */
  private hitEntry(x: number, y: number): MenuEntry | null {
    const list = [...this.entries.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry.spec.enabled === false) continue
      if (buttonContains(this.layoutOf(entry), x, y)) return entry
    }
    return null
  }

  private rebuild(): void {
    const rects: RectData[] = []
    const lines: LineData[] = []
    const text: UIKitTextItem[] = []
    for (const entry of this.entries.values()) {
      const { spec, buttonStyle, style } = this.scaled(entry)
      const id = entry.spec.id
      const geo = buildMenuButton(
        spec,
        buttonStyle,
        style,
        this.font.metrics,
        this.layoutOf(entry),
        {
          hover: entry.hover || this.pressedId === id,
          press: 0,
          enabled: entry.spec.enabled !== false,
          open: this.openId === id,
        },
      )
      rects.push(geo.rect)
      lines.push(...geo.lines)
      text.push(geo.text)
    }
    this.rects.setRects(rects)
    this.lines.setLines(lines)
    this.labels.setItems(text)
    this.geometryDirty = false
  }

  private rebuildPopup(): void {
    const entry =
      this.openId !== null ? this.entries.get(this.openId) : undefined
    const popup = this.popupLayout()
    if (!entry || !popup) return
    const { style } = this.scaled(entry)
    const geo = buildMenuPopup(
      entry.items,
      style,
      this.font.metrics,
      popup,
      this.highlight,
    )
    this.popupRects.setRects(geo.rects)
    this.popupLines.setLines(geo.lines)
    this.popupText.setItems(geo.text)
    this.popupDirty = false
  }
}
