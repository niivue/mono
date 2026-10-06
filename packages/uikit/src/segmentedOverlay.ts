// A UIKit overlay of segmented controls drawn into the scene through the
// niivue overlay hook. The pointer tints the segment it is over, pressing
// darkens it, and releasing on the segment the press started on selects it and
// fires `onChange`. A pressed control takes keyboard focus (a ring around the
// track); ArrowLeft/Right (or Up/Down) then move the selection through the
// enabled segments, wrapping, and Home and End jump to the ends. Add it to a
// `UIKitControls` layer with the other widgets, or feed the pointer and key
// entry points yourself from any host.

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
  buildSegmented,
  DEFAULT_SEGMENTED_STYLE,
  endSegmentValue,
  layoutSegmented,
  resolveSegmentedStyle,
  type SegmentedLayout,
  type SegmentedSpec,
  type SegmentedStyle,
  type SegmentSpec,
  scaleSegmented,
  segmentAt,
  segmentIndex,
  stepSegmentValue,
} from './segmented'
import type { UIKitFont } from './text/font'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'

export interface UIKitSegmentedOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every control; a spec's `style` overrides per key. */
  style?: Partial<SegmentedStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
}

interface SegmentedEntry {
  spec: SegmentedSpec
  style: SegmentedStyle
  layout: SegmentedLayout | null
  value: string | null
  /** Index of the segment under the pointer, or -1. */
  hover: number
}

export class UIKitSegmentedOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  readonly hoverCursor = 'pointer'
  private readonly font: UIKitFont
  private readonly rects = new UIKitRectOverlay()
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private readonly entries = new Map<string, SegmentedEntry>()
  private baseStyle: SegmentedStyle
  private readonly cssUnits: boolean
  private requestRedraw: (() => void) | null
  private scale = 1
  private geometryDirty = true
  private pressedId: string | null = null
  /** Index of the segment the press started on. */
  private pressedIndex = -1
  /** While pressed: whether the pointer is over the pressed segment. */
  private pressInside = false
  private hoverId: string | null = null
  private focusedId: string | null = null

  constructor(font: UIKitFont, options: UIKitSegmentedOverlayOptions = {}) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    this.baseStyle = resolveSegmentedStyle(
      DEFAULT_SEGMENTED_STYLE,
      options.style,
    )
    this.cssUnits = options.cssUnits ?? false
    this.requestRedraw = options.requestRedraw ?? null
  }

  /** Replace the default style for every control (per-spec overrides still win). */
  setDefaultStyle(style: Partial<SegmentedStyle>): void {
    this.baseStyle = resolveSegmentedStyle(DEFAULT_SEGMENTED_STYLE, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveSegmentedStyle(this.baseStyle, entry.spec.style)
      entry.layout = null
    }
    this.invalidate()
  }

  /**
   * Add a control, or replace the one with the same id. A replacement takes
   * the new spec's value; a value no segment holds clears the selection.
   */
  addSegmented(spec: SegmentedSpec): void {
    const style = resolveSegmentedStyle(this.baseStyle, spec.style)
    const value =
      segmentIndex(spec.segments, spec.value) >= 0 ? spec.value : null
    const existing = this.entries.get(spec.id)
    if (existing) {
      existing.spec = spec
      existing.style = style
      existing.layout = null
      existing.value = value
      existing.hover = -1
    } else {
      this.entries.set(spec.id, { spec, style, layout: null, value, hover: -1 })
    }
    this.invalidate()
  }

  /** Replace the whole control set. */
  setSegmenteds(specs: readonly SegmentedSpec[]): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) this.removeSegmented(id)
    }
    for (const spec of specs) this.addSegmented(spec)
  }

  removeSegmented(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.pressedId === id) this.pressedId = null
    if (this.hoverId === id) this.hoverId = null
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
  }

  /** Patch one control's spec. The value is kept unless the patch sets `value`. */
  updateSegmented(id: string, patch: Partial<Omit<SegmentedSpec, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const value = 'value' in patch ? (patch.value ?? null) : entry.value
    this.addSegmented({ ...entry.spec, ...patch, id, value })
    if (entry.spec.enabled === false) {
      if (this.pressedId === id) this.pressedId = null
      if (this.focusedId === id) this.focusedId = null
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateSegmented(id, { enabled })
  }

  /** Replace a control's segments. A value no longer offered clears. */
  setSegments(id: string, segments: readonly SegmentSpec[]): void {
    this.updateSegmented(id, { segments })
  }

  getSegments(id: string): readonly SegmentSpec[] {
    return this.entries.get(id)?.spec.segments ?? []
  }

  /** Set a control's value from code. Does not fire `onChange`. Unknown values clear it. */
  setValue(id: string, value: string | null): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const next = segmentIndex(entry.spec.segments, value) >= 0 ? value : null
    if (next === entry.value) return
    entry.value = next
    this.invalidate()
  }

  getValue(id: string): string | null {
    return this.entries.get(id)?.value ?? null
  }

  /** Select a segment as the user would (a keyboard shortcut, say): fires `onChange`. */
  select(id: string, value: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.spec.enabled === false) return
    const seg = entry.spec.segments.find((s) => s.value === value)
    if (!seg || seg.enabled === false || value === entry.value) return
    entry.value = value
    this.invalidate()
    entry.spec.onChange?.(value, id)
  }

  /** The ids of all controls, in draw order. */
  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /** A control's track and segments in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): SegmentedLayout | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const l = this.layoutOf(entry)
    const k = this.scale
    if (k === 1) return l
    const s = (r: { x: number; y: number; width: number; height: number }) => ({
      x: r.x / k,
      y: r.y / k,
      width: r.width / k,
      height: r.height / k,
    })
    return {
      ...s(l),
      segments: l.segments.map((seg) => ({ index: seg.index, ...s(seg) })),
    }
  }

  /** The control with keyboard focus, if any. */
  get focusedSegmented(): string | null {
    return this.focusedId
  }

  /** Give a control keyboard focus (arrows move the selection), or null to clear. */
  focus(id: string | null): void {
    const entry = id !== null ? this.entries.get(id) : undefined
    const next = entry && entry.spec.enabled !== false ? id : null
    if (next === this.focusedId) return
    this.focusedId = next
    this.invalidate()
  }

  hitTest(x: number, y: number): boolean {
    return this.hitEntry(x, y) !== null
  }

  /** Presses the segment under the pointer (disabled segments still take focus). */
  pointerDown(x: number, y: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    const index = segmentAt(this.layoutOf(entry), x, y)
    this.pressedId = entry.spec.id
    this.pressedIndex = this.segmentEnabled(entry, index) ? index : -1
    this.pressInside = this.pressedIndex >= 0
    this.focus(entry.spec.id)
    this.invalidate()
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.pressedId !== null) {
      const entry = this.entries.get(this.pressedId)
      if (entry && this.pressedIndex >= 0) {
        const inside =
          segmentAt(this.layoutOf(entry), x, y) === this.pressedIndex
        if (inside !== this.pressInside) {
          this.pressInside = inside
          this.invalidate()
        }
      }
      return true
    }
    const hit = this.hitEntry(x, y)
    const id = hit ? hit.spec.id : null
    const index = hit ? segmentAt(this.layoutOf(hit), x, y) : -1
    let changed = false
    if (id !== this.hoverId) {
      const prev = this.hoverId ? this.entries.get(this.hoverId) : null
      if (prev) prev.hover = -1
      this.hoverId = id
      changed = true
    }
    if (hit && hit.hover !== index) {
      hit.hover = index
      changed = true
    }
    if (changed) this.invalidate()
    return false
  }

  /** Selects the pressed segment when released over it. */
  pointerUp(x: number, y: number): boolean {
    const id = this.pressedId
    if (id === null) return false
    const index = this.pressedIndex
    this.pressedId = null
    this.pressedIndex = -1
    const entry = this.entries.get(id)
    if (
      entry &&
      index >= 0 &&
      segmentAt(this.layoutOf(entry), x, y) === index
    ) {
      this.select(id, entry.spec.segments[index].value)
    }
    this.invalidate()
    this.pointerMove(x, y)
    return true
  }

  pointerCancel(): void {
    if (this.pressedId === null) return
    this.pressedId = null
    this.pressedIndex = -1
    this.invalidate()
  }

  /** Arrows move the focused control's selection (wrapping); Home and End jump to the ends. */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.focusedId === null) return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false) return false
    const segments = entry.spec.segments
    let next: string | null
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = stepSegmentValue(segments, entry.value, 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = stepSegmentValue(segments, entry.value, -1)
        break
      case 'Home':
        next = endSegmentValue(segments, entry.value, 'first')
        break
      case 'End':
        next = endSegmentValue(segments, entry.value, 'last')
        break
      default:
        return false
    }
    if (next !== null && next !== entry.value) this.select(this.focusedId, next)
    return true
  }

  blur(): void {
    this.focus(null)
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

  private segmentEnabled(entry: SegmentedEntry, index: number): boolean {
    const seg = entry.spec.segments[index]
    return seg !== undefined && seg.enabled !== false
  }

  private scaled(entry: SegmentedEntry): {
    spec: SegmentedSpec
    style: SegmentedStyle
  } {
    return scaleSegmented(entry.spec, entry.style, this.scale)
  }

  private layoutOf(entry: SegmentedEntry): SegmentedLayout {
    if (!entry.layout) {
      const { spec, style } = this.scaled(entry)
      entry.layout = layoutSegmented(spec, style, this.font.metrics)
    }
    return entry.layout
  }

  /** The topmost (last added) enabled control under a canvas point. */
  private hitEntry(x: number, y: number): SegmentedEntry | null {
    const list = [...this.entries.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry.spec.enabled === false) continue
      if (segmentAt(this.layoutOf(entry), x, y) >= 0) return entry
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
      const pressed =
        this.pressedId === id && this.pressInside ? this.pressedIndex : -1
      const geo = buildSegmented(
        spec,
        style,
        this.font.metrics,
        this.layoutOf(entry),
        {
          selected: segmentIndex(entry.spec.segments, entry.value),
          hover: this.pressedId === id ? -1 : entry.hover,
          pressed,
          focused: this.focusedId === id,
          enabled: entry.spec.enabled !== false,
        },
      )
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
