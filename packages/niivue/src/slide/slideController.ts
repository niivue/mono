import { crosshairPanThresholdCssPx } from '@/control/dragModes'
import { DRAG_MODE } from '@/NVConstants'
import type { NVSlide, NVSlideScreen } from './NVSlide'

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
  /** Left button. Default `crosshairPan`: click to locate, drag to pan. */
  primaryDragMode?: DRAG_MODE
  /** Right button. Default `pan`. */
  secondaryDragMode?: DRAG_MODE
  /** A crosshair placed at a slide point. */
  onCrosshair?: (point: NVSlidePoint) => void
  /**
   * A windowing drag moved by (dx, dy) CSS pixels since the last call; `done`
   * on release. As NiiVue's windowing: x widens the window, y lowers its centre.
   */
  onWindow?: (dx: number, dy: number, done: boolean) => void
  /**
   * A contrast drag released over this box (slide base pixels). As NiiVue's
   * contrast mode, the app sets the window to the intensity range inside it.
   */
  onContrast?: (box: NVSlideMeasurement) => void
  /** Something to redraw: a ruler grew, or the measurements changed. */
  onChange?: () => void
}

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
 * `crosshairPan`, `windowing`, `contrast` (a box), `measurement` or `none`.
 * The wheel always zooms about the pointer. `slideOverlayContent` draws the
 * rulers and the contrast box.
 */
export class NVSlideController {
  primaryDragMode: DRAG_MODE
  secondaryDragMode: DRAG_MODE
  /** Completed rulers, in slide base pixels. */
  readonly measurements: NVSlideMeasurement[] = []
  /** The ruler being dragged, or null. */
  activeMeasurement: NVSlideMeasurement | null = null
  /** The box a contrast drag is selecting, or null. */
  selection: NVSlideMeasurement | null = null

  private readonly _canvas: HTMLCanvasElement
  private readonly _options: NVSlideControllerOptions
  private _gesture: Gesture | null = null

  constructor(canvas: HTMLCanvasElement, options: NVSlideControllerOptions) {
    this._canvas = canvas
    this._options = options
    this.primaryDragMode = options.primaryDragMode ?? DRAG_MODE.crosshairPan
    this.secondaryDragMode = options.secondaryDragMode ?? DRAG_MODE.pan
    canvas.addEventListener('pointerdown', this._onDown)
    canvas.addEventListener('pointermove', this._onMove)
    canvas.addEventListener('pointerup', this._onEnd)
    canvas.addEventListener('pointercancel', this._onEnd)
    // Capture taken elsewhere ends the gesture, or later presses are ignored.
    canvas.addEventListener('lostpointercapture', this._onEnd)
    canvas.addEventListener('wheel', this._onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this._onContextMenu)
  }

  /** Drop every ruler. */
  clearMeasurements(): void {
    this.measurements.length = 0
    this.activeMeasurement = null
    this._options.onChange?.()
  }

  dispose(): void {
    if (this._gesture) this._end(this._gesture, false)
    const c = this._canvas
    c.removeEventListener('pointerdown', this._onDown)
    c.removeEventListener('pointermove', this._onMove)
    c.removeEventListener('pointerup', this._onEnd)
    c.removeEventListener('pointercancel', this._onEnd)
    c.removeEventListener('lostpointercapture', this._onEnd)
    c.removeEventListener('wheel', this._onWheel)
    c.removeEventListener('contextmenu', this._onContextMenu)
  }

  private _modeFor(button: number): DRAG_MODE {
    if (button === 0) return this.primaryDragMode
    return button === 2 ? this.secondaryDragMode : DRAG_MODE.none
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
    // One gesture at a time: a second finger or pen is ignored.
    if (this._gesture) return
    const mode = this._modeFor(event.button)
    const slide = this._options.slide()
    if (mode === DRAG_MODE.none || !slide) return
    const [x, y] = this._local(event)
    this._gesture = {
      pointerId: event.pointerId,
      mode,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      isDrag: false,
    }
    this._canvas.setPointerCapture(event.pointerId)
    if (mode === DRAG_MODE.crosshair) this._crosshairAt(x, y)
    const start = slide.screenToSlide(x, y, this._options.screen())
    if (mode === DRAG_MODE.measurement)
      this.activeMeasurement = { start, end: { ...start } }
    if (mode === DRAG_MODE.contrast)
      this.selection = { start, end: { ...start } }
  }

  private _onMove = (event: PointerEvent): void => {
    const g = this._gesture
    if (!g || g.pointerId !== event.pointerId) return
    const [x, y] = this._local(event)
    if (
      !g.isDrag &&
      Math.hypot(x - g.startX, y - g.startY) < crosshairPanThresholdCssPx
    )
      return
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
        this._options.onWindow?.(dx, dy, false)
        break
      case DRAG_MODE.contrast:
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
    const g = this._gesture
    if (!g || g.pointerId !== event.pointerId) return
    this._end(g, event.type === 'pointerup')
  }

  /** The box a contrast or measurement drag is shaping. */
  private _boxFor(mode: DRAG_MODE): NVSlideMeasurement | null {
    if (mode === DRAG_MODE.contrast) return this.selection
    return mode === DRAG_MODE.measurement ? this.activeMeasurement : null
  }

  private _end(g: Gesture, committed: boolean): void {
    this._gesture = null
    if (this._canvas.hasPointerCapture(g.pointerId))
      this._canvas.releasePointerCapture(g.pointerId)
    if (committed && g.mode === DRAG_MODE.crosshairPan && !g.isDrag)
      this._crosshairAt(g.startX, g.startY)
    if (g.mode === DRAG_MODE.windowing && g.isDrag)
      this._options.onWindow?.(0, 0, true)
    const box = this._boxFor(g.mode)
    if (!box) return
    this.selection = null
    this.activeMeasurement = null
    if (committed && g.isDrag) {
      if (g.mode === DRAG_MODE.contrast) this._options.onContrast?.(box)
      else this.measurements.push(box)
    }
    this._options.onChange?.()
  }

  private _onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const slide = this._options.slide()
    if (!slide) return
    const [x, y] = this._local(event)
    const screen = this._options.screen()
    // Line (1) and page (2) deltas (Firefox, some mice) are not CSS px.
    const px =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * screen.heightCss
          : event.deltaY
    slide.zoomBy(Math.exp(-px * 0.0013), x, y, screen)
  }

  // The secondary button drags; the browser menu would interrupt it.
  private _onContextMenu = (event: Event): void => {
    event.preventDefault()
  }
}
