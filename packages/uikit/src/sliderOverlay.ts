// A UIKit overlay of sliders drawn into the scene through the niivue overlay
// hook. Pressing anywhere on a slider jumps the thumb there and starts a drag;
// the drag owns the pointer until release. A pressed slider takes keyboard
// focus (shown as a ring on the thumb); the arrow keys then step it, Shift or
// PageUp/PageDown step by ten, Home/End jump to the ends. `onInput` fires for
// every change, `onChange` once per committed interaction. Add it to a
// `UIKitControls` layer with the other widgets, or feed `pointerDown/Move/Up`
// and `keyDown` yourself from any host.

import type { UIKitKeyEvent } from './controls'
import {
  UIKitEntryOverlay,
  type UIKitEntryOverlayOptions,
  type UIKitGeometry,
} from './overlayParts'
import { unscaleBox } from './rect'
import {
  buildSlider,
  DEFAULT_SLIDER_STYLE,
  layoutSlider,
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

export interface UIKitSliderOverlayOptions
  extends UIKitEntryOverlayOptions<SliderStyle> {}

interface SliderEntry {
  spec: SliderSpec
  style: SliderStyle
  layout: SliderLayout | null
  value: number
}

const MODEL = {
  defaultStyle: DEFAULT_SLIDER_STYLE,
  scale: scaleSlider,
  layout: layoutSlider,
  contains: sliderContains,
  unscale: (l: SliderLayout, k: number): SliderLayout => ({
    ...unscaleBox(l, k),
    track: unscaleBox(l.track, k),
    rail: { x0: l.rail.x0 / k, x1: l.rail.x1 / k, cy: l.rail.cy / k },
    labelBaseline: l.labelBaseline === null ? null : l.labelBaseline / k,
  }),
}

export class UIKitSliderOverlay extends UIKitEntryOverlay<
  SliderSpec,
  SliderStyle,
  SliderLayout,
  SliderEntry
> {
  readonly hoverCursor = 'pointer'
  /** The value when the drag started, to decide whether release fires onChange. */
  private dragStartValue = 0

  constructor(font: UIKitFont, options: UIKitSliderOverlayOptions = {}) {
    super(font, MODEL, options)
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
    const value = snapValue(spec.value, spec.min, spec.max, spec.step)
    const existing = this.upsert(spec, (style) => ({
      spec,
      style,
      layout: null,
      value,
    }))
    if (existing) {
      existing.value = value
      // Disabling ends a drag as a cancel does, with its onChange, and
      // drops focus.
      if (spec.enabled === false) {
        if (this.pressedId === spec.id) this.endDrag()
        if (this.focusedId === spec.id) this.focusedId = null
      }
    }
    this.invalidate()
  }

  /** Replace the whole slider set. */
  setSliders(specs: readonly SliderSpec[]): void {
    this.replaceAll(specs, (spec) => this.addSlider(spec))
  }

  removeSlider(id: string): void {
    this.remove(id)
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
    this.bundle.invalidate()
  }

  getValue(id: string): number | undefined {
    return this.entries.get(id)?.value
  }

  /** The slider with keyboard focus, if any. */
  get focusedSlider(): string | null {
    return this.focusedId
  }

  /** True while a thumb is being dragged. */
  get isDragging(): boolean {
    return this.pressedId !== null
  }

  /** Jumps the thumb to the pointer and starts a drag. */
  pointerDown(x: number, y: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    this.pressedId = entry.spec.id
    this.dragStartValue = entry.value
    this.focus(entry.spec.id)
    this.setFromPointer(entry, x)
    this.bundle.invalidate()
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.pressedId !== null) {
      const entry = this.entries.get(this.pressedId)
      if (entry) this.setFromPointer(entry, x)
      return true
    }
    this.setHover(this.hitEntry(x, y))
    return false
  }

  /** Ends the drag; fires `onChange` if the value moved since the press. */
  pointerUp(x: number, y: number): boolean {
    if (this.pressedId === null) return false
    const entry = this.entries.get(this.pressedId)
    if (entry) this.setFromPointer(entry, x)
    this.endDrag()
    this.pointerMove(x, y)
    return true
  }

  /** Ends the drag where it is; fires `onChange` if the value moved. */
  pointerCancel(): void {
    if (this.pressedId === null) return
    this.endDrag()
  }

  /**
   * Arrow keys step the focused slider (Shift: ten steps), PageUp/PageDown
   * step by ten, Home/End jump to the ends.
   */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.focusedId === null) return false
    const entry = this.entries.enabled(this.focusedId)
    if (!entry) return false
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
      this.bundle.invalidate()
      spec.onInput?.(next, spec.id)
      spec.onChange?.(next, spec.id)
    }
    return true
  }

  private endDrag(): void {
    const id = this.pressedId
    this.pressedId = null
    this.bundle.invalidate()
    const entry = id !== null ? this.entries.get(id) : undefined
    if (entry && entry.value !== this.dragStartValue) {
      entry.spec.onChange?.(entry.value, entry.spec.id)
    }
  }

  /** Set an entry's value from a pointer x, firing onInput when it changes. */
  private setFromPointer(entry: SliderEntry, x: number): void {
    const v = sliderValueAt(this.entries.layoutOf(entry), entry.spec, x)
    if (v === entry.value) return
    entry.value = v
    this.bundle.invalidate()
    entry.spec.onInput?.(v, entry.spec.id)
  }

  protected *geometry(): Generator<UIKitGeometry> {
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const id = entry.spec.id
      yield buildSlider(spec, style, this.entries.layoutOf(entry), {
        value: entry.value,
        hover: this.hoverId === id,
        active: this.pressedId === id,
        focused: this.focusedId === id,
        enabled: entry.spec.enabled !== false,
      })
    }
  }
}
