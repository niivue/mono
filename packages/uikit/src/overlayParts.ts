// Mechanics shared by the widget overlays: the rect + line + label bundle they
// draw through, and the entry map they keep specs in. Pointer state, focus and
// callbacks stay in each widget.

import type { UIKitOverlayFrame } from '@niivue/niivue'
import type { UIKitRedrawSource } from './controls'
import type { LineData } from './line'
import { UIKitLineOverlay } from './lineOverlay'
import type { RectData } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import type { UIKitFont } from './text/font'
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
