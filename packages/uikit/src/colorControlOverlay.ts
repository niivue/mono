// A UIKit overlay of color controls drawn into the scene through the niivue
// overlay hook. Each control shows a preview swatch, channel sliders (R, G, B
// and optionally A, composed from a private slider overlay) and a row of
// named palette swatches. Dragging a slider or pressing an arrow key on the
// focused one changes a channel; pressing a swatch sets the whole color.
// `onInput` fires on every change and `onChange` once per committed one.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import {
  buildColorControl,
  COLOR_CHANNELS,
  type ColorChannel,
  type ColorControlLayout,
  type ColorControlSpec,
  type ColorControlStyle,
  colorControlContains,
  colorSwatchAt,
  colorsEqual,
  DEFAULT_COLOR_CONTROL_STYLE,
  layoutColorControl,
  resolveColorControlStyle,
  scaleColorControl,
  withChannel,
} from './colorControl'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import { UIKitRectOverlay } from './rectOverlay'
import { UIKitSliderOverlay } from './sliderOverlay'
import type { UIKitFont } from './text/font'
import type { RGBA } from './text/layout'
import { UIKitTextOverlay } from './textOverlay'

export interface UIKitColorControlOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every control; a spec's `style` overrides per key. */
  style?: Partial<ColorControlStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
}

interface ColorEntry {
  spec: ColorControlSpec
  style: ColorControlStyle
  /** Boxes in canvas pixels, for the scale they were laid out at. */
  layout: ColorControlLayout | null
  value: RGBA
  hoverSwatch: number
}

/** The slider id for one channel of one control. */
function sliderId(id: string, channel: ColorChannel): string {
  return `${id}\u0000${channel}`
}

export class UIKitColorControlOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  readonly hoverCursor = 'pointer'
  private readonly font: UIKitFont
  private readonly rects = new UIKitRectOverlay()
  private readonly labels: UIKitTextOverlay
  /** The channel sliders of every control, placed in spec units. */
  private readonly sliders: UIKitSliderOverlay
  private readonly entries = new Map<string, ColorEntry>()
  private baseStyle: ColorControlStyle
  private readonly cssUnits: boolean
  private requestRedraw: (() => void) | null
  private scale = 1
  private geometryDirty = true
  /** The control whose slider holds the pointer. */
  private draggingId: string | null = null
  private focusedId: string | null = null

  constructor(font: UIKitFont, options: UIKitColorControlOverlayOptions = {}) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    this.baseStyle = resolveColorControlStyle(
      DEFAULT_COLOR_CONTROL_STYLE,
      options.style,
    )
    this.cssUnits = options.cssUnits ?? false
    this.requestRedraw = options.requestRedraw ?? null
    this.sliders = new UIKitSliderOverlay(font, {
      requestRedraw: () => this.requestRedraw?.(),
      cssUnits: this.cssUnits,
    })
  }

  /** Replace the default style for every control (per-spec overrides still win). */
  setDefaultStyle(style: Partial<ColorControlStyle>): void {
    this.baseStyle = resolveColorControlStyle(
      DEFAULT_COLOR_CONTROL_STYLE,
      style,
    )
    for (const entry of this.entries.values()) {
      entry.style = resolveColorControlStyle(this.baseStyle, entry.spec.style)
      entry.layout = null
      this.placeSliders(entry)
    }
    this.invalidate()
  }

  /** Add a control, or replace the one with the same id (keeping its color). */
  addColorControl(spec: ColorControlSpec): void {
    const existing = this.entries.get(spec.id)
    const style = resolveColorControlStyle(this.baseStyle, spec.style)
    let entry: ColorEntry
    if (existing) {
      existing.spec = spec
      existing.style = style
      existing.layout = null
      entry = existing
    } else {
      entry = {
        spec,
        style,
        layout: null,
        value: [spec.value[0], spec.value[1], spec.value[2], spec.value[3]],
        hoverSwatch: -1,
      }
      this.entries.set(spec.id, entry)
    }
    this.placeSliders(entry)
    this.invalidate()
  }

  setColorControls(specs: readonly ColorControlSpec[]): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) this.removeColorControl(id)
    }
    for (const spec of specs) this.addColorControl(spec)
  }

  removeColorControl(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    for (const c of COLOR_CHANNELS) this.sliders.removeSlider(sliderId(id, c))
    this.entries.delete(id)
    if (this.draggingId === id) {
      this.sliders.pointerCancel()
      this.draggingId = null
    }
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
  }

  /** Patch one control's spec (label, position, palette, callbacks, ...). */
  updateColorControl(
    id: string,
    patch: Partial<Omit<ColorControlSpec, 'id'>>,
  ): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.addColorControl({ ...entry.spec, ...patch, id })
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateColorControl(id, { enabled })
  }

  /** Set a control's color without firing its callbacks. */
  setValue(id: string, color: RGBA): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.value = [color[0], color[1], color[2], color[3]]
    this.syncSliders(entry)
    this.invalidate()
  }

  getValue(id: string): RGBA | undefined {
    const entry = this.entries.get(id)
    return entry
      ? [entry.value[0], entry.value[1], entry.value[2], entry.value[3]]
      : undefined
  }

  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /** A control's boxes in spec units, or null for an unknown id. */
  getLayout(id: string): ColorControlLayout | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    return layoutColorControl(entry.spec, entry.style, this.font.metrics)
  }

  /** The control whose slider has keyboard focus, if any. */
  get focusedControl(): string | null {
    return this.focusedId
  }

  hitTest(x: number, y: number): boolean {
    if (this.sliders.hitTest(x, y)) return true
    return this.swatchHit(x, y) !== null
  }

  pointerDown(x: number, y: number): boolean {
    if (this.sliders.pointerDown(x, y)) {
      const id = this.sliders.focusedSlider
      this.draggingId = id === null ? null : ownerOf(id)
      this.focusedId = this.draggingId
      return true
    }
    const hit = this.swatchHit(x, y)
    if (!hit) return false
    const { entry, index } = hit
    const color = entry.spec.palette?.[index]?.color
    if (!color) return false
    this.sliders.blur()
    this.focusedId = null
    if (!colorsEqual(entry.value, color)) {
      entry.value = [color[0], color[1], color[2], color[3]]
      this.syncSliders(entry)
      this.invalidate()
      entry.spec.onInput?.(this.getValueOf(entry), entry.spec.id)
      entry.spec.onChange?.(this.getValueOf(entry), entry.spec.id)
    }
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.draggingId !== null) {
      this.sliders.pointerMove(x, y)
      return true
    }
    this.sliders.pointerMove(x, y)
    let changed = false
    for (const entry of this.entries.values()) {
      const layout = this.layoutOf(entry)
      const i = entry.spec.enabled === false ? -1 : colorSwatchAt(layout, x, y)
      if (i !== entry.hoverSwatch) {
        entry.hoverSwatch = i
        changed = true
      }
    }
    if (changed) this.invalidate()
    return this.hitTest(x, y)
  }

  pointerUp(x: number, y: number): boolean {
    if (this.draggingId === null) return false
    this.draggingId = null
    this.sliders.pointerUp(x, y)
    return true
  }

  pointerCancel(): void {
    if (this.draggingId === null) return
    this.draggingId = null
    this.sliders.pointerCancel()
  }

  /** Arrow keys, Home, End and Page keys move the focused channel slider. */
  keyDown(e: UIKitKeyEvent): boolean {
    return this.sliders.keyDown(e)
  }

  blur(): void {
    this.sliders.blur()
    this.focusedId = null
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.requestRedraw ??= () => layer.requestRedraw()
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
    this.sliders.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.rects.destroy()
    this.labels.destroy()
    this.sliders.destroy()
  }

  private invalidate(): void {
    this.geometryDirty = true
    this.requestRedraw?.()
  }

  private rebuild(): void {
    const rects = []
    const text = []
    for (const entry of this.entries.values()) {
      const { spec, style } = scaleColorControl(
        entry.spec,
        entry.style,
        this.scale,
      )
      const geo = buildColorControl(spec, style, this.layoutOf(entry), {
        value: entry.value,
        hoverSwatch: entry.hoverSwatch,
        enabled: spec.enabled !== false,
      })
      rects.push(...geo.rects)
      text.push(...geo.text)
    }
    this.rects.setRects(rects)
    this.labels.setItems(text)
    this.geometryDirty = false
  }

  private getValueOf(entry: ColorEntry): RGBA {
    return [entry.value[0], entry.value[1], entry.value[2], entry.value[3]]
  }

  private layoutOf(entry: ColorEntry): ColorControlLayout {
    if (!entry.layout) {
      const { spec, style } = scaleColorControl(
        entry.spec,
        entry.style,
        this.scale,
      )
      entry.layout = layoutColorControl(spec, style, this.font.metrics)
    }
    return entry.layout
  }

  private swatchHit(
    x: number,
    y: number,
  ): { entry: ColorEntry; index: number } | null {
    for (const entry of this.entries.values()) {
      if (entry.spec.enabled === false) continue
      const layout = this.layoutOf(entry)
      if (!colorControlContains(layout, x, y)) continue
      const index = colorSwatchAt(layout, x, y)
      if (index >= 0) return { entry, index }
    }
    return null
  }

  /** Create or move the channel sliders of a control, in spec units. */
  private placeSliders(entry: ColorEntry): void {
    const spec = entry.spec
    const layout = layoutColorControl(spec, entry.style, this.font.metrics)
    const present = new Set(layout.channels.map((r) => r.channel))
    for (const c of COLOR_CHANNELS) {
      if (!present.has(c)) this.sliders.removeSlider(sliderId(spec.id, c))
    }
    for (const row of layout.channels) {
      const channel = row.channel
      this.sliders.addSlider({
        id: sliderId(spec.id, channel),
        x: row.slider.x,
        y: row.slider.y,
        width: row.slider.width,
        min: 0,
        max: 1,
        step: 0.01,
        value: entry.value[COLOR_CHANNELS.indexOf(channel)],
        enabled: spec.enabled,
        style: entry.style.slider,
        onInput: (v) => {
          entry.value = withChannel(entry.value, channel, v)
          this.invalidate()
          spec.onInput?.(this.getValueOf(entry), spec.id)
        },
        onChange: () => spec.onChange?.(this.getValueOf(entry), spec.id),
      })
    }
  }

  /** Push a control's color into its sliders without firing callbacks. */
  private syncSliders(entry: ColorEntry): void {
    for (const c of COLOR_CHANNELS) {
      this.sliders.setValue(
        sliderId(entry.spec.id, c),
        entry.value[COLOR_CHANNELS.indexOf(c)],
      )
    }
  }
}

/** The control id a channel slider id belongs to. */
function ownerOf(id: string): string {
  const i = id.indexOf('\u0000')
  return i < 0 ? id : id.slice(0, i)
}
