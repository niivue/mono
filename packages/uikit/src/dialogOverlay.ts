// A UIKit overlay of dialogs drawn into the scene through the niivue overlay
// hook. An open dialog is modal: a scrim covers the canvas, the panel shows a
// title, a wrapped message, a content box for hosted widgets and a row of
// action buttons, and every pointer, key and wheel event goes to the dialog
// first. Pressing a button closes the dialog with that button's id as the
// result; Enter presses the `default` button, Escape the `cancel` button (or
// closes with a null result when there is none); a press on the scrim closes
// with null when the spec allows it, else does nothing.
//
// Hosted widgets are ordinary overlays (text inputs, number inputs, toggles,
// ...) added to a dialog with `addChild`: while it is open the dialog routes
// events among them like a control layer (press captures, hover, focus, a
// modal child such as an open select first) and draws them over the panel.
// The spec's `onLayout` hands the host the panel and content boxes in spec
// units so it can position them. The children must use the same units as the
// dialog (`cssUnits` or not).
//
// A dialog is not a popup: `dismiss` (the control layer's hook for a press or
// focus elsewhere in the page) only blurs the children; the dialog stays
// open until a result closes it.
//
// The dialog owns what it hosts: `removeDialog` and `destroy` release the
// hosted children's GPU resources along with the action buttons, so the
// control layer's `destroy` tears a form down in one call. `removeChild`
// first to keep a child alive.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import {
  DEFAULT_BUTTON_STYLE,
  layoutButton,
  resolveButtonStyle,
} from './button'
import { UIKitButtonOverlay } from './buttonOverlay'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import {
  buildDialog,
  DEFAULT_DIALOG_STYLE,
  type DialogBoxes,
  type DialogButtonSize,
  type DialogLayout,
  type DialogSpec,
  type DialogStyle,
  dialogContains,
  layoutDialog,
  resolveDialogStyle,
  scaleDialog,
} from './dialog'
import { UIKitRectOverlay } from './rectOverlay'
import type { UIKitBox } from './scroll'
import type { UIKitFont } from './text/font'
import { UIKitTextOverlay } from './textOverlay'

export interface UIKitDialogOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every dialog; a spec's `style` overrides per key. */
  style?: Partial<DialogStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
  /** Clock for the button press animation. Default `performance.now`. */
  now?: () => number
}

interface DialogEntry {
  spec: DialogSpec
  style: DialogStyle
  layout: DialogLayout | null
  /** The hosted widgets, in draw order. */
  children: UIKitInteractive[]
  /** The action buttons, laid out in canvas pixels. */
  buttons: UIKitButtonOverlay
  /** The boxes last reported through `onLayout`, in spec units. */
  reported: DialogBoxes | null
}

export class UIKitDialogOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  private readonly font: UIKitFont
  private readonly rects = new UIKitRectOverlay()
  private readonly labels: UIKitTextOverlay
  private readonly entries = new Map<string, DialogEntry>()
  private baseStyle: DialogStyle
  private readonly cssUnits: boolean
  private readonly now: (() => number) | undefined
  private requestRedraw: (() => void) | null
  private layer: UIKitRedrawSource | null = null
  private inLayer = false
  private scale = 1
  private bounds: { width: number; height: number } = { width: 0, height: 0 }
  private geometryDirty = true
  private openId: string | null = null
  /** The member (a child or the button row) owning the pointer, and the focused one. */
  private captured: UIKitInteractive | null = null
  private focused: UIKitInteractive | null = null
  private hovered: UIKitInteractive | null = null

  constructor(font: UIKitFont, options: UIKitDialogOverlayOptions = {}) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    this.baseStyle = resolveDialogStyle(DEFAULT_DIALOG_STYLE, options.style)
    this.cssUnits = options.cssUnits ?? false
    this.now = options.now
    this.requestRedraw = options.requestRedraw ?? null
  }

  /** CSS cursor: the captured or hovered member's, else the default over the panel. */
  get hoverCursor(): string | undefined {
    const m = this.captured ?? this.hovered
    return m?.hoverCursor ?? 'default'
  }

  /** Replace the default style for every dialog (per-spec overrides still win). */
  setDefaultStyle(style: Partial<DialogStyle>): void {
    this.baseStyle = resolveDialogStyle(DEFAULT_DIALOG_STYLE, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveDialogStyle(this.baseStyle, entry.spec.style)
      entry.layout = null
    }
    this.invalidate()
  }

  /** Add a dialog, or replace the one with the same id (keeping its children). */
  addDialog(spec: DialogSpec): void {
    const existing = this.entries.get(spec.id)
    const style = resolveDialogStyle(this.baseStyle, spec.style)
    if (existing) {
      existing.spec = spec
      existing.style = style
      existing.layout = null
      existing.reported = null
    } else {
      const buttons = new UIKitButtonOverlay(this.font, {
        requestRedraw: () => this.requestRedraw?.(),
        cssUnits: this.cssUnits,
        now: this.now,
      })
      this.entries.set(spec.id, {
        spec,
        style,
        layout: null,
        children: [],
        buttons,
        reported: null,
      })
    }
    this.invalidate()
  }

  removeDialog(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (this.openId === id) this.close(null)
    entry.buttons.destroy()
    for (const child of entry.children) child.destroy?.()
    this.entries.delete(id)
    this.invalidate()
  }

  /** Patch one dialog's spec (title, message, buttons, position, ...). */
  updateDialog(id: string, patch: Partial<Omit<DialogSpec, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.addDialog({ ...entry.spec, ...patch, id })
  }

  /** Host a widget in a dialog: routed and drawn while the dialog is open. */
  addChild(id: string, child: UIKitInteractive): void {
    const entry = this.entries.get(id)
    if (!entry || entry.children.includes(child)) return
    entry.children.push(child)
    if (this.layer) child.bindLayer?.(this.layer)
    this.invalidate()
  }

  removeChild(id: string, child: UIKitInteractive): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const i = entry.children.indexOf(child)
    if (i < 0) return
    entry.children.splice(i, 1)
    if (this.captured === child) {
      child.pointerCancel()
      this.captured = null
    }
    if (this.focused === child) this.focused = null
    if (this.hovered === child) this.hovered = null
    this.invalidate()
  }

  /** The ids of all dialogs. */
  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /** The open dialog's id, if any. */
  get openDialog(): string | null {
    return this.openId
  }

  isOpen(id: string): boolean {
    return this.openId === id
  }

  /** Open a dialog (closing any other with a null result). */
  open(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || this.openId === id) return
    if (this.openId !== null) this.close(null)
    this.openId = id
    entry.layout = null
    entry.reported = null
    this.invalidate()
  }

  /** Close the open dialog, reporting `result` through its `onClose`. */
  close(result: string | null = null): void {
    const id = this.openId
    if (id === null) return
    const entry = this.entries.get(id)
    this.openId = null
    this.captured?.pointerCancel()
    this.captured = null
    this.focused?.blur?.()
    this.focused = null
    this.hovered = null
    if (entry) {
      for (const c of entry.children) {
        if (c.isModal?.()) c.dismiss?.()
      }
    }
    this.invalidate()
    entry?.spec.onClose?.(result, id)
  }

  /** Press an action button of the open dialog from code (animated, then closes). */
  click(buttonId: string): void {
    const entry = this.openEntry()
    if (!entry) return
    const b = entry.spec.buttons?.find((x) => x.id === buttonId)
    if (!b || b.enabled === false) return
    this.layoutOf(entry)
    entry.buttons.click(buttonId)
  }

  /** The open dialog's boxes in spec units, once it has been laid out. */
  getBoxes(id: string): DialogBoxes | null {
    const entry = this.entries.get(id)
    if (!entry || this.bounds.width === 0) return null
    return this.boxesOf(this.layoutOf(entry))
  }

  /**
   * The area the panel centers in, in canvas pixels. `drawOverlay` refreshes
   * it from every frame; call it yourself when driving the overlay without one.
   */
  setBounds(bounds: { width: number; height: number }): void {
    if (
      bounds.width === this.bounds.width &&
      bounds.height === this.bounds.height
    )
      return
    this.bounds = { width: bounds.width, height: bounds.height }
    for (const entry of this.entries.values()) entry.layout = null
    this.invalidate()
  }

  isModal(): boolean {
    return this.openId !== null
  }

  /** A press or focus elsewhere in the page: the children lose focus, the dialog stays. */
  dismiss(): void {
    const entry = this.openEntry()
    if (!entry) return
    for (const c of entry.children) {
      if (c.isModal?.()) c.dismiss?.()
    }
    this.blur()
  }

  blur(): void {
    this.focused?.blur?.()
    this.focused = null
  }

  /** The whole canvas while open (the dialog is modal), else nothing. */
  hitTest(_x: number, _y: number): boolean {
    return this.openId !== null
  }

  pointerDown(x: number, y: number): boolean {
    const entry = this.openEntry()
    if (!entry) return false
    const layout = this.layoutOf(entry)
    const modal = this.modalChild(entry)
    const targets = modal ? [modal] : this.members(entry)
    for (const m of targets) {
      if (m.pointerDown(x, y)) {
        this.captured = m
        this.setFocus(m)
        return true
      }
    }
    this.setFocus(null)
    if (!dialogContains(layout, x, y) && entry.spec.closeOnScrim) {
      this.close(null)
    }
    return true
  }

  pointerMove(x: number, y: number): boolean {
    const entry = this.openEntry()
    if (!entry) return false
    if (this.captured) {
      this.hovered = this.captured
      this.captured.pointerMove(x, y)
      return true
    }
    const modal = this.modalChild(entry)
    let hovered: UIKitInteractive | null = null
    for (const m of this.members(entry)) {
      if (m === modal) {
        m.pointerMove(x, y)
        hovered = m
      } else if (!modal && hovered === null && m.hitTest(x, y)) {
        m.pointerMove(x, y)
        hovered = m
      } else {
        m.pointerMove(-1, -1)
      }
    }
    this.hovered = hovered
    return true
  }

  pointerUp(x: number, y: number): boolean {
    const m = this.captured
    if (!m) return this.openId !== null
    this.captured = null
    m.pointerUp(x, y)
    this.pointerMove(x, y)
    return true
  }

  pointerCancel(): void {
    const m = this.captured
    this.captured = null
    m?.pointerCancel()
  }

  /**
   * A modal child sees the key first and keeps what it takes. Then the
   * focused child, except that Enter it takes (a field committing its text)
   * still presses the default button, as Enter in a form field submits the
   * form. Otherwise Enter presses the default button and Escape the cancel
   * button (or closes with null). Every other key is swallowed while open.
   */
  keyDown(e: UIKitKeyEvent): boolean {
    const entry = this.openEntry()
    if (!entry) return false
    const modal = this.modalChild(entry)
    if (modal) {
      if (modal.keyDown?.(e)) return true
    } else if (this.focused?.keyDown?.(e) && e.key !== 'Enter') {
      return true
    }
    if (e.key === 'Enter') {
      const b = entry.spec.buttons?.find((x) => x.role === 'default')
      if (b && b.enabled !== false) this.click(b.id)
      return true
    }
    if (e.key === 'Escape') {
      const b = entry.spec.buttons?.find((x) => x.role === 'cancel')
      if (b && b.enabled !== false) this.click(b.id)
      else this.close(null)
      return true
    }
    // The dialog is modal to the canvas, not the page: reload, find and zoom
    // (keys with Meta or Ctrl held) pass; every other key stays in the form.
    return !(e.metaKey || e.ctrlKey)
  }

  /** A modal child, else the child under the point, may scroll; the page never does. */
  wheel(x: number, y: number, deltaX: number, deltaY: number): boolean {
    const entry = this.openEntry()
    if (!entry) return false
    const modal = this.modalChild(entry)
    if (modal) {
      modal.wheel?.(x, y, deltaX, deltaY)
      return true
    }
    for (const m of this.members(entry)) {
      if (m.wheel && m.hitTest(x, y)) {
        m.wheel(x, y, deltaX, deltaY)
        break
      }
    }
    return true
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.requestRedraw ??= () => layer.requestRedraw()
    this.layer = layer
    this.inLayer = true
    for (const entry of this.entries.values()) {
      for (const c of entry.children) c.bindLayer?.(layer)
    }
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (!this.inLayer) this.drawPopup(frame)
  }

  /** Draw the open dialog; a control layer calls this after every widget. */
  drawPopup(frame: UIKitOverlayFrame): void {
    const entry = this.openEntry()
    if (!entry) return
    const scale = this.cssUnits ? frame.dpr : 1
    if (scale !== this.scale) {
      this.scale = scale
      for (const e of this.entries.values()) e.layout = null
      this.geometryDirty = true
    }
    this.setBounds(frame.bounds)
    const layout = this.layoutOf(entry)
    if (this.geometryDirty) {
      const { spec, style } = this.scaled(entry)
      const geo = buildDialog(spec, style, layout, this.bounds)
      this.rects.setRects(geo.rects)
      this.labels.setItems(geo.text)
      this.geometryDirty = false
    }
    this.rects.drawOverlay(frame)
    this.labels.drawOverlay(frame)
    entry.buttons.drawOverlay(frame)
    for (const c of entry.children) c.drawOverlay(frame)
    for (const c of entry.children) c.drawPopup?.(frame)
  }

  /** Release GPU resources on both backends (the children's are their owner's). */
  /** Release the surfaces, the action buttons and every hosted child. */
  destroy(): void {
    this.rects.destroy()
    this.labels.destroy()
    for (const entry of this.entries.values()) {
      entry.buttons.destroy()
      for (const child of entry.children) child.destroy?.()
    }
  }

  private invalidate(): void {
    this.geometryDirty = true
    this.requestRedraw?.()
  }

  private openEntry(): DialogEntry | null {
    return this.openId !== null ? (this.entries.get(this.openId) ?? null) : null
  }

  /** The routing order, topmost first: the button row, then the children last added first. */
  private members(entry: DialogEntry): UIKitInteractive[] {
    return [entry.buttons, ...[...entry.children].reverse()]
  }

  private modalChild(entry: DialogEntry): UIKitInteractive | null {
    for (let i = entry.children.length - 1; i >= 0; i--) {
      const c = entry.children[i]
      if (c.isModal?.()) return c
    }
    return null
  }

  private setFocus(m: UIKitInteractive | null): void {
    if (this.focused === m) return
    this.focused?.blur?.()
    this.focused = m
  }

  private scaled(entry: DialogEntry): { spec: DialogSpec; style: DialogStyle } {
    return scaleDialog(entry.spec, entry.style, this.scale)
  }

  private boxesOf(layout: DialogLayout): DialogBoxes {
    const k = this.scale
    const box = (b: UIKitBox): UIKitBox => ({
      x: b.x / k,
      y: b.y / k,
      width: b.width / k,
      height: b.height / k,
    })
    return { panel: box(layout.panel), content: box(layout.content) }
  }

  /**
   * Lay the panel out (sizing the buttons first), place the buttons, and
   * report the boxes to `onLayout` when they changed. The button overlay
   * shares the dialog's units, so it is fed spec-unit positions.
   */
  private layoutOf(entry: DialogEntry): DialogLayout {
    if (entry.layout) return entry.layout
    const k = this.scale
    const { spec, style } = this.scaled(entry)
    const buttonStyle = resolveButtonStyle(
      DEFAULT_BUTTON_STYLE,
      entry.style.button,
    )
    const defaultStyle = resolveButtonStyle(
      buttonStyle,
      entry.style.defaultButton,
    )
    const sizes: DialogButtonSize[] = (spec.buttons ?? []).map((b) => {
      const l = layoutButton(
        { id: b.id, label: b.label, x: 0, y: 0 },
        b.role === 'default' ? defaultStyle : buttonStyle,
        this.font.metrics,
      )
      return { id: b.id, width: l.width * k, height: l.height * k }
    })
    const layout = layoutDialog(
      spec,
      style,
      this.font.metrics,
      sizes,
      this.bounds,
    )
    entry.layout = layout
    entry.buttons.setButtons(
      layout.buttons.map(({ id, box }) => {
        const b = spec.buttons?.find((x) => x.id === id)
        return {
          id,
          label: b?.label ?? id,
          x: box.x / k,
          y: box.y / k,
          width: box.width / k,
          height: box.height / k,
          enabled: b?.enabled,
          style:
            b?.role === 'default'
              ? { ...entry.style.button, ...entry.style.defaultButton }
              : entry.style.button,
          onClick: () => this.close(id),
        }
      }),
    )
    this.geometryDirty = true
    const boxes = this.boxesOf(layout)
    const r = entry.reported
    const same =
      r !== null &&
      r.panel.x === boxes.panel.x &&
      r.panel.y === boxes.panel.y &&
      r.panel.width === boxes.panel.width &&
      r.panel.height === boxes.panel.height &&
      r.content.height === boxes.content.height
    if (!same) {
      entry.reported = boxes
      entry.spec.onLayout?.(boxes, entry.spec.id)
    }
    return layout
  }
}
