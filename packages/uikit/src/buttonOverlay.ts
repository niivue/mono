// A UIKit overlay of clickable, stylable push buttons drawn into the scene
// through the niivue overlay hook. Each button is a rounded rect plus a centred
// label; the pointer drives hover, a press that shrinks and darkens the face,
// and a release that eases back, with a click fired on pointer-up inside the
// button the pointer went down on. Register it with
// `nv.registerOverlayRenderer(buttons)` and `buttons.attach(nv)` to wire the
// canvas pointer events, or feed `pointerDown/Move/Up` yourself from any host.
//
// Pointer events that land on a button are consumed before NiiVue's own canvas
// handlers see them (a capture-phase listener plus stopImmediatePropagation), so
// a click on a button never also starts a drag or moves the crosshair. The
// overlay is a `UIKitInteractive`, so it can share a `UIKitControls` layer with
// toggles, sliders and menus; `attach` is a one-widget layer for convenience.

import {
  advancePress,
  type ButtonLayout,
  type ButtonSpec,
  type ButtonStyle,
  buildButton,
  buttonContains,
  DEFAULT_BUTTON_STYLE,
  layoutButton,
  scaleButton,
} from './button'
import { UIKitControls, type UIKitHost, type UIKitKeyEvent } from './controls'
import type { UIKitOverlayFrame } from './hook'
import {
  UIKitEntryOverlay,
  type UIKitEntryOverlayOptions,
  type UIKitGeometry,
} from './overlayParts'
import { unscaleBox } from './rect'
import type { UIKitFont } from './text/font'

/** What `attach` needs from a host: NiiVue satisfies it as-is. */
export type UIKitButtonHost = UIKitHost

export interface UIKitButtonOverlayOptions
  extends UIKitEntryOverlayOptions<ButtonStyle> {
  /** Clock for the press animation (ms). Default `performance.now`. */
  now?: () => number
}

interface ButtonEntry {
  spec: ButtonSpec
  style: ButtonStyle
  /** Resting box in canvas pixels, for the scale it was laid out at. */
  layout: ButtonLayout | null
  press: number
  pressTarget: number
  /** A programmatic click: run the press to 1, then release. */
  pulse: boolean
}

const MODEL = {
  defaultStyle: DEFAULT_BUTTON_STYLE,
  scale: scaleButton,
  layout: layoutButton,
  contains: buttonContains,
  unscale: unscaleBox,
}

export class UIKitButtonOverlay extends UIKitEntryOverlay<
  ButtonSpec,
  ButtonStyle,
  ButtonLayout,
  ButtonEntry
> {
  readonly hoverCursor = 'pointer'
  private readonly now: () => number
  private lastTick = 0

  constructor(font: UIKitFont, options: UIKitButtonOverlayOptions = {}) {
    super(font, MODEL, options)
    this.now = options.now ?? (() => performance.now())
  }

  /** Add a button, or replace the one with the same id (keeping its press state). */
  addButton(spec: ButtonSpec): void {
    this.upsert(spec, (style) => ({
      spec,
      style,
      layout: null,
      press: 0,
      pressTarget: 0,
      pulse: false,
    }))
    this.invalidate()
  }

  /** Replace the whole button set. */
  setButtons(specs: readonly ButtonSpec[]): void {
    this.replaceAll(specs, (spec) => this.addButton(spec))
  }

  removeButton(id: string): void {
    this.remove(id)
  }

  /** Patch one button's spec (label, position, style, enabled, callback). */
  updateButton(id: string, patch: Partial<Omit<ButtonSpec, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.addButton({ ...entry.spec, ...patch, id })
    if (entry.spec.enabled === false && this.pressedId === id) {
      this.pressedId = null
      entry.pressTarget = 0
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateButton(id, { enabled })
  }

  /** True while the pointer is over an enabled button. */
  get hovering(): boolean {
    return this.hoverId !== null
  }

  /**
   * Click a button from code (a keyboard shortcut, say): plays the press and
   * release animation and fires its callback as a pointer click would.
   */
  click(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.spec.enabled === false) return
    entry.pulse = true
    entry.pressTarget = 1
    this.startAnimation()
    entry.spec.onClick?.(id)
  }

  /**
   * Pointer down at canvas pixel (x, y). Returns true when a button took it
   * (the host should then not treat it as a scene interaction). The button
   * also takes keyboard focus: Enter or Space clicks it until focus moves.
   */
  pointerDown(x: number, y: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    this.pressedId = entry.spec.id
    this.focusedId = entry.spec.id
    entry.pressTarget = 1
    this.startAnimation()
    return true
  }

  /**
   * Pointer move to canvas pixel (x, y); pass coordinates outside the canvas
   * (or a negative pair) when the pointer leaves. Updates hover, and while a
   * press is held, releases the face when the pointer strays off the button and
   * re-presses when it comes back. Returns true while a press is held.
   */
  pointerMove(x: number, y: number): boolean {
    if (this.pressedId !== null) {
      const entry = this.entries.get(this.pressedId)
      if (entry) {
        const inside = buttonContains(this.entries.layoutOf(entry), x, y)
        const target = inside ? 1 : 0
        if (entry.pressTarget !== target) {
          entry.pressTarget = target
          this.startAnimation()
        }
      }
      return true
    }
    this.setHover(this.hitEntry(x, y))
    return false
  }

  /**
   * Pointer up at canvas pixel (x, y). Fires the click when it lands inside the
   * button the pointer went down on. Returns true when a press was being held.
   */
  pointerUp(x: number, y: number): boolean {
    const id = this.pressedId
    if (id === null) return false
    this.pressedId = null
    const entry = this.entries.get(id)
    if (!entry) return true
    entry.pressTarget = 0
    this.startAnimation()
    if (buttonContains(this.entries.layoutOf(entry), x, y)) {
      entry.spec.onClick?.(id)
    }
    // Re-evaluate hover now that the press no longer owns the pointer.
    this.pointerMove(x, y)
    return true
  }

  /** Abandon a held press (pointer cancelled or captured away) without a click. */
  pointerCancel(): void {
    const id = this.pressedId
    if (id === null) return
    this.pressedId = null
    const entry = this.entries.get(id)
    if (entry) {
      entry.pressTarget = 0
      this.startAnimation()
    }
  }

  /** Enter or Space clicks the last-pressed button. */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.focusedId === null) return false
    if (e.key !== 'Enter' && e.key !== ' ') return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false) return false
    this.click(this.focusedId)
    return true
  }

  override blur(): void {
    this.focusedId = null
  }

  /**
   * Wire the host canvas's pointer events to this overlay alone and return a
   * function that unwires them: a one-widget `UIKitControls` layer. To combine
   * buttons with other widgets, add this overlay to a shared layer instead.
   */
  attach(host: UIKitButtonHost): () => void {
    return new UIKitControls().add(this).attach(host)
  }

  /** Current press amount of a button (0 at rest, 1 fully pressed). */
  pressOf(id: string): number {
    return this.entries.get(id)?.press ?? 0
  }

  /**
   * Step the press animation as a frame would, without drawing. Exposed for
   * headless tests of the animation; a host never needs it.
   * @internal
   */
  tickForTest(): boolean {
    return this.tick().animating
  }

  /** Advance every running press animation by the wall clock. */
  private tick(): { animating: boolean; stepped: boolean } {
    const now = this.now()
    const dt = this.lastTick > 0 ? now - this.lastTick : 0
    this.lastTick = now
    let animating = false
    let stepped = false
    for (const entry of this.entries.values()) {
      if (entry.press === entry.pressTarget) {
        if (entry.pulse && entry.pressTarget === 1) {
          entry.pulse = false
          entry.pressTarget = 0
        } else continue
      }
      const ms =
        entry.pressTarget > entry.press
          ? entry.style.pressMs
          : entry.style.releaseMs
      entry.press = advancePress(entry.press, entry.pressTarget, dt, ms)
      if (entry.press !== entry.pressTarget || entry.pulse) animating = true
      stepped = true
    }
    if (!animating) this.lastTick = 0
    return { animating, stepped }
  }

  override drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.entries.size === 0) return
    const rescaled = this.entries.rescale(frame.dpr)
    const { animating, stepped } = this.tick()
    this.bundle.draw(frame, () => this.geometry(), rescaled || stepped)
    // The next frame steps the animation again, so its rebuild is due anyway.
    if (animating) this.bundle.invalidate()
  }

  private startAnimation(): void {
    this.lastTick = this.now()
    this.invalidate()
  }

  protected *geometry(): Generator<UIKitGeometry> {
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const geo = buildButton(
        spec,
        style,
        this.font.metrics,
        this.entries.layoutOf(entry),
        {
          hover: this.hoverId === entry.spec.id,
          press: entry.press,
          enabled: entry.spec.enabled !== false,
        },
      )
      yield { rects: [geo.rect], lines: [], text: [geo.text] }
    }
  }
}
