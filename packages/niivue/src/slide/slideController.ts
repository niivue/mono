import { DRAG_MODE } from '@/NVConstants'
import type { NVSlide, NVSlideScreen } from './NVSlide'

/** A point in slide base-level pixels. */
export type NVSlidePoint = { x: number; y: number }

/** A ruler between two slide base-pixel points, so it stays on the tissue. */
export interface NVSlideMeasurement {
  start: NVSlidePoint
  end: NVSlidePoint
}

/** The drag modes an NVSlide pane honours; any other value acts as `none`. */
export const SLIDE_DRAG_MODES: readonly DRAG_MODE[] = [
  DRAG_MODE.none,
  DRAG_MODE.pan,
  DRAG_MODE.crosshair,
  DRAG_MODE.crosshairPan,
  DRAG_MODE.windowing,
  DRAG_MODE.contrast,
  DRAG_MODE.measurement,
]

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
  /** A ruler completed (also kept in {@link NVSlideController.measurements}). */
  onMeasure?: (measurement: NVSlideMeasurement) => void
  /** Something to redraw: a ruler grew, or the measurements changed. */
  onChange?: () => void
}

// The same click-or-drag threshold as NiiVue's crosshairPan.
const DRAG_THRESHOLD_CSS = 4

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
 * `crosshairPan`, `windowing` (and `contrast`, which drags the window the same
 * way), `measurement` or `none`. The wheel always zooms about the pointer.
 */
export class NVSlideController {
  primaryDragMode: DRAG_MODE
  secondaryDragMode: DRAG_MODE
  /** Completed rulers, in slide base pixels. */
  readonly measurements: NVSlideMeasurement[] = []
  /** The ruler being dragged, or null. */
  activeMeasurement: NVSlideMeasurement | null = null

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
    canvas.addEventListener('pointerup', this._onUp)
    canvas.addEventListener('pointercancel', this._onCancel)
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
    const c = this._canvas
    c.removeEventListener('pointerdown', this._onDown)
    c.removeEventListener('pointermove', this._onMove)
    c.removeEventListener('pointerup', this._onUp)
    c.removeEventListener('pointercancel', this._onCancel)
    c.removeEventListener('wheel', this._onWheel)
    c.removeEventListener('contextmenu', this._onContextMenu)
  }

  private _modeFor(button: number): DRAG_MODE {
    const mode =
      button === 0
        ? this.primaryDragMode
        : button === 2
          ? this.secondaryDragMode
          : DRAG_MODE.none
    return SLIDE_DRAG_MODES.includes(mode) ? mode : DRAG_MODE.none
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
    const mode = this._modeFor(event.button)
    if (mode === DRAG_MODE.none || !this._options.slide()) return
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
    this._canvas.setPointerCapture?.(event.pointerId)
    if (mode === DRAG_MODE.crosshair) this._crosshairAt(x, y)
    if (mode === DRAG_MODE.measurement) {
      const start = this._slidePoint(x, y)
      if (start) this.activeMeasurement = { start, end: { ...start } }
    }
  }

  private _onMove = (event: PointerEvent): void => {
    const g = this._gesture
    if (!g || g.pointerId !== event.pointerId) return
    const [x, y] = this._local(event)
    if (
      !g.isDrag &&
      Math.hypot(x - g.startX, y - g.startY) < DRAG_THRESHOLD_CSS
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
      case DRAG_MODE.contrast:
        this._options.onWindow?.(dx, dy, false)
        break
      case DRAG_MODE.measurement: {
        const end = this._slidePoint(x, y)
        if (this.activeMeasurement && end) {
          this.activeMeasurement.end = end
          this._options.onChange?.()
        }
        break
      }
    }
  }

  private _onUp = (event: PointerEvent): void => {
    const g = this._gesture
    if (!g || g.pointerId !== event.pointerId) return
    this._end(g, true)
  }

  private _onCancel = (event: PointerEvent): void => {
    const g = this._gesture
    if (!g || g.pointerId !== event.pointerId) return
    this._end(g, false)
  }

  private _end(g: Gesture, committed: boolean): void {
    this._gesture = null
    this._canvas.releasePointerCapture?.(g.pointerId)
    if (committed && g.mode === DRAG_MODE.crosshairPan && !g.isDrag)
      this._crosshairAt(g.startX, g.startY)
    if (g.mode === DRAG_MODE.windowing || g.mode === DRAG_MODE.contrast)
      this._options.onWindow?.(0, 0, true)
    if (g.mode === DRAG_MODE.measurement) {
      const ruler = this.activeMeasurement
      this.activeMeasurement = null
      if (committed && ruler && g.isDrag) {
        this.measurements.push(ruler)
        this._options.onMeasure?.(ruler)
      }
      this._options.onChange?.()
    }
  }

  private _onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const slide = this._options.slide()
    if (!slide) return
    const [x, y] = this._local(event)
    slide.zoomBy(Math.exp(-event.deltaY * 0.0013), x, y, this._options.screen())
  }

  // The secondary button drags; the browser menu would interrupt it.
  private _onContextMenu = (event: Event): void => {
    event.preventDefault()
  }
}
