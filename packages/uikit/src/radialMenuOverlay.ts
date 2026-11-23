// A UIKit radial menu: rings of items around a point, opened from code (a
// pencil squeeze, a long press) and closed by a choice, a press outside it or
// Escape. While open it is modal in a `UIKitControls` layer, so the press that
// dismisses it never reaches the scene. The item under the pointer (or a
// hovering pencil) enlarges; releasing on the item that was pressed chooses it.
// Arrow keys move the highlight and Enter or Space chooses.

import type { UIKitOverlayFrame } from '@niivue/niivue'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import { UIKitDrawBundle } from './overlayParts'
import {
  buildRadialMenu,
  DEFAULT_RADIAL_MENU_STYLE,
  layoutRadialMenu,
  type RadialMenuBounds,
  type RadialMenuItem,
  type RadialMenuLayout,
  type RadialMenuStyle,
  radialItemAt,
  radialMenuContains,
  resolveRadialMenuStyle,
  scaleRadialMenuStyle,
} from './radialMenu'
import type { UIKitFont } from './text/font'

export interface RadialMenuSpec {
  /** The centre, in canvas pixels (CSS pixels with `cssUnits`). */
  x: number
  y: number
  items: readonly RadialMenuItem[]
  /** Fired with the chosen item's id, after the menu closes. */
  onSelect: (id: string) => void
  /** Per-menu overrides of the overlay's default style. */
  style?: Partial<RadialMenuStyle>
}

export interface UIKitRadialMenuOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style; a spec's `style` overrides per key. */
  style?: Partial<RadialMenuStyle>
  /** Interpret the centre and style lengths as CSS pixels, scaled by the frame's DPR. */
  cssUnits?: boolean
}

export class UIKitRadialMenuOverlay implements UIKitInteractive {
  readonly hoverCursor = 'pointer'
  private readonly font: UIKitFont
  private readonly bundle: UIKitDrawBundle
  private readonly cssUnits: boolean
  private baseStyle: RadialMenuStyle
  private layer: UIKitRedrawSource | null = null
  private inLayer = false
  private spec: RadialMenuSpec | null = null
  private layout: RadialMenuLayout | null = null
  private scale = 1
  private bounds: RadialMenuBounds | null = null
  private hover = -1
  private pressed = -1

  constructor(font: UIKitFont, options: UIKitRadialMenuOverlayOptions = {}) {
    this.font = font
    this.bundle = new UIKitDrawBundle(font, options.requestRedraw)
    this.cssUnits = options.cssUnits ?? false
    this.baseStyle = resolveRadialMenuStyle(
      DEFAULT_RADIAL_MENU_STYLE,
      options.style,
    )
  }

  /** Open the menu (replacing an open one) with nothing highlighted. */
  open(spec: RadialMenuSpec): void {
    this.spec = spec
    this.layout = null
    this.hover = -1
    this.pressed = -1
    this.layer?.focus?.(this)
    this.bundle.invalidate()
  }

  /** Close without choosing. */
  close(): void {
    if (!this.spec) return
    this.spec = null
    this.layout = null
    this.hover = -1
    this.pressed = -1
    this.bundle.invalidate()
  }

  get isOpen(): boolean {
    return this.spec !== null
  }

  /** The highlighted item's index, or -1. */
  get highlightedIndex(): number {
    return this.hover
  }

  /** The disc and item faces in canvas pixels, or null while closed. */
  getLayout(): RadialMenuLayout | null {
    if (!this.spec) return null
    this.layout ??= layoutRadialMenu(
      this.spec.items,
      this.spec.x * this.scale,
      this.spec.y * this.scale,
      this.style(),
      this.font.metrics,
      this.bounds,
    )
    return this.layout
  }

  isModal(): boolean {
    return this.spec !== null
  }

  dismiss(): void {
    this.close()
  }

  hitTest(x: number, y: number): boolean {
    const layout = this.getLayout()
    return layout !== null && radialMenuContains(layout, x, y)
  }

  /** Any press while open is the menu's: on an item it arms it, elsewhere it closes. */
  pointerDown(x: number, y: number): boolean {
    const layout = this.getLayout()
    if (!this.spec || !layout) return false
    this.pressed = radialItemAt(this.spec.items, layout, x, y)
    if (this.pressed < 0 && !radialMenuContains(layout, x, y)) this.close()
    else this.setHover(this.pressed)
    return true
  }

  pointerMove(x: number, y: number): boolean {
    const layout = this.getLayout()
    if (!this.spec || !layout) return false
    this.setHover(radialItemAt(this.spec.items, layout, x, y))
    return true
  }

  pointerUp(x: number, y: number): boolean {
    const layout = this.getLayout()
    if (!this.spec || !layout) return false
    const at = radialItemAt(this.spec.items, layout, x, y)
    if (at >= 0 && at === this.pressed) this.choose(at)
    this.pressed = -1
    return true
  }

  pointerCancel(): void {
    this.pressed = -1
  }

  keyDown(e: UIKitKeyEvent): boolean {
    const items = this.spec?.items
    if (!items) return false
    if (e.key === 'Escape') {
      this.close()
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (this.hover >= 0) this.choose(this.hover)
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const step = e.key === 'ArrowRight' ? 1 : -1
      let next = this.hover
      for (let tries = 0; tries < items.length; tries++) {
        next = (next + step + items.length) % items.length
        if (items[next].enabled !== false) {
          this.setHover(next)
          break
        }
      }
    }
    // Every key is the open menu's.
    return true
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.bundle.bind(layer)
    this.layer = layer
    this.inLayer = true
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (!this.inLayer) this.drawPopup(frame)
  }

  /** Draw the open menu; a control layer calls this above every widget. */
  drawPopup(frame: UIKitOverlayFrame): void {
    const scale = this.cssUnits ? frame.dpr : 1
    const b = frame.bounds
    const old = this.bounds
    const changed =
      scale !== this.scale ||
      !old ||
      old.x !== b.x ||
      old.y !== b.y ||
      old.width !== b.width ||
      old.height !== b.height
    if (changed) {
      this.scale = scale
      this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
      this.layout = null
    }
    const spec = this.spec
    const layout = this.getLayout()
    if (!spec || !layout) return
    this.bundle.draw(
      frame,
      () => [
        buildRadialMenu(
          spec.items,
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

  private style(): RadialMenuStyle {
    return scaleRadialMenuStyle(
      resolveRadialMenuStyle(this.baseStyle, this.spec?.style),
      this.scale,
    )
  }

  private setHover(index: number): void {
    if (index === this.hover) return
    this.hover = index
    this.bundle.invalidate()
  }

  private choose(index: number): void {
    const spec = this.spec
    if (!spec || spec.items[index].enabled === false) return
    this.close()
    spec.onSelect(spec.items[index].id)
  }
}
