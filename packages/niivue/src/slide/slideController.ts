import { crosshairPanThresholdCssPx } from '@/control/dragModes'
import { DRAG_MODE } from '@/NVConstants'
import type { NVSlide, NVSlideScreen, NVSlideWindow } from './NVSlide'
import { isRgbSlide } from './slideChannels'

/** A point in slide base-level pixels. */
export type NVSlidePoint = { x: number; y: number }

/** A ruler between two slide base-pixel points, so it stays on the tissue. */
export interface NVSlideMeasurement {
  start: NVSlidePoint
  end: NVSlidePoint
}

export interface NVSlideControllerOptions {
  /** The slide on show; read on every event, so an app may rebuild it. */
  slide: () => NVSlide | null
  /** The pane's size in CSS pixels. */
  screen: () => NVSlideScreen
  /**
   * Left button. Default `crosshairPan`: click to locate, drag to pan.
   * `roiSelection` drags a box and zooms the view to fit it on release, no
   * finer than native resolution.
   */
  primaryDragMode?: DRAG_MODE
  /** Right button. Default `pan`. */
  secondaryDragMode?: DRAG_MODE
  /** A crosshair placed at a slide point. */
  onCrosshair?: (point: NVSlidePoint) => void
  /**
   * The pointer moved over the pane with no gesture under way (null when it
   * leaves), e.g. for `slide.sampleAt(point.x, point.y)`.
   */
  onHover?: (point: NVSlidePoint | null) => void
  /**
   * A windowing drag moved by (dx, dy) CSS pixels since the last call; `done`
   * on release (a click without a drag reports nothing). As NiiVue's windowing:
   * x widens the window, y lowers its centre. Default: `windowChannel`'s
   * window follows the drag live ({@link windowDragStep}).
   */
  onWindow?: (dx: number, dy: number, done: boolean) => void
  /**
   * A contrast drag released over this box (slide base pixels). As NiiVue's
   * contrast mode, the app sets the window to the intensity range inside it.
   * Default: `windowChannel`'s window becomes the range of its resident
   * samples in the box.
   */
  onContrast?: (box: NVSlideMeasurement) => void
  /**
   * A `callbackOnly` drag moved by (dx, dy) CSS pixels to (x, y); `done` on
   * release. For app-defined drags (a zoom tool, say).
   */
  onDrag?: (dx: number, dy: number, x: number, y: number, done: boolean) => void
  /** Something to redraw: a ruler grew, or the measurements changed. */
  onChange?: () => void
}

/** Stored-unit window of `slide`'s channel `c`: its own, else the sample range. */
function channelWindow(slide: NVSlide, c: number): [number, number] {
  const ch = slide.channels[c]
  if (ch && Number.isFinite(ch.calMin) && Number.isFinite(ch.calMax))
    return [ch.calMin, ch.calMax]
  const level = slide.manifest.levels[0]
  if (level?.sampleType === 'i16') return [-32768, 32767]
  return [0, 2 ** (level?.bitsStored ?? 8) - 1]
}

/**
 * One windowing drag step, as NiiVue's: 0.5% of the window the drag started
 * with per CSS pixel; x widens the window, y lowers its centre.
 */
export function windowDragStep(
  start: readonly [number, number],
  now: readonly [number, number],
  dx: number,
  dy: number,
): [number, number] {
  const step = (start[1] - start[0]) * 0.005
  const width = Math.max(step, now[1] - now[0] + dx * step)
  const centre = (now[0] + now[1]) / 2 - dy * step
  return [centre - width / 2, centre + width / 2]
}

// ponytail: a 32x32 grid of resident samples, not every pixel in the box.
const CONTRAST_GRID = 32

/** Modes that drag the `selection` box. */
const isBoxMode = (mode: DRAG_MODE): boolean =>
  mode === DRAG_MODE.contrast || mode === DRAG_MODE.roiSelection

type Gesture = {
  pointerId: number
  mode: DRAG_MODE
  startX: number
  startY: number
  lastX: number
  lastY: number
  isDrag: boolean
}

/**
 * Pointer and wheel gestures for an NVSlide on its own canvas, with a primary
 * (left) and secondary (right) drag mode as NiiVue has: `pan`, `crosshair`,
 * `crosshairPan`, `windowing`, `contrast` (a box), `roiSelection` (zoom to a
 * box), `measurement` or `none`. The middle button pans and the wheel zooms
 * about the pointer. `slideOverlayContent` draws the rulers and the boxes.
 */
export class NVSlideController {
  primaryDragMode: DRAG_MODE
  secondaryDragMode: DRAG_MODE
  /** Completed rulers, in slide base pixels. */
  readonly measurements: NVSlideMeasurement[] = []
  /** The ruler being dragged, or null. */
  activeMeasurement: NVSlideMeasurement | null = null
  /** The box a contrast or zoom (`roiSelection`) drag is selecting, or null. */
  selection: NVSlideMeasurement | null = null
  /** The channel the default windowing and contrast handlers set. */
  windowChannel = 0
  /** Double-click zooms in 2x about the pointer (shift: out) while the primary mode is `pan`. */
  isDoubleClickZoom = true
  /** Middle button. Default `pan`, as in OHIF and most slide viewers. */
  middleDragMode: DRAG_MODE = DRAG_MODE.pan
  /** Suppress the browser menu on the canvas, so a secondary drag is not interrupted. Default true. */
  isContextMenuBlocked = true
  /** Mouse buttons past the third (back, forward). Default `none`. */
  otherButtonDragMode: DRAG_MODE = DRAG_MODE.none
  /** A second finger turns a touch into a pinch zoom. Default true. */
  isPinchZoom = true
  /** Wheel zoom per CSS pixel of scroll: zoom factor exp(-delta * rate). */
  wheelZoomRate = 0.0013
  /** Scale line (Firefox, some mice) and page wheel deltas to CSS px. Default true. */
  isWheelDeltaModeScaled = true

  private readonly _canvas: HTMLCanvasElement
  private readonly _options: NVSlideControllerOptions
  private _gesture: Gesture | null = null
  // Touch points down on the canvas, for pinch.
  private readonly _touches = new Map<number, { x: number; y: number }>()
  private _pinch = false
  // Where the last left press that started a gesture here was (CSS px).
  private _pressedAt: [number, number] | null = null
  private _hoverFrame = 0
  private _hoverPoint: NVSlidePoint | null = null
  private _windowDrag: {
    start: [number, number]
    now: [number, number]
  } | null = null

  constructor(canvas: HTMLCanvasElement, options: NVSlideControllerOptions) {
    this._canvas = canvas
    this._options = options
    this.primaryDragMode = options.primaryDragMode ?? DRAG_MODE.crosshairPan
    this.secondaryDragMode = options.secondaryDragMode ?? DRAG_MODE.pan
    canvas.addEventListener('pointerdown', this._onDown)
    canvas.addEventListener('pointermove', this._onMove)
    canvas.addEventListener('pointerup', this._onEnd)
    canvas.addEventListener('pointercancel', this._onEnd)
    canvas.addEventListener('pointerleave', this._onLeave)
    // Capture taken elsewhere ends the gesture, or later presses are ignored.
    canvas.addEventListener('lostpointercapture', this._onEnd)
    canvas.addEventListener('wheel', this._onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this._onContextMenu)
    canvas.addEventListener('mousedown', this._onMouseDown)
    canvas.addEventListener('dblclick', this._onDoubleClick)
  }

  /** End a gesture under way without completing it (no ruler, box or zoom). */
  cancelGesture(): void {
    if (this._gesture) this._end(this._gesture, false)
  }

  /** Drop every ruler. */
  clearMeasurements(): void {
    this.measurements.length = 0
    this.activeMeasurement = null
    this._options.onChange?.()
  }

  dispose(): void {
    if (this._gesture) this._end(this._gesture, false)
    this._endPinch()
    this._touches.clear()
    cancelAnimationFrame(this._hoverFrame)
    const c = this._canvas
    c.removeEventListener('pointerdown', this._onDown)
    c.removeEventListener('pointermove', this._onMove)
    c.removeEventListener('pointerup', this._onEnd)
    c.removeEventListener('pointercancel', this._onEnd)
    c.removeEventListener('pointerleave', this._onLeave)
    c.removeEventListener('lostpointercapture', this._onEnd)
    c.removeEventListener('wheel', this._onWheel)
    c.removeEventListener('contextmenu', this._onContextMenu)
    c.removeEventListener('mousedown', this._onMouseDown)
    c.removeEventListener('dblclick', this._onDoubleClick)
  }

  private _modeFor(button: number): DRAG_MODE {
    if (button === 0) return this.primaryDragMode
    if (button === 1) return this.middleDragMode
    return button === 2 ? this.secondaryDragMode : this.otherButtonDragMode
  }

  private _local(event: PointerEvent | WheelEvent): [number, number] {
    const rect = this._canvas.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }

  private _slidePoint(x: number, y: number): NVSlidePoint | null {
    const slide = this._options.slide()
    return slide ? slide.screenToSlide(x, y, this._options.screen()) : null
  }

  private _crosshairAt(x: number, y: number): void {
    const point = this._slidePoint(x, y)
    if (point) this._options.onCrosshair?.(point)
  }

  private _onDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      this._touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (
        this.isPinchZoom &&
        this._touches.size === 2 &&
        this._options.slide()
      ) {
        // A second finger turns the touch into a pinch: zoom and pan together.
        if (this._gesture) this._end(this._gesture, false)
        this._pinch = true
        for (const id of this._touches.keys())
          this._canvas.setPointerCapture(id)
        return
      }
      if (this._pinch) return
    }
    // A press while a gesture is live but uncaptured (or from the same pointer)
    // means its release fell outside the canvas before capture: drop it. A pen
    // can return with a new pointerId, so the id alone is not enough.
    const live = this._gesture
    if (
      live &&
      (live.pointerId === event.pointerId ||
        !this._canvas.hasPointerCapture(live.pointerId))
    )
      this._end(live, false)
    // One gesture at a time: a second finger or pen is ignored.
    if (this._gesture) return
    const mode = this._modeFor(event.button)
    const slide = this._options.slide()
    if (mode === DRAG_MODE.none || !slide) return
    const [x, y] = this._local(event)
    this._pressedAt = event.button === 0 ? [x, y] : null
    this._gesture = {
      pointerId: event.pointerId,
      mode,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      isDrag: false,
    }
    if (mode === DRAG_MODE.crosshair) this._crosshairAt(x, y)
    const start = slide.screenToSlide(x, y, this._options.screen())
    if (mode === DRAG_MODE.measurement)
      this.activeMeasurement = { start, end: { ...start } }
    if (isBoxMode(mode)) this.selection = { start, end: { ...start } }
  }

  private _onMove = (event: PointerEvent): void => {
    if (this._pinch) {
      this._pinchMove(event)
      return
    }
    // Track a lone finger too, so a second one starts the pinch from where
    // this one is now, not where it pressed (the pinch keeps its own last).
    if (this._touches.has(event.pointerId))
      this._touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const g = this._gesture
    if (!g) {
      if (this._options.onHover) {
        const [x, y] = this._local(event)
        // One report per frame: a high-rate mouse can fire several moves each.
        this._hoverPoint = this._slidePoint(x, y)
        this._hoverFrame ||= requestAnimationFrame(() => {
          this._hoverFrame = 0
          this._options.onHover?.(this._hoverPoint)
        })
      }
      return
    }
    if (g.pointerId !== event.pointerId) return
    // Released outside the canvas before capture: the pointerup never came.
    if (event.buttons === 0) {
      this._end(g, false)
      return
    }
    const [x, y] = this._local(event)
    if (
      !g.isDrag &&
      Math.hypot(x - g.startX, y - g.startY) < crosshairPanThresholdCssPx
    )
      return
    // Capture only once it is a drag: a captured click can swallow the next
    // click elsewhere on the page (a header link needing two clicks).
    if (!g.isDrag) this._canvas.setPointerCapture(g.pointerId)
    g.isDrag = true
    const dx = x - g.lastX
    const dy = y - g.lastY
    g.lastX = x
    g.lastY = y
    const slide = this._options.slide()
    switch (g.mode) {
      case DRAG_MODE.pan:
      case DRAG_MODE.crosshairPan:
        slide?.panByScreenDelta(dx, dy, this._options.screen())
        break
      case DRAG_MODE.crosshair:
        this._crosshairAt(x, y)
        break
      case DRAG_MODE.windowing:
        if (this._options.onWindow) this._options.onWindow(dx, dy, false)
        else this._defaultWindow(dx, dy)
        break
      case DRAG_MODE.callbackOnly:
        this._options.onDrag?.(dx, dy, x, y, false)
        break
      case DRAG_MODE.contrast:
      case DRAG_MODE.roiSelection:
      case DRAG_MODE.measurement: {
        const box = this._boxFor(g.mode)
        const end = this._slidePoint(x, y)
        if (box && end) {
          box.end = end
          this._options.onChange?.()
        }
        break
      }
    }
  }

  private _onEnd = (event: PointerEvent): void => {
    // Capture moves between touch points during a pinch; only a lift ends one.
    if (
      event.type !== 'lostpointercapture' &&
      this._touches.delete(event.pointerId) &&
      this._pinch
    ) {
      this._endPinch()
      return
    }
    const g = this._gesture
    if (!g || g.pointerId !== event.pointerId) return
    this._end(g, event.type === 'pointerup')
  }

  // Leaving before capture: the release may land outside the canvas, and a
  // gesture left live would resume as a drag when a held button comes back.
  private _onLeave = (event: PointerEvent): void => {
    // Not after a pending move: its frame would bring the hover back.
    cancelAnimationFrame(this._hoverFrame)
    this._hoverFrame = 0
    this._options.onHover?.(null)
    const g = this._gesture
    if (
      g &&
      g.pointerId === event.pointerId &&
      !this._canvas.hasPointerCapture(g.pointerId)
    )
      this._end(g, false)
  }

  /** The box a contrast, zoom or measurement drag is shaping. */
  private _boxFor(mode: DRAG_MODE): NVSlideMeasurement | null {
    if (isBoxMode(mode)) return this.selection
    return mode === DRAG_MODE.measurement ? this.activeMeasurement : null
  }

  private _end(g: Gesture, committed: boolean): void {
    this._gesture = null
    if (this._canvas.hasPointerCapture(g.pointerId))
      this._canvas.releasePointerCapture(g.pointerId)
    if (committed && g.mode === DRAG_MODE.crosshairPan && !g.isDrag)
      this._crosshairAt(g.startX, g.startY)
    if (g.mode === DRAG_MODE.windowing && g.isDrag) {
      this._windowDrag = null
      this._options.onWindow?.(0, 0, true)
    }
    if (g.mode === DRAG_MODE.callbackOnly && g.isDrag)
      this._options.onDrag?.(0, 0, g.lastX, g.lastY, true)
    const box = this._boxFor(g.mode)
    if (!box) return
    this.selection = null
    this.activeMeasurement = null
    if (committed && g.isDrag) {
      if (g.mode === DRAG_MODE.contrast) {
        if (this._options.onContrast) this._options.onContrast(box)
        else this._defaultContrast(box)
      } else if (g.mode === DRAG_MODE.roiSelection) {
        // A box dragged back to a point would zoom to native resolution.
        if (
          Math.abs(g.lastX - g.startX) >= crosshairPanThresholdCssPx ||
          Math.abs(g.lastY - g.startY) >= crosshairPanThresholdCssPx
        )
          this._zoomTo(box)
      } else this.measurements.push(box)
    }
    this._options.onChange?.()
  }

  /**
   * Centre on a slide-pixel box and zoom in to fit it, no finer than one base
   * pixel per device pixel (OHIF's zoom box). It never zooms out; the wheel can
   * zoom past native resolution.
   */
  private _zoomTo({ start, end }: NVSlideMeasurement): void {
    const slide = this._options.slide()
    if (!slide) return
    const screen = this._options.screen()
    const w = Math.abs(end.x - start.x)
    const h = Math.abs(end.y - start.y)
    slide.setViewport({
      centerX: (start.x + end.x) / 2,
      centerY: (start.y + end.y) / 2,
      scale: Math.max(
        slide.viewport.scale,
        Math.min(
          screen.widthCss / w,
          screen.heightCss / h,
          1 / (screen.devicePixelRatio ?? 1),
        ),
      ),
    })
    slide.clampViewport(screen)
  }

  private _onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const slide = this._options.slide()
    if (!slide) return
    const [x, y] = this._local(event)
    const screen = this._options.screen()
    // Line (1) and page (2) deltas (Firefox, some mice) are not CSS px.
    const px = !this.isWheelDeltaModeScaled
      ? event.deltaY
      : event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * screen.heightCss
          : event.deltaY
    slide.zoomBy(Math.exp(-px * this.wheelZoomRate), x, y, screen)
  }

  private _pinchMove(event: PointerEvent): void {
    const prev = this._touches.get(event.pointerId)
    const slide = this._options.slide()
    if (!prev || !slide) return
    const pts = [...this._touches.values()]
    const [a0, b0] = pts as [{ x: number; y: number }, { x: number; y: number }]
    const before = {
      d: Math.hypot(a0.x - b0.x, a0.y - b0.y),
      x: (a0.x + b0.x) / 2,
      y: (a0.y + b0.y) / 2,
    }
    this._touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const [a1, b1] = [...this._touches.values()] as [
      { x: number; y: number },
      { x: number; y: number },
    ]
    const d = Math.hypot(a1.x - b1.x, a1.y - b1.y)
    const mx = (a1.x + b1.x) / 2
    const my = (a1.y + b1.y) / 2
    const screen = this._options.screen()
    const rect = this._canvas.getBoundingClientRect()
    slide.panByScreenDelta(mx - before.x, my - before.y, screen)
    if (before.d > 0 && d > 0)
      slide.zoomBy(d / before.d, mx - rect.left, my - rect.top, screen)
  }

  // The finger left down starts nothing: a pan would jump to where it is.
  private _endPinch(): void {
    if (!this._pinch) return
    this._pinch = false
    for (const id of this._touches.keys())
      if (this._canvas.hasPointerCapture(id))
        this._canvas.releasePointerCapture(id)
  }

  // windowChannel outlives a slide swap: one past the new slide's channels is channel 0.
  private _windowTarget(slide: NVSlide): number {
    return this.windowChannel < slide.channels.length ? this.windowChannel : 0
  }

  private _defaultWindow(dx: number, dy: number): void {
    const slide = this._options.slide()
    if (!slide || isRgbSlide(slide.manifest)) return
    const c = this._windowTarget(slide)
    if (!this._windowDrag) {
      const start = channelWindow(slide, c)
      this._windowDrag = { start, now: start }
    }
    const d = this._windowDrag
    d.now = windowDragStep(d.start, d.now, dx, dy)
    slide.setChannel(c, { calMin: d.now[0], calMax: d.now[1] })
  }

  private _defaultContrast({ start, end }: NVSlideMeasurement): void {
    const slide = this._options.slide()
    if (!slide || isRgbSlide(slide.manifest)) return
    const c = this._windowTarget(slide)
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (let j = 0; j < CONTRAST_GRID; j++)
      for (let i = 0; i < CONTRAST_GRID; i++) {
        const x = start.x + ((end.x - start.x) * (i + 0.5)) / CONTRAST_GRID
        const y = start.y + ((end.y - start.y) * (j + 0.5)) / CONTRAST_GRID
        const v = slide.sampleAt(x, y)[c]?.stored
        if (v === null || v === undefined) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    if (hi > lo)
      slide.setChannel(c, { calMin: lo, calMax: hi } satisfies NVSlideWindow)
  }

  private _onDoubleClick = (event: MouseEvent): void => {
    const slide = this._options.slide()
    const [x, y] = this._local(event as PointerEvent)
    // A widget over the canvas (a minimap) takes its presses before they
    // reach here: a double-click counts only where the last press here was.
    const at = this._pressedAt
    if (
      !slide ||
      !this.isDoubleClickZoom ||
      !at ||
      Math.hypot(x - at[0], y - at[1]) > crosshairPanThresholdCssPx ||
      this.primaryDragMode !== DRAG_MODE.pan
    )
      return
    slide.zoomBy(event.shiftKey ? 0.5 : 2, x, y, this._options.screen())
  }

  // A middle drag: browser auto-scroll (Windows, Linux) would fight it.
  private _onMouseDown = (event: MouseEvent): void => {
    if (event.button === 1 && this.middleDragMode !== DRAG_MODE.none)
      event.preventDefault()
  }

  // The secondary button drags; the browser menu would interrupt it.
  private _onContextMenu = (event: Event): void => {
    if (this.isContextMenuBlocked) event.preventDefault()
  }
}
