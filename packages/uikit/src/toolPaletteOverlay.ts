// A UIKit tool palette: a floating drawing toolbar after the iPad's own, its
// tools standing in a tray. Pressing a tool, swatch, width or action and
// lifting on it chooses it; the item under the pointer (or a hovering pencil)
// lifts or grows. Presses anywhere on it never reach the scene. One palette
// per overlay, shown with `show` and patched with `update`. A press gives it
// keyboard focus: arrows then move the highlight over enabled items and Enter
// or Space chooses.

import type { UIKitOverlayFrame } from '@niivue/niivue'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import { UIKitDrawBundle } from './overlayParts'
import type { UIKitFont } from './text/font'
import {
  buildToolPalette,
  DEFAULT_TOOL_PALETTE_STYLE,
  layoutToolPalette,
  resolveToolPaletteStyle,
  scaleToolPaletteStyle,
  type ToolPaletteItemKind,
  type ToolPaletteLayout,
  type ToolPaletteSpec,
  type ToolPaletteStyle,
  toolPaletteContains,
  toolPaletteItemAt,
} from './toolPalette'

export interface ToolPaletteHandlers {
  /** Fired with the chosen item's id. */
  onTool?: (id: string) => void
  onColor?: (id: string) => void
  onWidth?: (id: string) => void
  onAction?: (id: string) => void
}

export type ToolPaletteOverlaySpec = ToolPaletteSpec & ToolPaletteHandlers

export interface UIKitToolPaletteOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  style?: Partial<ToolPaletteStyle>
  /** Interpret positions and style lengths as CSS pixels, scaled by the frame's DPR. */
  cssUnits?: boolean
}

export class UIKitToolPaletteOverlay implements UIKitInteractive {
  readonly hoverCursor = 'pointer'
  private readonly font: UIKitFont
  private readonly bundle: UIKitDrawBundle
  private readonly cssUnits: boolean
  private readonly baseStyle: ToolPaletteStyle
  private spec: ToolPaletteOverlaySpec | null = null
  private layout: ToolPaletteLayout | null = null
  private scale = 1
  private hover = -1
  private focused = false
  private layer: UIKitRedrawSource | null = null
  /** `kind:id` of the pressed item, so an update that moves items cannot retarget it. */
  private pressed: string | null = null

  constructor(font: UIKitFont, options: UIKitToolPaletteOverlayOptions = {}) {
    this.font = font
    this.bundle = new UIKitDrawBundle(font, options.requestRedraw)
    this.cssUnits = options.cssUnits ?? false
    this.baseStyle = resolveToolPaletteStyle(
      DEFAULT_TOOL_PALETTE_STYLE,
      options.style,
    )
  }

  /** Show the palette, replacing any shown. */
  show(spec: ToolPaletteOverlaySpec): void {
    this.spec = spec
    this.layout = null
    this.hover = -1
    this.pressed = null
    this.bundle.invalidate()
  }

  /** Patch the shown palette, keeping hover and a press under way. */
  update(patch: Partial<ToolPaletteOverlaySpec>): void {
    if (!this.spec) return
    // Hover is an index into the layout: follow its item by key, or drop it
    // (also when the update disabled it).
    const hovered = this.getLayout()?.items[this.hover]
    const key = hovered ? itemKey(this.spec, hovered) : null
    this.spec = { ...this.spec, ...patch }
    this.layout = null
    const spec = this.spec
    this.hover = key
      ? (this.getLayout()?.items.findIndex(
          (item) => itemKey(spec, item) === key && isEnabled(spec, item),
        ) ?? -1)
      : -1
    this.bundle.invalidate()
  }

  hide(): void {
    if (!this.spec) return
    this.spec = null
    this.focused = false
    this.layout = null
    this.bundle.invalidate()
  }

  get isShown(): boolean {
    return this.spec !== null
  }

  /** The tray and its items in canvas pixels, or null while hidden. */
  getLayout(): ToolPaletteLayout | null {
    if (!this.spec) return null
    this.layout ??= layoutToolPalette(
      this.spec,
      this.spec.x * this.scale,
      this.spec.y * this.scale,
      (this.spec.maxWidth ?? Number.POSITIVE_INFINITY) * this.scale,
      this.style(),
      this.font.metrics,
    )
    return this.layout
  }

  /**
   * The tray's size and how far its tools reach above it, in the spec's
   * units (CSS pixels with `cssUnits`), for placing it.
   */
  measure(): { width: number; height: number; reach: number } | null {
    const layout = this.getLayout()
    if (!layout) return null
    const top = layout.items.reduce((m, item) => Math.min(m, item.y), layout.y)
    const reach = layout.y - top
    return {
      width: layout.width / this.scale,
      height: layout.height / this.scale,
      reach: reach / this.scale,
    }
  }

  hitTest(x: number, y: number): boolean {
    const layout = this.getLayout()
    return layout !== null && toolPaletteContains(layout, x, y)
  }

  pointerDown(x: number, y: number): boolean {
    const layout = this.getLayout()
    if (!this.spec || !layout || !toolPaletteContains(layout, x, y)) {
      return false
    }
    const item = layout.items[toolPaletteItemAt(this.spec, layout, x, y)]
    this.pressed = item ? itemKey(this.spec, item) : null
    this.focused = true
    this.layer?.focus?.(this)
    return true
  }

  pointerMove(x: number, y: number): boolean {
    const layout = this.getLayout()
    if (!this.spec || !layout) return false
    const at = toolPaletteItemAt(this.spec, layout, x, y)
    this.setHover(at)
    return at >= 0
  }

  pointerUp(x: number, y: number): boolean {
    const layout = this.getLayout()
    const spec = this.spec
    if (!spec || !layout) return false
    const at = toolPaletteItemAt(spec, layout, x, y)
    const item = layout.items[at]
    const chosen =
      item && itemKey(spec, item) === this.pressed ? layout.items[at] : null
    this.pressed = null
    if (chosen) this.choose(spec, chosen.kind, chosen.index)
    return true
  }

  pointerCancel(): void {
    this.pressed = null
  }

  /** With focus, arrows move the highlight over enabled items (wrapping); Enter or Space chooses. */
  keyDown(e: UIKitKeyEvent): boolean {
    const spec = this.spec
    const layout = this.getLayout()
    if (!this.focused || !spec || !layout) return false
    const items = layout.items
    if (e.key === 'Enter' || e.key === ' ') {
      const item = items[this.hover]
      if (!item || !isEnabled(spec, item)) return false
      this.choose(spec, item.kind, item.index)
      return true
    }
    if (!e.key.startsWith('Arrow') || !items.length) return false
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
    let next = this.hover < 0 && step < 0 ? 0 : this.hover
    for (let tries = 0; tries < items.length; tries++) {
      next = (next + step + items.length) % items.length
      if (isEnabled(spec, items[next])) {
        this.setHover(next)
        break
      }
    }
    return true
  }

  blur(): void {
    this.focused = false
    this.setHover(-1)
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.bundle.bind(layer)
    this.layer = layer
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const scale = this.cssUnits ? frame.dpr : 1
    const changed = scale !== this.scale
    if (changed) {
      this.scale = scale
      this.layout = null
    }
    const spec = this.spec
    const layout = this.getLayout()
    if (!spec || !layout) return
    this.bundle.draw(
      frame,
      () => [
        buildToolPalette(
          spec,
          this.style(),
          this.font.metrics,
          layout,
          this.hover,
        ),
      ],
      changed,
    )
  }

  destroy(): void {
    this.bundle.destroy()
  }

  private style(): ToolPaletteStyle {
    return scaleToolPaletteStyle(this.baseStyle, this.scale)
  }

  private setHover(index: number): void {
    if (index === this.hover) return
    this.hover = index
    this.bundle.invalidate()
  }

  private choose(
    spec: ToolPaletteOverlaySpec,
    kind: ToolPaletteItemKind,
    index: number,
  ): void {
    if (!isEnabled(spec, { kind, index })) return
    const id = itemId(spec, kind, index)
    if (kind === 'tool') spec.onTool?.(id)
    else if (kind === 'color') spec.onColor?.(id)
    else if (kind === 'width') spec.onWidth?.(id)
    else spec.onAction?.(id)
  }
}

function itemId(
  spec: ToolPaletteOverlaySpec,
  kind: ToolPaletteItemKind,
  index: number,
): string {
  if (kind === 'tool') return spec.tools[index]?.id ?? ''
  if (kind === 'color') return spec.colors?.[index]?.id ?? ''
  if (kind === 'width') return spec.widths?.[index]?.id ?? ''
  return spec.actions?.[index]?.id ?? ''
}

function isEnabled(
  spec: ToolPaletteOverlaySpec,
  item: { kind: ToolPaletteItemKind; index: number },
): boolean {
  return !(
    item.kind === 'action' && spec.actions?.[item.index]?.enabled === false
  )
}

function itemKey(
  spec: ToolPaletteOverlaySpec,
  item: { kind: ToolPaletteItemKind; index: number },
): string {
  return `${item.kind}:${itemId(spec, item.kind, item.index)}`
}
