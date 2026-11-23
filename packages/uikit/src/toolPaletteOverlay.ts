// A UIKit tool palette: a floating drawing toolbar after the iPad's own, its
// tools standing in a tray. Pressing a tool, swatch, width or action and
// lifting on it chooses it; the item under the pointer (or a hovering pencil)
// lifts or grows. Presses anywhere on it never reach the scene. One palette
// per overlay, shown with `show` and patched with `update`.

import type { UIKitOverlayFrame } from '@niivue/niivue'
import type { UIKitInteractive, UIKitRedrawSource } from './controls'
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
    this.spec = { ...this.spec, ...patch }
    this.layout = null
    this.bundle.invalidate()
  }

  hide(): void {
    if (!this.spec) return
    this.spec = null
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
    return true
  }

  pointerMove(x: number, y: number): boolean {
    const layout = this.getLayout()
    if (!this.spec || !layout) return false
    const at = toolPaletteItemAt(this.spec, layout, x, y)
    if (at !== this.hover) {
      this.hover = at
      this.bundle.invalidate()
    }
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

  bindLayer(layer: UIKitRedrawSource): void {
    this.bundle.bind(layer)
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

  private choose(
    spec: ToolPaletteOverlaySpec,
    kind: ToolPaletteItemKind,
    index: number,
  ): void {
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

function itemKey(
  spec: ToolPaletteOverlaySpec,
  item: { kind: ToolPaletteItemKind; index: number },
): string {
  return `${item.kind}:${itemId(spec, item.kind, item.index)}`
}
