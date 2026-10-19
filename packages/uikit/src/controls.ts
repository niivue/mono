// The UIKit control layer: one place that owns the canvas pointer and keyboard
// for every interactive widget overlay, so they never compete for an event.
//
// Widgets (buttons, toggles, sliders, menus) implement `UIKitInteractive`: the
// overlay draw hook plus hit-testing and pointer/keyboard entry points in canvas
// pixels. `UIKitControls` holds them in z-order (last added on top) and routes:
//
//   - pointer down goes to the topmost widget that claims it; that widget then
//     owns ("captures") every move and the up, however far the pointer strays,
//     and becomes the keyboard focus. A down nobody claims clears the focus.
//     One pointer at a time: any new down first cancels the press a widget
//     still holds, even when the same widget takes the new one.
//   - hover moves go to the topmost widget under the pointer; everyone else is
//     told the pointer is away, so two widgets never highlight at once.
//   - a modal widget (an overlay with an open menu) gets every pointer and key
//     event first, until it stops being modal; a click outside its popup is its
//     own to dismiss.
//   - keys go to the modal widget, else the focused one.
//   - a press anywhere else in the page, focus moving to another element, or
//     the window losing focus deactivates the layer: the capture is cancelled,
//     popups are dismissed and the focus is dropped, so keys reach the page
//     again instead of the last widget the user touched. A canvas press, or a
//     widget opened or focused from code (through `focus`), takes them back.
//
// `attach(host)` installs capture-phase listeners on the canvas (and a
// capture-phase keydown on the window, where NiiVue listens too) and stops
// propagation of anything a widget consumed, so a click on a control never also
// starts a NiiVue drag or moves the crosshair. Registered as the overlay
// renderer, it draws its widgets in order and their popups on top of everything.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'

/** What `attach` needs from a host: a NiiVue controller satisfies it as-is. */
export interface UIKitHost {
  canvas: HTMLCanvasElement | null
  /** Client (CSS) coordinates to canvas backing-store pixels, or null if outside. */
  clientToCanvas(clientX: number, clientY: number): [number, number] | null
  /** Schedule a redraw of the scene (and so of the overlays). */
  drawScene(): void
}

/** The parts of a keyboard event a widget reacts to. */
export interface UIKitKeyEvent {
  /** The DOM `KeyboardEvent.key` value ('ArrowLeft', 'Enter', ' ', 'a', ...). */
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * Something the control layer can bind a widget to: redraw requests, and a
 * way to take the keyboard back when the widget opens or focuses from code.
 */
export interface UIKitRedrawSource {
  requestRedraw(): void
  /**
   * Make `child` the keyboard focus and let the layer route keys again, as a
   * canvas press would. Widgets call it from their own `open` and `focus`
   * so a dialog opened from a page button gets its keys at once.
   */
  focus?(child: UIKitInteractive): void
}

/**
 * An interactive overlay: drawn through the overlay hook and fed pointer and
 * keyboard input in canvas pixels. Every pointer method returns whether the
 * widget consumed the event (the host must then not treat it as a scene
 * interaction).
 */
export interface UIKitInteractive extends UIKitOverlayRenderer {
  /** True when (x, y) is over an interactive part (hover routing, cursor). */
  hitTest(x: number, y: number): boolean
  pointerDown(x: number, y: number): boolean
  /** Pass a point off the canvas (e.g. -1, -1) when the pointer leaves. */
  pointerMove(x: number, y: number): boolean
  pointerUp(x: number, y: number): boolean
  /** Abandon a held interaction without completing it. */
  pointerCancel(): void
  /** Handle a key while focused or modal. Return true to consume it. */
  keyDown?(e: UIKitKeyEvent): boolean
  /**
   * Whether a key this widget took should also submit the dialog it sits
   * in, as Enter in a form's text field submits the form. A text area's
   * Enter (a new line) and a select's (opening its list) do not.
   */
  submitsForm?(e: UIKitKeyEvent): boolean
  /**
   * Handle a wheel turn over (x, y), deltas in pixels (positive is down and
   * right). Sent to the modal widget first, else the widget under the point.
   * Return true to consume it (the page then does not scroll).
   */
  wheel?(x: number, y: number, deltaX: number, deltaY: number): boolean
  /** Drop keyboard focus (another widget took it, or the scene was clicked). */
  blur?(): void
  /** True while this widget must see every event first (an open popup). */
  isModal?(): boolean
  /** Close any popup without choosing (the pointer or focus went elsewhere in the page). */
  dismiss?(): void
  /** CSS cursor to show while this widget is hovered or captured. */
  readonly hoverCursor?: string
  /** Draw anything that must sit above every other widget (a popup). */
  drawPopup?(frame: UIKitOverlayFrame): void
  /**
   * Called when added to a control layer: a widget without its own redraw
   * requester should take the layer's, and may stop drawing its popup from
   * `drawOverlay` because the layer calls `drawPopup` after all widgets.
   */
  bindLayer?(layer: UIKitRedrawSource): void
  destroy?(): void
}

export interface UIKitControlsOptions {
  /** Called whenever a widget needs a frame. `attach` defaults it to `drawScene`. */
  requestRedraw?: () => void
}

/** True for an element where the user is typing, so the layer leaves keys alone. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement))
    return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  )
}

export class UIKitControls implements UIKitOverlayRenderer, UIKitRedrawSource {
  private readonly children: UIKitInteractive[] = []
  private redraw: (() => void) | null
  private captured: UIKitInteractive | null = null
  private focused: UIKitInteractive | null = null
  private hovered: UIKitInteractive | null = null
  private active = true

  constructor(options: UIKitControlsOptions = {}) {
    this.redraw = options.requestRedraw ?? null
  }

  /** Add a widget on top of the existing ones. Returns the layer for chaining. */
  add(child: UIKitInteractive): this {
    if (!this.children.includes(child)) {
      this.children.push(child)
      child.bindLayer?.(this)
    }
    return this
  }

  remove(child: UIKitInteractive): void {
    const i = this.children.indexOf(child)
    if (i < 0) return
    this.children.splice(i, 1)
    if (this.captured === child) {
      child.pointerCancel()
      this.captured = null
    }
    if (this.focused === child) this.focused = null
    if (this.hovered === child) this.hovered = null
  }

  /** The widgets in draw order (bottom first). */
  get widgets(): readonly UIKitInteractive[] {
    return this.children
  }

  /** The widget holding keyboard focus, if any. */
  get focusedWidget(): UIKitInteractive | null {
    return this.focused
  }

  /** The widget that currently owns the pointer (a held press or drag). */
  get capturedWidget(): UIKitInteractive | null {
    return this.captured
  }

  /** The widget that must see every event first, if any. */
  get modalWidget(): UIKitInteractive | null {
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i]
      if (c.isModal?.()) return c
    }
    return null
  }

  /** CSS cursor for the current hover or capture, or null for the default. */
  get hoverCursor(): string | null {
    const c = this.captured ?? this.hovered
    return c?.hoverCursor ?? null
  }

  requestRedraw(): void {
    this.redraw?.()
  }

  /**
   * Give keyboard focus to a widget (blurring the previous one). With a
   * widget this also ends a `deactivate`: the layer routes keys again.
   */
  focus(child: UIKitInteractive | null): void {
    if (child) this.active = true
    if (this.focused === child) return
    this.focused?.blur?.()
    this.focused = child
  }

  blur(): void {
    this.focus(null)
  }

  /**
   * Drop every live interaction: cancel a held press, dismiss open popups and
   * blur the focus. `attach` calls this when the user presses outside the
   * canvas, moves focus to another element or leaves the window, so the
   * layer stops consuming keys the page should get.
   */
  deactivate(): void {
    this.active = false
    this.pointerCancel()
    for (const c of this.children) {
      if (c.isModal?.()) c.dismiss?.()
    }
    this.blur()
  }

  /** Pointer down at canvas pixel (x, y): true when a widget took it. */
  pointerDown(x: number, y: number): boolean {
    this.active = true
    // One pointer at a time: a second down (another touch, or a down whose
    // up was never seen) ends the press the first one still holds before any
    // widget, including the same one, sees the new press.
    this.pointerCancel()
    const modal = this.modalWidget
    const targets = modal ? [modal] : this.topDown()
    for (const c of targets) {
      if (c.pointerDown(x, y)) {
        this.captured = c
        this.focus(c)
        return true
      }
    }
    this.blur()
    return false
  }

  /**
   * Pointer move to canvas pixel (x, y), or off-canvas coordinates when the
   * pointer leaves. True while a widget owns the pointer or a modal is up.
   */
  pointerMove(x: number, y: number): boolean {
    if (this.captured) {
      this.hovered = this.captured
      return this.captured.pointerMove(x, y) || true
    }
    const modal = this.modalWidget
    let hovered: UIKitInteractive | null = null
    for (const c of this.topDown()) {
      if (c === modal) {
        // The modal widget tracks the pointer everywhere (to highlight its
        // items and notice the pointer leaving them).
        c.pointerMove(x, y)
        hovered = c
      } else if (!modal && hovered === null && c.hitTest(x, y)) {
        c.pointerMove(x, y)
        hovered = c
      } else {
        c.pointerMove(-1, -1)
      }
    }
    this.hovered = hovered
    return modal !== null
  }

  /** Pointer up at canvas pixel (x, y): true when a widget owned the pointer. */
  pointerUp(x: number, y: number): boolean {
    const c = this.captured
    if (!c) return false
    this.captured = null
    c.pointerUp(x, y)
    // Re-evaluate hover now that nothing owns the pointer.
    this.pointerMove(x, y)
    return true
  }

  pointerCancel(): void {
    const c = this.captured
    this.captured = null
    c?.pointerCancel()
  }

  /**
   * Route a key to the modal widget, else the focused one. True if consumed.
   * The layer owns keys until `deactivate`, and again from the next canvas
   * press or `focus` call; an open dialog does not keep them once the user
   * has moved to the rest of the page.
   */
  keyDown(e: UIKitKeyEvent): boolean {
    if (!this.active) return false
    const target = this.modalWidget ?? this.focused
    return target?.keyDown?.(e) ?? false
  }

  /**
   * Route a wheel turn to the modal widget, else to the topmost widget under
   * (x, y) that handles wheels. True if consumed.
   */
  wheel(x: number, y: number, deltaX: number, deltaY: number): boolean {
    const modal = this.modalWidget
    if (modal) return modal.wheel?.(x, y, deltaX, deltaY) ?? false
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i]
      if (c.wheel && c.hitTest(x, y)) return c.wheel(x, y, deltaX, deltaY)
    }
    return false
  }

  /**
   * Wire the host canvas's pointer and wheel events (and the window's keydown)
   * to this layer and return a function that unwires them. Events a widget consumes are
   * stopped before the host's own handlers run; the cursor follows the widgets.
   */
  attach(host: UIKitHost): () => void {
    const canvas = host.canvas
    if (!canvas) throw new Error('UIKit: host has no canvas to attach to')
    this.redraw ??= () => host.drawScene()
    const savedCursor = canvas.style.cursor
    const syncCursor = (): void => {
      canvas.style.cursor = this.hoverCursor ?? savedCursor
    }
    const consume = (e: Event): void => {
      e.stopImmediatePropagation()
      e.preventDefault()
    }
    // The pointer holding the press: a second pointer's down takes the press
    // over (the layer is single-pointer), and the first one's later moves and
    // release are ignored rather than finishing a press it no longer holds.
    let held: number | null = null
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const p = host.clientToCanvas(e.clientX, e.clientY)
      if (!p) return
      const taken = this.pointerDown(p[0], p[1])
      held = taken ? e.pointerId : null
      if (!taken) return
      consume(e)
      syncCursor()
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // Capture is best-effort: the window-level pointerup/pointercancel
        // listeners below end the interaction when it was not granted.
      }
    }
    const onMove = (e: PointerEvent): void => {
      if (held !== null && e.pointerId !== held) return
      const p = host.clientToCanvas(e.clientX, e.clientY)
      const consumed = p
        ? this.pointerMove(p[0], p[1])
        : this.pointerMove(-1, -1)
      syncCursor()
      if (consumed) consume(e)
    }
    const release = (e: PointerEvent): boolean => {
      held = null
      const p = host.clientToCanvas(e.clientX, e.clientY) ?? [-1, -1]
      const consumed = this.pointerUp(p[0], p[1])
      syncCursor()
      return consumed
    }
    const onUp = (e: PointerEvent): void => {
      if (held !== null && e.pointerId !== held) return
      if (release(e)) consume(e)
    }
    const onLeave = (): void => {
      this.pointerMove(-1, -1)
      syncCursor()
    }
    const onCancel = (e: PointerEvent): void => {
      if (held !== null && e.pointerId !== held) return
      held = null
      this.pointerCancel()
      onLeave()
    }
    // Without pointer capture a release (or cancel) outside the canvas lands
    // on whatever element is under the pointer, never on the canvas, and the
    // captured widget would stay captured. Finish it from the window instead,
    // leaving the event to the element it targets; with capture the event
    // targets the canvas and the handlers above run.
    const onOutsideUp = (e: PointerEvent): void => {
      if (e.target === canvas || !this.captured || e.pointerId !== held) return
      release(e)
    }
    const onOutsideCancel = (e: PointerEvent): void => {
      if (e.target === canvas || !this.captured || e.pointerId !== held) return
      onCancel(e)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target)) return
      const consumed = this.keyDown({
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      })
      if (consumed) consume(e)
    }
    const onWheel = (e: WheelEvent): void => {
      const p = host.clientToCanvas(e.clientX, e.clientY)
      if (!p) return
      // Lines and pages become pixels so widgets see one unit.
      const k =
        e.deltaMode === 1
          ? 16
          : e.deltaMode === 2
            ? canvas.clientHeight || 1
            : 1
      if (!this.wheel(p[0], p[1], e.deltaX * k, e.deltaY * k)) return
      consume(e)
      syncCursor()
    }
    // Anything outside the canvas (a press elsewhere in the page, focus moving
    // to another element, the window losing focus) ends our turn with the keys.
    const onOutsideDown = (e: Event): void => {
      if (e.target === canvas) return
      held = null
      this.deactivate()
      syncCursor()
    }
    const onWindowBlur = (): void => {
      held = null
      this.deactivate()
      syncCursor()
    }
    const opts = { capture: true }
    // A wheel listener must opt out of passive to be allowed to preventDefault.
    const wheelOpts = { capture: true, passive: false }
    canvas.addEventListener('pointerdown', onDown, opts)
    canvas.addEventListener('pointermove', onMove, opts)
    canvas.addEventListener('pointerup', onUp, opts)
    canvas.addEventListener('pointerleave', onLeave, opts)
    canvas.addEventListener('pointercancel', onCancel, opts)
    canvas.addEventListener('wheel', onWheel, wheelOpts)
    window.addEventListener('keydown', onKey, opts)
    window.addEventListener('pointerup', onOutsideUp, opts)
    window.addEventListener('pointercancel', onOutsideCancel, opts)
    window.addEventListener('pointerdown', onOutsideDown, opts)
    window.addEventListener('focusin', onOutsideDown, opts)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      canvas.removeEventListener('pointerdown', onDown, opts)
      canvas.removeEventListener('pointermove', onMove, opts)
      canvas.removeEventListener('pointerup', onUp, opts)
      canvas.removeEventListener('pointerleave', onLeave, opts)
      canvas.removeEventListener('pointercancel', onCancel, opts)
      canvas.removeEventListener('wheel', onWheel, wheelOpts)
      window.removeEventListener('keydown', onKey, opts)
      window.removeEventListener('pointerup', onOutsideUp, opts)
      window.removeEventListener('pointercancel', onOutsideCancel, opts)
      window.removeEventListener('pointerdown', onOutsideDown, opts)
      window.removeEventListener('focusin', onOutsideDown, opts)
      window.removeEventListener('blur', onWindowBlur)
      canvas.style.cursor = savedCursor
      this.pointerCancel()
      this.blur()
    }
  }

  /** Draw every widget in order, then every popup on top. */
  drawOverlay(frame: UIKitOverlayFrame): void {
    for (const c of this.children) c.drawOverlay(frame)
    for (const c of this.children) c.drawPopup?.(frame)
  }

  /** Release every widget's GPU resources. */
  destroy(): void {
    for (const c of this.children) c.destroy?.()
  }

  private topDown(): UIKitInteractive[] {
    return [...this.children].reverse()
  }
}
