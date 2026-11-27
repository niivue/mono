// Mechanics shared by the widget overlays: the rect + line + label bundle they
// draw through, the entry map they keep specs in, and the entry-overlay base
// that wires the two to a widget model (add, remove, press, hover, focus).
// Pointer handling, keys and callbacks stay in each widget.

import type { UIKitInteractive, UIKitRedrawSource } from './controls'
import type { UIKitOverlayFrame, UIKitOverlayRenderer } from './hook'
import type { LineData } from './line'
import { UIKitLineOverlay } from './lineOverlay'
import type { RectData } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import { resolveStyle } from './style'
import type { UIKitFont, UIKitFontMetrics } from './text/font'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'

/** One widget's draw data. */
export interface UIKitGeometry {
  rects: readonly RectData[]
  lines: readonly LineData[]
  text: readonly UIKitTextItem[]
}

/** The three primitives a widget overlay draws through, rebuilt only when dirty. */
export class UIKitDrawBundle {
  private readonly rects = new UIKitRectOverlay()
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private requestRedraw: (() => void) | null
  private dirty = true

  constructor(font: UIKitFont, requestRedraw?: () => void) {
    this.labels = new UIKitTextOverlay(font)
    this.requestRedraw = requestRedraw ?? null
  }

  /** Route redraws to the layer unless the options supplied a callback. */
  bind(layer: UIKitRedrawSource): void {
    this.requestRedraw ??= () => layer.requestRedraw()
  }

  invalidate(): void {
    this.dirty = true
    this.requestRedraw?.()
  }

  /** Draw, first rebuilding from `build` when invalidated or `force`d. */
  draw(
    frame: UIKitOverlayFrame,
    build: () => Iterable<UIKitGeometry>,
    force = false,
  ): void {
    if (this.dirty || force) {
      const rects: RectData[] = []
      const lines: LineData[] = []
      const text: UIKitTextItem[] = []
      for (const geo of build()) {
        rects.push(...geo.rects)
        lines.push(...geo.lines)
        text.push(...geo.text)
      }
      this.rects.setRects(rects)
      this.lines.setLines(lines)
      this.labels.setItems(text)
      this.dirty = false
    }
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
}

interface UIKitEntry<L> {
  spec: { id: string; enabled?: boolean }
  layout: L | null
}

/**
 * A widget overlay's entries by id, in draw order, with their layouts cached
 * at the current CSS-to-canvas scale.
 */
export class UIKitEntryMap<L, E extends UIKitEntry<L>> extends Map<string, E> {
  /** CSS-to-canvas scale: the frame's DPR with `cssUnits`, else 1. */
  scale = 1

  constructor(
    private readonly measure: (entry: E, scale: number) => L,
    private readonly cssUnits: boolean,
  ) {
    super()
  }

  get ids(): string[] {
    return [...this.keys()]
  }

  layoutOf(entry: E): L {
    entry.layout ??= this.measure(entry, this.scale)
    return entry.layout
  }

  /** Track the frame's DPR; true (and layouts dropped) when the scale changed. */
  rescale(dpr: number): boolean {
    const scale = this.cssUnits ? dpr : 1
    if (scale === this.scale) return false
    this.scale = scale
    for (const entry of this.values()) entry.layout = null
    return true
  }

  /** The entry, when it exists and is enabled. */
  enabled(id: string | null): E | undefined {
    const entry = id !== null ? this.get(id) : undefined
    return entry && entry.spec.enabled !== false ? entry : undefined
  }

  /** The topmost (last added) enabled entry whose layout `contains` the point. */
  topmost(
    contains: (layout: L, x: number, y: number) => boolean,
    x: number,
    y: number,
  ): E | null {
    const list = [...this.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry.spec.enabled === false) continue
      if (contains(this.layoutOf(entry), x, y)) return entry
    }
    return null
  }

  /** Replace the id set: remove the ids `specs` lacks, then add (or update) each spec. */
  replaceAll<S extends { id: string }>(
    specs: readonly S[],
    add: (spec: S) => void,
    remove: (id: string) => void,
  ): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of this.ids) if (!keep.has(id)) remove(id)
    for (const spec of specs) add(spec)
  }
}

/** The model functions an entry overlay draws and hit-tests a widget with. */
export interface UIKitEntryModel<S, St, L> {
  defaultStyle: St
  scale: (spec: S, style: St, k: number) => { spec: S; style: St }
  layout: (spec: S, style: St, metrics: UIKitFontMetrics) => L
  contains: (layout: L, x: number, y: number) => boolean
  /** A canvas-pixel layout divided back into spec units by scale `k`. */
  unscale: (layout: L, k: number) => L
}

export interface UIKitEntryOverlayOptions<St> {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every widget; a spec's `style` overrides per key. */
  style?: Partial<St>
  /**
   * Interpret spec positions, sizes and style lengths as CSS pixels and scale
   * them by the frame's device pixel ratio, instead of canvas pixels. Pointer
   * coordinates always arrive in canvas pixels.
   */
  cssUnits?: boolean
}

/**
 * A widget overlay over one entry map: default style, scaling, hit testing,
 * layer binding, drawing and teardown. The widget adds its entries, pointer
 * and keyboard handling, and `geometry`.
 */
export abstract class UIKitEntryOverlay<
  S extends { id: string; enabled?: boolean; style?: Partial<St> },
  St,
  L,
  E extends { spec: S; style: St; layout: L | null },
> implements UIKitOverlayRenderer, UIKitInteractive
{
  protected readonly bundle: UIKitDrawBundle
  protected readonly entries: UIKitEntryMap<L, E>
  protected baseStyle: St
  protected layer: UIKitRedrawSource | null = null
  protected hoverId: string | null = null
  protected focusedId: string | null = null
  /** The entry the pointer went down on and still holds. */
  protected pressedId: string | null = null

  constructor(
    protected readonly font: UIKitFont,
    protected readonly model: UIKitEntryModel<S, St, L>,
    options: UIKitEntryOverlayOptions<St>,
  ) {
    this.bundle = new UIKitDrawBundle(font, options.requestRedraw)
    this.entries = new UIKitEntryMap((entry, scale) => {
      const { spec, style } = model.scale(entry.spec, entry.style, scale)
      return model.layout(spec, style, font.metrics)
    }, options.cssUnits ?? false)
    this.baseStyle = resolveStyle(model.defaultStyle, options.style)
  }

  /** Replace the default style for every entry (per-spec overrides still win). */
  setDefaultStyle(style: Partial<St>): void {
    this.baseStyle = resolveStyle(this.model.defaultStyle, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveStyle(this.baseStyle, entry.spec.style)
      this.relayout(entry)
    }
    this.invalidate()
  }

  /** The ids of all entries, in draw order. */
  get ids(): string[] {
    return this.entries.ids
  }

  /** An entry's boxes in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): L | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const l = this.entries.layoutOf(entry)
    const k = this.entries.scale
    return k === 1 ? l : this.model.unscale(l, k)
  }

  hitTest(x: number, y: number): boolean {
    return this.hitEntry(x, y) !== null
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.bundle.bind(layer)
    this.layer = layer
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.entries.size === 0) return
    const rescaled = this.entries.rescale(frame.dpr)
    if (rescaled)
      for (const entry of this.entries.values()) this.relayout(entry)
    this.bundle.draw(frame, () => this.geometry(), rescaled)
  }

  blur(): void {
    this.focus(null)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.bundle.destroy()
  }

  /**
   * Restyle the entry with this spec's id for it (layout dropped) and return
   * it, or add the one `create` makes and return null.
   */
  protected upsert(spec: S, create: (style: St) => E): E | null {
    const style = resolveStyle(this.baseStyle, spec.style)
    const existing = this.entries.get(spec.id)
    if (!existing) {
      this.entries.set(spec.id, create(style))
      return null
    }
    existing.spec = spec
    existing.style = style
    existing.layout = null
    return existing
  }

  /** Replace the id set: remove the ids `specs` lacks, then `add` each spec. */
  protected replaceAll(specs: readonly S[], add: (spec: S) => void): void {
    this.entries.replaceAll(specs, add, (id) => this.remove(id))
  }

  /** Drop an entry with its press, hover and focus. */
  protected remove(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.pressedId === id) this.pressedId = null
    if (this.hoverId === id) this.hoverId = null
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
  }

  /** Point the hover at `hit`'s entry, redrawing when it moved. */
  protected setHover(hit: E | null): void {
    const id = hit ? hit.spec.id : null
    if (id === this.hoverId) return
    this.hoverId = id
    this.invalidate()
  }

  /** Give an entry keyboard focus, or null to clear. Disabled entries refuse. */
  focus(id: string | null): void {
    const next = this.entries.enabled(id) ? id : null
    if (next === this.focusedId) return
    this.focusedId = next
    if (next !== null) this.layer?.focus?.(this)
    this.invalidate()
  }

  /** Drop an entry's cached layout (and anything measured from it). */
  protected relayout(entry: E): void {
    entry.layout = null
  }

  protected invalidate(): void {
    this.bundle.invalidate()
  }

  protected scaled(entry: E): { spec: S; style: St } {
    return this.model.scale(entry.spec, entry.style, this.entries.scale)
  }

  /** The topmost (last added) enabled entry under a canvas point. */
  protected hitEntry(x: number, y: number): E | null {
    return this.entries.topmost(this.model.contains, x, y)
  }

  abstract pointerDown(x: number, y: number): boolean
  abstract pointerMove(x: number, y: number): boolean
  abstract pointerUp(x: number, y: number): boolean
  abstract pointerCancel(): void
  protected abstract geometry(): Iterable<UIKitGeometry>
}
