// A UIKit overlay of sliders drawn into the scene through the niivue overlay
// hook. Pressing anywhere on a slider jumps the thumb there and starts a drag;
// the drag owns the pointer until release. A pressed slider takes keyboard
// focus (shown as a ring on the thumb); the arrow keys then step it, Shift or
// PageUp/PageDown step by ten, Home/End jump to the ends. `onInput` fires for
// every change, `onChange` once per committed interaction. Add it to a
// `UIKitControls` layer with the other widgets, or feed `pointerDown/Move/Up`
// and `keyDown` yourself from any host.

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
import {
  buildSlider,
  DEFAULT_SLIDER_STYLE,
  layoutSlider,
  resolveSliderStyle,
  type SliderLayout,
  type SliderSpec,
  type SliderStyle,
  scaleSlider,
  sliderContains,
  sliderValueAt,
  snapValue,
  stepValue,
} from './slider'
import type { UIKitFont } from './text/font'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'

export interface UIKitSliderOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every slider; a spec's `style` overrides per key. */
  style?: Partial<SliderStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
}

interface SliderEntry {
  spec: SliderSpec
  style: SliderStyle
  layout: SliderLayout | null
  value: number
  hover: boolean
}

export class UIKitSliderOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  readonly hoverCursor = 'pointer'
  private readonly font: UIKitFont
  private readonly rects = new UIKitRectOverlay()
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private readonly entries = new Map<string, SliderEntry>()
  private baseStyle: SliderStyle
  private readonly cssUnits: boolean
  private requestRedraw: (() => void) | null
  private scale = 1
  private geometryDirty = true
  private dragId: string | null = null
  /** The value when the drag started, to decide whether release fires onChange. */
  private dragStartValue = 0
  private hoverId: string | null = null
  private focusedId: string | null = null
  private layer: UIKitRedrawSource | null = null

  constructor(font: UIKitFont, options: UIKitSliderOverlayOptions = {}) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    this.baseStyle = resolveSliderStyle(DEFAULT_SLIDER_STYLE, options.style)
    this.cssUnits = options.cssUnits ?? false
    this.requestRedraw = options.requestRedraw ?? null
  }

  /** Replace the default style for every slider (per-spec overrides still win). */
  setDefaultStyle(style: Partial<SliderStyle>): void {
    this.baseStyle = resolveSliderStyle(DEFAULT_SLIDER_STYLE, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveSliderStyle(this.baseStyle, entry.spec.style)
      entry.layout = null
    }
    this.invalidate()
  }

  /**
   * Add a slider, or replace the one with the same id. The spec's `value` is
   * snapped to its range and step; a replacement takes the new spec's value.
   */
  addSlider(spec: SliderSpec): void {
    if (!Number.isFinite(spec.min) || !Number.isFinite(spec.max)) {
      throw new RangeError(
        `UIKit: slider "${spec.id}" needs finite min and max`,
      )
    }
    const existing = this.entries.get(spec.id)
    const style = resolveSliderStyle(this.baseStyle, spec.style)
    const value = snapValue(spec.value, spec.min, spec.max, spec.step)
    if (existing) {
      existing.spec = spec
      existing.style = style
      existing.layout = null
      existing.value = value
      // Disabling ends a drag as a cancel does, with its onChange, and
      // drops focus.
      if (spec.enabled === false) {
        if (this.dragId === spec.id) this.endDrag()
        if (this.focusedId === spec.id) this.focusedId = null
      }
    } else {
      this.entries.set(spec.id, {
        spec,
        style,
        layout: null,
        value,
        hover: false,
      })
    }
    this.invalidate()
  }

  /** Replace the whole slider set. */
  setSliders(specs: readonly SliderSpec[]): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) this.removeSlider(id)
    }
    for (const spec of specs) this.addSlider(spec)
  }

  removeSlider(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.dragId === id) this.dragId = null
    if (this.hoverId === id) this.hoverId = null
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
  }

  /**
   * Patch one slider's spec (label, position, range, step, enabled, ...). The
   * current value is kept (re-snapped to the new range) unless the patch sets
   * `value`.
   */
  updateSlider(id: string, patch: Partial<Omit<SliderSpec, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const value = patch.value ?? entry.value
    this.addSlider({ ...entry.spec, ...patch, id, value })
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateSlider(id, { enabled })
  }

  /** Set a slider's value from code (snapped). Fires neither callback. */
  setValue(id: string, value: number): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const v = snapValue(value, entry.spec.min, entry.spec.max, entry.spec.step)
    if (v === entry.value) return
    entry.value = v
    this.invalidate()
  }

  getValue(id: string): number | undefined {
    return this.entries.get(id)?.value
  }

  /** The ids of all sliders, in draw order. */
  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /** A slider's box in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): SliderLayout | null {
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
      track: {
        x: l.track.x / k,
        y: l.track.y / k,
        width: l.track.width / k,
        height: l.track.height / k,
      },
      rail: { x0: l.rail.x0 / k, x1: l.rail.x1 / k, cy: l.rail.cy / k },
      labelBaseline: l.labelBaseline === null ? null : l.labelBaseline / k,
    }
  }

  /** The slider with keyboard focus, if any. */
  get focusedSlider(): string | null {
    return this.focusedId
  }

  /** Give a slider keyboard focus, or null to clear. Disabled sliders refuse. */
  focus(id: string | null): void {
    const entry = id !== null ? this.entries.get(id) : undefined
    const next = entry && entry.spec.enabled !== false ? id : null
    if (next === this.focusedId) return
    this.focusedId = next
    if (next !== null) this.layer?.focus?.(this)
    this.invalidate()
  }

  /** True while a thumb is being dragged. */
  get isDragging(): boolean {
    return this.dragId !== null
  }

  hitTest(x: number, y: number): boolean {
    return this.hitEntry(x, y) !== null
  }

  /** Jumps the thumb to the pointer and starts a drag. */
  pointerDown(x: number, y: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    this.dragId = entry.spec.id
    this.dragStartValue = entry.value
    this.focus(entry.spec.id)
    this.setFromPointer(entry, x)
    this.invalidate()
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.dragId !== null) {
      const entry = this.entries.get(this.dragId)
      if (entry) this.setFromPointer(entry, x)
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

  /** Ends the drag; fires `onChange` if the value moved since the press. */
  pointerUp(x: number, y: number): boolean {
    if (this.dragId === null) return false
    const entry = this.entries.get(this.dragId)
    if (entry) this.setFromPointer(entry, x)
    this.endDrag()
    this.pointerMove(x, y)
    return true
  }

  /** Ends the drag where it is; fires `onChange` if the value moved. */
  pointerCancel(): void {
    if (this.dragId === null) return
    this.endDrag()
  }

  /**
   * Arrow keys step the focused slider (Shift: ten steps), PageUp/PageDown
   * step by ten, Home/End jump to the ends.
   */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.focusedId === null) return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false) return false
    const spec = entry.spec
    let next: number
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = stepValue(entry.value, spec, -1, e.shiftKey)
        break
      case 'ArrowRight':
      case 'ArrowUp':
        next = stepValue(entry.value, spec, 1, e.shiftKey)
        break
      case 'PageDown':
        next = stepValue(entry.value, spec, -1, true)
        break
      case 'PageUp':
        next = stepValue(entry.value, spec, 1, true)
        break
      case 'Home':
        next = snapValue(spec.min, spec.min, spec.max, spec.step)
        break
      case 'End':
        next = snapValue(spec.max, spec.min, spec.max, spec.step)
        break
      default:
        return false
    }
    if (next !== entry.value) {
      entry.value = next
      this.invalidate()
      spec.onInput?.(next, spec.id)
      spec.onChange?.(next, spec.id)
    }
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

  private endDrag(): void {
    const id = this.dragId
    this.dragId = null
    this.invalidate()
    const entry = id !== null ? this.entries.get(id) : undefined
    if (entry && entry.value !== this.dragStartValue) {
      entry.spec.onChange?.(entry.value, entry.spec.id)
    }
  }

  /** Set an entry's value from a pointer x, firing onInput when it changes. */
  private setFromPointer(entry: SliderEntry, x: number): void {
    const v = sliderValueAt(this.layoutOf(entry), entry.spec, x)
    if (v === entry.value) return
    entry.value = v
    this.invalidate()
    entry.spec.onInput?.(v, entry.spec.id)
  }

  private scaled(entry: SliderEntry): { spec: SliderSpec; style: SliderStyle } {
    return scaleSlider(entry.spec, entry.style, this.scale)
  }

  private layoutOf(entry: SliderEntry): SliderLayout {
    if (!entry.layout) {
      const { spec, style } = this.scaled(entry)
      entry.layout = layoutSlider(spec, style, this.font.metrics)
    }
    return entry.layout
  }

  /** The topmost (last added) enabled slider under a canvas point. */
  private hitEntry(x: number, y: number): SliderEntry | null {
    const list = [...this.entries.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry.spec.enabled === false) continue
      if (sliderContains(this.layoutOf(entry), x, y)) return entry
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
      const geo = buildSlider(spec, style, this.layoutOf(entry), {
        value: entry.value,
        hover: entry.hover,
        active: this.dragId === id,
        focused: this.focusedId === id,
        enabled: entry.spec.enabled !== false,
      })
      rects.push(...geo.rects)
      lines.push(...geo.lines)
      text.push(...geo.text)
    }
    this.rects.setRects(rects)
    this.lines.setLines(lines)
    this.labels.setItems(text)
    this.geometryDirty = false
  }
}
