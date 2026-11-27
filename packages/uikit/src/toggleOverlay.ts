// A UIKit overlay of toggles (check boxes with labels) drawn into the scene
// through the niivue overlay hook. The pointer gives a toggle a hover tint and
// a pressed shrink; releasing inside flips it and fires `onChange`. A toggle
// pressed by the pointer takes keyboard focus (shown as a ring), and Space or
// Enter then flips it. Add it to a `UIKitControls` layer with the other widgets,
// or feed `pointerDown/Move/Up` and `keyDown` yourself from any host.

import type { UIKitKeyEvent } from './controls'
import { UIKitEntryOverlay, type UIKitGeometry } from './overlayParts'
import { unscaleBox } from './rect'
import type { UIKitFont } from './text/font'
import {
  buildToggle,
  DEFAULT_TOGGLE_STYLE,
  layoutToggle,
  scaleToggle,
  type ToggleLayout,
  type ToggleSpec,
  type ToggleStyle,
  toggleContains,
} from './toggle'

export interface UIKitToggleOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every toggle; a spec's `style` overrides per key. */
  style?: Partial<ToggleStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
}

interface ToggleEntry {
  spec: ToggleSpec
  style: ToggleStyle
  layout: ToggleLayout | null
  checked: boolean
}

const MODEL = {
  defaultStyle: DEFAULT_TOGGLE_STYLE,
  scale: scaleToggle,
  layout: layoutToggle,
  contains: toggleContains,
}

export class UIKitToggleOverlay extends UIKitEntryOverlay<
  ToggleSpec,
  ToggleStyle,
  ToggleLayout,
  ToggleEntry
> {
  readonly hoverCursor = 'pointer'
  /** While pressed: whether the pointer is currently over the pressed toggle. */
  private pressInside = false

  constructor(font: UIKitFont, options: UIKitToggleOverlayOptions = {}) {
    super(font, MODEL, options)
  }

  /**
   * Add a toggle, or replace the one with the same id. A replacement keeps the
   * current checked state unless the new spec sets `checked`.
   */
  addToggle(spec: ToggleSpec): void {
    const existing = this.upsert(spec, (style) => ({
      spec,
      style,
      layout: null,
      checked: spec.checked ?? false,
    }))
    if (existing && spec.checked !== undefined) existing.checked = spec.checked
    this.invalidate()
  }

  /** Replace the whole toggle set. */
  setToggles(specs: readonly ToggleSpec[]): void {
    this.replaceAll(specs, (spec) => this.addToggle(spec))
  }

  removeToggle(id: string): void {
    this.remove(id)
  }

  /** Patch one toggle's spec (label, position, style, enabled, checked, callback). */
  updateToggle(id: string, patch: Partial<Omit<ToggleSpec, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.addToggle({ ...entry.spec, ...patch, id })
    if (entry.spec.enabled === false) {
      if (this.pressedId === id) this.pressedId = null
      if (this.focusedId === id) this.focusedId = null
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateToggle(id, { enabled })
  }

  /** Set a toggle's state from code. Does not fire `onChange`. */
  setChecked(id: string, checked: boolean): void {
    const entry = this.entries.get(id)
    if (!entry || entry.checked === checked) return
    entry.checked = checked
    this.bundle.invalidate()
  }

  isChecked(id: string): boolean {
    return this.entries.get(id)?.checked ?? false
  }

  /** Flip a toggle as the user would (a keyboard shortcut, say): fires `onChange`. */
  toggle(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.spec.enabled === false) return
    entry.checked = !entry.checked
    this.bundle.invalidate()
    entry.spec.onChange?.(entry.checked, id)
  }

  /** A toggle's box in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): ToggleLayout | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const l = this.entries.layoutOf(entry)
    const k = this.entries.scale
    if (k === 1) return l
    return {
      ...unscaleBox(l, k),
      box: { x: l.box.x / k, y: l.box.y / k, size: l.box.size / k },
    }
  }

  /** The toggle with keyboard focus, if any. */
  get focusedToggle(): string | null {
    return this.focusedId
  }

  /** Give a toggle keyboard focus (Space/Enter flips it), or null to clear. */
  focus(id: string | null): void {
    this.moveFocus(id)
  }

  pointerDown(x: number, y: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    this.pressedId = entry.spec.id
    this.pressInside = true
    this.focus(entry.spec.id)
    this.bundle.invalidate()
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.pressedId !== null) {
      const entry = this.entries.get(this.pressedId)
      if (entry) {
        const inside = toggleContains(this.entries.layoutOf(entry), x, y)
        if (inside !== this.pressInside) {
          this.pressInside = inside
          this.bundle.invalidate()
        }
      }
      return true
    }
    this.setHover(this.hitEntry(x, y))
    return false
  }

  /** Flips the toggle when released inside the one that was pressed. */
  pointerUp(x: number, y: number): boolean {
    const id = this.pressedId
    if (id === null) return false
    this.pressedId = null
    const entry = this.entries.get(id)
    if (entry && toggleContains(this.entries.layoutOf(entry), x, y)) {
      this.toggle(id)
    } else {
      this.bundle.invalidate()
    }
    this.pointerMove(x, y)
    return true
  }

  pointerCancel(): void {
    if (this.pressedId === null) return
    this.pressedId = null
    this.bundle.invalidate()
  }

  /** Space or Enter flips the focused toggle. */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.focusedId === null) return false
    if (e.key !== ' ' && e.key !== 'Enter') return false
    if (!this.entries.enabled(this.focusedId)) return false
    this.toggle(this.focusedId)
    return true
  }

  blur(): void {
    this.focus(null)
  }

  protected *geometry(): Generator<UIKitGeometry> {
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const id = entry.spec.id
      const geo = buildToggle(
        spec,
        style,
        this.font.metrics,
        this.entries.layoutOf(entry),
        {
          checked: entry.checked,
          hover: this.hoverId === id,
          pressed: this.pressedId === id && this.pressInside,
          focused: this.focusedId === id,
          enabled: entry.spec.enabled !== false,
        },
      )
      yield { ...geo, text: [geo.text] }
    }
  }
}
