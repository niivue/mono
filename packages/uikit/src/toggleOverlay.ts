// A UIKit overlay of toggles (check boxes with labels) drawn into the scene
// through the niivue overlay hook. The pointer gives a toggle a hover tint and
// a pressed shrink; releasing inside flips it and fires `onChange`. A toggle
// pressed by the pointer takes keyboard focus (shown as a ring), and Space or
// Enter then flips it. Add it to a `UIKitControls` layer with the other widgets,
// or feed `pointerDown/Move/Up` and `keyDown` yourself from any host.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import type { LineData } from './line'
import { UIKitLineOverlay } from './lineOverlay'
import type { RectData } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import type { UIKitFont } from './text/font'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'
import {
  buildToggle,
  DEFAULT_TOGGLE_STYLE,
  layoutToggle,
  resolveToggleStyle,
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
  hover: boolean
}

export class UIKitToggleOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  readonly hoverCursor = 'pointer'
  private readonly font: UIKitFont
  private readonly rects = new UIKitRectOverlay()
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private readonly entries = new Map<string, ToggleEntry>()
  private baseStyle: ToggleStyle
  private readonly cssUnits: boolean
  private requestRedraw: (() => void) | null
  private scale = 1
  private geometryDirty = true
  private pressedId: string | null = null
  /** While pressed: whether the pointer is currently over the pressed toggle. */
  private pressInside = false
  private hoverId: string | null = null
  private focusedId: string | null = null
  private layer: UIKitRedrawSource | null = null

  constructor(font: UIKitFont, options: UIKitToggleOverlayOptions = {}) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    this.baseStyle = resolveToggleStyle(DEFAULT_TOGGLE_STYLE, options.style)
    this.cssUnits = options.cssUnits ?? false
    this.requestRedraw = options.requestRedraw ?? null
  }

  /** Replace the default style for every toggle (per-spec overrides still win). */
  setDefaultStyle(style: Partial<ToggleStyle>): void {
    this.baseStyle = resolveToggleStyle(DEFAULT_TOGGLE_STYLE, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveToggleStyle(this.baseStyle, entry.spec.style)
      entry.layout = null
    }
    this.invalidate()
  }

  /**
   * Add a toggle, or replace the one with the same id. A replacement keeps the
   * current checked state unless the new spec sets `checked`.
   */
  addToggle(spec: ToggleSpec): void {
    const existing = this.entries.get(spec.id)
    const style = resolveToggleStyle(this.baseStyle, spec.style)
    if (existing) {
      existing.spec = spec
      existing.style = style
      existing.layout = null
      if (spec.checked !== undefined) existing.checked = spec.checked
    } else {
      this.entries.set(spec.id, {
        spec,
        style,
        layout: null,
        checked: spec.checked ?? false,
        hover: false,
      })
    }
    this.invalidate()
  }

  /** Replace the whole toggle set. */
  setToggles(specs: readonly ToggleSpec[]): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) this.removeToggle(id)
    }
    for (const spec of specs) this.addToggle(spec)
  }

  removeToggle(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.pressedId === id) this.pressedId = null
    if (this.hoverId === id) this.hoverId = null
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
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
    this.invalidate()
  }

  isChecked(id: string): boolean {
    return this.entries.get(id)?.checked ?? false
  }

  /** Flip a toggle as the user would (a keyboard shortcut, say): fires `onChange`. */
  toggle(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.spec.enabled === false) return
    entry.checked = !entry.checked
    this.invalidate()
    entry.spec.onChange?.(entry.checked, id)
  }

  /** The ids of all toggles, in draw order. */
  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /** A toggle's box in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): ToggleLayout | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const l = this.layoutOf(entry)
    const k = this.scale
    if (k === 1) return l
    return {
      x: l.x / k,
      y: l.y / k,
      width: l.width / k,
      height: l.height / k,
      box: { x: l.box.x / k, y: l.box.y / k, size: l.box.size / k },
    }
  }

  /** The toggle with keyboard focus, if any. */
  get focusedToggle(): string | null {
    return this.focusedId
  }

  /** Give a toggle keyboard focus (Space/Enter flips it), or null to clear. */
  focus(id: string | null): void {
    const entry = id !== null ? this.entries.get(id) : undefined
    const next = entry && entry.spec.enabled !== false ? id : null
    if (next === this.focusedId) return
    this.focusedId = next
    if (next !== null) this.layer?.focus?.(this)
    this.invalidate()
  }

  hitTest(x: number, y: number): boolean {
    return this.hitEntry(x, y) !== null
  }

  pointerDown(x: number, y: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    this.pressedId = entry.spec.id
    this.pressInside = true
    this.focus(entry.spec.id)
    this.invalidate()
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.pressedId !== null) {
      const entry = this.entries.get(this.pressedId)
      if (entry) {
        const inside = toggleContains(this.layoutOf(entry), x, y)
        if (inside !== this.pressInside) {
          this.pressInside = inside
          this.invalidate()
        }
      }
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
    return false
  }

  /** Flips the toggle when released inside the one that was pressed. */
  pointerUp(x: number, y: number): boolean {
    const id = this.pressedId
    if (id === null) return false
    this.pressedId = null
    const entry = this.entries.get(id)
    if (entry && toggleContains(this.layoutOf(entry), x, y)) {
      this.toggle(id)
    } else {
      this.invalidate()
    }
    this.pointerMove(x, y)
    return true
  }

  pointerCancel(): void {
    if (this.pressedId === null) return
    this.pressedId = null
    this.invalidate()
  }

  /** Space or Enter flips the focused toggle. */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.focusedId === null) return false
    if (e.key !== ' ' && e.key !== 'Enter') return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false) return false
    this.toggle(this.focusedId)
    return true
  }

  blur(): void {
    this.focus(null)
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.requestRedraw ??= () => layer.requestRedraw()
    this.layer = layer
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.entries.size === 0) return
    const scale = this.cssUnits ? frame.dpr : 1
    if (scale !== this.scale) {
      this.scale = scale
      for (const entry of this.entries.values()) entry.layout = null
      this.geometryDirty = true
    }
    if (this.geometryDirty) this.rebuild()
    this.rects.drawOverlay(frame)
    this.lines.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.rects.destroy()
    this.lines.destroy()
    this.labels.destroy()
  }

  private invalidate(): void {
    this.geometryDirty = true
    this.requestRedraw?.()
  }

  private scaled(entry: ToggleEntry): { spec: ToggleSpec; style: ToggleStyle } {
    return scaleToggle(entry.spec, entry.style, this.scale)
  }

  private layoutOf(entry: ToggleEntry): ToggleLayout {
    if (!entry.layout) {
      const { spec, style } = this.scaled(entry)
      entry.layout = layoutToggle(spec, style, this.font.metrics)
    }
    return entry.layout
  }

  /** The topmost (last added) enabled toggle under a canvas point. */
  private hitEntry(x: number, y: number): ToggleEntry | null {
    const list = [...this.entries.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry.spec.enabled === false) continue
      if (toggleContains(this.layoutOf(entry), x, y)) return entry
    }
    return null
  }

  private rebuild(): void {
    const rects: RectData[] = []
    const lines: LineData[] = []
    const text: UIKitTextItem[] = []
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const id = entry.spec.id
      const geo = buildToggle(
        spec,
        style,
        this.font.metrics,
        this.layoutOf(entry),
        {
          checked: entry.checked,
          hover: entry.hover,
          pressed: this.pressedId === id && this.pressInside,
          focused: this.focusedId === id,
          enabled: entry.spec.enabled !== false,
        },
      )
      rects.push(...geo.rects)
      lines.push(...geo.lines)
      text.push(geo.text)
    }
    this.rects.setRects(rects)
    this.lines.setLines(lines)
    this.labels.setItems(text)
    this.geometryDirty = false
  }
}
