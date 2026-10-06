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
// a click on a button never also starts a drag or moves the crosshair.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import {
  advancePress,
  type ButtonLayout,
  type ButtonSpec,
  type ButtonStyle,
  buildButton,
  buttonContains,
  DEFAULT_BUTTON_STYLE,
  layoutButton,
  resolveButtonStyle,
  scaleButton,
} from './button'
import type { RectData } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import type { UIKitFont } from './text/font'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'

/** What `attach` needs from a host: NiiVue satisfies it as-is. */
export interface UIKitButtonHost {
  canvas: HTMLCanvasElement | null
  /** Client (CSS) coordinates to canvas backing-store pixels, or null if outside. */
  clientToCanvas(clientX: number, clientY: number): [number, number] | null
  /** Schedule a redraw of the scene (and so of this overlay). */
  drawScene(): void
}

export interface UIKitButtonOverlayOptions {
  /**
   * Called whenever the overlay needs another frame (a hover/press change, or
   * each step of a running press animation). `attach` fills this in with the
   * host's `drawScene` when it is not set.
   */
  requestRedraw?: () => void
  /** Default style for every button; a spec's `style` overrides per key. */
  style?: Partial<ButtonStyle>
  /**
   * Interpret spec positions, sizes and style lengths as CSS pixels and scale
   * them by the frame's device pixel ratio, instead of canvas pixels. Pointer
   * coordinates always arrive in canvas pixels (the hook's convention).
   */
  cssUnits?: boolean
  /** Clock for the press animation (ms). Default `performance.now`. */
  now?: () => number
}

interface ButtonEntry {
  spec: ButtonSpec
  style: ButtonStyle
  /** Resting box in canvas pixels, for the scale it was laid out at. */
  layout: ButtonLayout | null
  hover: boolean
  press: number
  pressTarget: number
  /** A programmatic click: run the press to 1, then release. */
  pulse: boolean
}

export class UIKitButtonOverlay implements UIKitOverlayRenderer {
  private readonly font: UIKitFont
  private readonly rects = new UIKitRectOverlay()
  private readonly labels: UIKitTextOverlay
  private readonly entries = new Map<string, ButtonEntry>()
  private baseStyle: ButtonStyle
  private readonly cssUnits: boolean
  private readonly now: () => number
  private requestRedraw: (() => void) | null
  /** Scale from spec units to canvas pixels (the frame dpr when cssUnits). */
  private scale = 1
  private geometryDirty = true
  private lastTick = 0
  private pressedId: string | null = null
  private hoverId: string | null = null

  constructor(font: UIKitFont, options: UIKitButtonOverlayOptions = {}) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    this.baseStyle = resolveButtonStyle(DEFAULT_BUTTON_STYLE, options.style)
    this.cssUnits = options.cssUnits ?? false
    this.now = options.now ?? (() => performance.now())
    this.requestRedraw = options.requestRedraw ?? null
  }

  /** Replace the default style for every button (per-spec overrides still win). */
  setDefaultStyle(style: Partial<ButtonStyle>): void {
    this.baseStyle = resolveButtonStyle(DEFAULT_BUTTON_STYLE, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveButtonStyle(this.baseStyle, entry.spec.style)
      entry.layout = null
    }
    this.invalidate()
  }

  /** Add a button, or replace the one with the same id (keeping its press state). */
  addButton(spec: ButtonSpec): void {
    const existing = this.entries.get(spec.id)
    const style = resolveButtonStyle(this.baseStyle, spec.style)
    if (existing) {
      existing.spec = spec
      existing.style = style
      existing.layout = null
    } else {
      this.entries.set(spec.id, {
        spec,
        style,
        layout: null,
        hover: false,
        press: 0,
        pressTarget: 0,
        pulse: false,
      })
    }
    this.invalidate()
  }

  /** Replace the whole button set. */
  setButtons(specs: readonly ButtonSpec[]): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) this.removeButton(id)
    }
    for (const spec of specs) this.addButton(spec)
  }

  removeButton(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.pressedId === id) this.pressedId = null
    if (this.hoverId === id) this.hoverId = null
    this.invalidate()
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

  /** The ids of all buttons, in draw order. */
  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /**
   * The resting box of a button in spec units (canvas pixels, or CSS pixels
   * with `cssUnits`), or null for an unknown id. Handy for placing the next
   * button after an auto-sized one.
   */
  getLayout(id: string): ButtonLayout | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const l = this.layoutOf(entry)
    const k = this.scale
    if (k === 1) return l
    return { x: l.x / k, y: l.y / k, width: l.width / k, height: l.height / k }
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
   * (the host should then not treat it as a scene interaction).
   */
  pointerDown(x: number, y: number): boolean {
    const entry = this.hitTest(x, y)
    if (!entry) return false
    this.pressedId = entry.spec.id
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
        const inside = buttonContains(this.layoutOf(entry), x, y)
        const target = inside ? 1 : 0
        if (entry.pressTarget !== target) {
          entry.pressTarget = target
          this.startAnimation()
        }
      }
      return true
    }
    const hit = this.hitTest(x, y)
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
    if (buttonContains(this.layoutOf(entry), x, y)) {
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

  /**
   * Wire the host canvas's pointer events to this overlay and return a
   * function that unwires them. Events over a button are consumed before the
   * host's own handlers run. Also shows a pointer cursor over buttons.
   */
  attach(host: UIKitButtonHost): () => void {
    const canvas = host.canvas
    if (!canvas) throw new Error('UIKit: host has no canvas to attach to')
    this.requestRedraw ??= () => host.drawScene()
    const savedCursor = canvas.style.cursor
    const syncCursor = (): void => {
      canvas.style.cursor = this.hoverId !== null ? 'pointer' : savedCursor
    }
    const consume = (e: Event): void => {
      e.stopImmediatePropagation()
      e.preventDefault()
    }
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const p = host.clientToCanvas(e.clientX, e.clientY)
      if (!p || !this.pointerDown(p[0], p[1])) return
      consume(e)
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // Capture is best-effort: pointerleave/cancel still release the press.
      }
    }
    const onMove = (e: PointerEvent): void => {
      const p = host.clientToCanvas(e.clientX, e.clientY)
      const consumed = p
        ? this.pointerMove(p[0], p[1])
        : this.pointerMove(-1, -1)
      syncCursor()
      if (consumed) consume(e)
    }
    const onUp = (e: PointerEvent): void => {
      const p = host.clientToCanvas(e.clientX, e.clientY) ?? [-1, -1]
      const consumed = this.pointerUp(p[0], p[1])
      syncCursor()
      if (consumed) consume(e)
    }
    const onLeave = (): void => {
      this.pointerMove(-1, -1)
      syncCursor()
    }
    const onCancel = (): void => {
      this.pointerCancel()
      onLeave()
    }
    const opts = { capture: true }
    canvas.addEventListener('pointerdown', onDown, opts)
    canvas.addEventListener('pointermove', onMove, opts)
    canvas.addEventListener('pointerup', onUp, opts)
    canvas.addEventListener('pointerleave', onLeave, opts)
    canvas.addEventListener('pointercancel', onCancel, opts)
    return () => {
      canvas.removeEventListener('pointerdown', onDown, opts)
      canvas.removeEventListener('pointermove', onMove, opts)
      canvas.removeEventListener('pointerup', onUp, opts)
      canvas.removeEventListener('pointerleave', onLeave, opts)
      canvas.removeEventListener('pointercancel', onCancel, opts)
      canvas.style.cursor = savedCursor
      this.pointerCancel()
    }
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
    return this.tick()
  }

  /** Advance every running press animation by the wall clock. */
  private tick(): boolean {
    const now = this.now()
    const dt = this.lastTick > 0 ? now - this.lastTick : 0
    this.lastTick = now
    let animating = false
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
      this.geometryDirty = true
    }
    if (!animating) this.lastTick = 0
    return animating
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.entries.size === 0) return
    const scale = this.cssUnits ? frame.dpr : 1
    if (scale !== this.scale) {
      this.scale = scale
      for (const entry of this.entries.values()) entry.layout = null
      this.geometryDirty = true
    }
    const animating = this.tick()
    if (this.geometryDirty) this.rebuild()
    this.rects.drawOverlay(frame)
    this.labels.drawOverlay(frame)
    if (animating) this.requestRedraw?.()
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.rects.destroy()
    this.labels.destroy()
  }

  private invalidate(): void {
    this.geometryDirty = true
    this.requestRedraw?.()
  }

  private startAnimation(): void {
    this.lastTick = this.now()
    this.invalidate()
  }

  private scaled(entry: ButtonEntry): { spec: ButtonSpec; style: ButtonStyle } {
    return scaleButton(entry.spec, entry.style, this.scale)
  }

  private layoutOf(entry: ButtonEntry): ButtonLayout {
    if (!entry.layout) {
      const { spec, style } = this.scaled(entry)
      entry.layout = layoutButton(spec, style, this.font.metrics)
    }
    return entry.layout
  }

  /** The topmost (last added) enabled button under a canvas point. */
  private hitTest(x: number, y: number): ButtonEntry | null {
    const list = [...this.entries.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry.spec.enabled === false) continue
      if (buttonContains(this.layoutOf(entry), x, y)) return entry
    }
    return null
  }

  private rebuild(): void {
    const rects: RectData[] = []
    const text: UIKitTextItem[] = []
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const geo = buildButton(
        spec,
        style,
        this.font.metrics,
        this.layoutOf(entry),
        {
          hover: entry.hover,
          press: entry.press,
          enabled: entry.spec.enabled !== false,
        },
      )
      rects.push(geo.rect)
      text.push(geo.text)
    }
    this.rects.setRects(rects)
    this.labels.setItems(text)
    this.geometryDirty = false
  }
}
