import type { NVSlide, NVSlideMeasurement, NVSlideScreen } from '@niivue/niivue'
import { createSlideView, DRAG_MODE } from '@niivue/niivue'
import type { RulerSpec } from '@niivue/uikit'
import { loadDefaultFont, UIKitRulerOverlay } from '@niivue/uikit'

export interface WsiSlideViewOptions {
  /**
   * Called when the measurement (ruler) changes: a formatted length string
   * while measuring, or null when the ruler is cleared. Lets the host reflect
   * the reading into its own status UI.
   */
  onMeasure?: (text: string | null) => void
  /**
   * Called when the view starts or stops drawing a coarser level than requested
   * because the requested one exceeds the tile cache: a message, or null.
   */
  onLevelLimit?: (text: string | null) => void
}

export interface WsiSlideView {
  setTool(tool: string | undefined): void
  resetView(): void
  /** Zoom about the canvas centre (factor > 1 zooms in). */
  zoom(factor: number): void
  /** Fit the whole slide, keeping the ruler. */
  fit(): void
  /** Monochrome display window (stored sample values); colour slides ignore it. */
  setWindow(calMin: number, calMax: number): void
  saveBitmap(filename?: string): Promise<void>
  dispose(): void
}

// The ruler is measured in slide base pixels, then converted to physical units
// when the slide carries pixel spacing: microns below 1 mm, millimetres (with
// per-mm ticks) above. Falls back to base slide pixels when no spacing exists.
const RULER_COLOR: readonly [number, number, number, number] = [1, 0.85, 0, 1]
// Label / line / tick sizes in CSS pixels; multiplied by devicePixelRatio at
// draw time because the overlay is drawn in device pixels.
const RULER_LABEL_CSS_PX = 28
const RULER_THICKNESS_CSS_PX = 2
const RULER_TICK_CSS_PX = 6

interface Measurement {
  length: number
  units: string
  decimals: number
  ticks: boolean
}

function measure(
  a: { x: number; y: number },
  b: { x: number; y: number },
  spacing: readonly [number, number] | undefined,
): Measurement {
  const dpx = b.x - a.x
  const dpy = b.y - a.y
  if (!spacing) {
    return {
      length: Math.hypot(dpx, dpy),
      units: 'px',
      decimals: 0,
      ticks: false,
    }
  }
  const mm = Math.hypot(dpx * spacing[0], dpy * spacing[1])
  return mm < 1
    ? { length: mm * 1000, units: 'um', decimals: 0, ticks: false }
    : { length: mm, units: 'mm', decimals: 2, ticks: true }
}

/**
 * Returns a ruler updater that pushes geometry only when the drawn spec
 * changes, and the host readout only when its text does: render() runs on
 * every tile arrival, and a pan moves the device-space endpoints while the
 * length stays the same. `null` clears the ruler and the readout.
 */
export function createRulerSync(
  ruler: Pick<UIKitRulerOverlay, 'setRuler' | 'clear'>,
  onMeasure?: (text: string | null) => void,
): (spec: RulerSpec | null, text?: string) => void {
  let lastSpec = ''
  let lastText: string | null = null
  return (spec, text = '') => {
    const sig = spec ? JSON.stringify(spec) : ''
    if (sig !== lastSpec) {
      lastSpec = sig
      if (spec) ruler.setRuler(spec)
      else ruler.clear()
    }
    const shown = spec ? text : null
    if (shown !== lastText) {
      lastText = shown
      onMeasure?.(shown)
    }
  }
}

// The OHIF tool runs on every button, as before; any tool but Length and
// Zoom pans.
const dragModeFor = (tool: string | undefined): DRAG_MODE =>
  tool === 'Length'
    ? DRAG_MODE.measurement
    : tool === 'Zoom'
      ? DRAG_MODE.callbackOnly
      : DRAG_MODE.pan

/** The UIKit ruler for a measurement on screen: device-pixel endpoints and sizes. */
export function rulerSpecFor(
  slide: Pick<NVSlide, 'slideToScreen' | 'manifest'>,
  { start, end }: NVSlideMeasurement,
  screen: NVSlideScreen,
): { spec: RulerSpec; text: string } {
  const m = measure(start, end, slide.manifest.pixelSpacingMM)
  // The overlay draws in device pixels, so sizes scale by dpr too.
  const dpr = screen.devicePixelRatio ?? 1
  const toDevice = (p: { x: number; y: number }): [number, number] => {
    const { xCss, yCss } = slide.slideToScreen(p.x, p.y, screen)
    return [xCss * dpr, yCss * dpr]
  }
  return {
    spec: {
      a: toDevice(start),
      b: toDevice(end),
      length: m.length,
      units: m.units,
      decimals: m.decimals,
      sizePx: RULER_LABEL_CSS_PX * dpr,
      thickness: RULER_THICKNESS_CSS_PX * dpr,
      tickLength: RULER_TICK_CSS_PX * dpr,
      showTicks: m.ticks,
      showTickNumbers: m.ticks,
      lineColor: RULER_COLOR,
      textColor: RULER_COLOR,
    },
    text: `${m.length.toFixed(m.decimals)} ${m.units}`,
  }
}

/**
 * Mount a standalone NVSlide deep-zoom view on a canvas: a core slide view on
 * WebGL2, redrawn on demand, refitting on resize until the user moves it. The
 * caller uses it for DICOM-WSI (SM) display sets.
 *
 * The active tool runs on every button. With `Length` a drag draws one UIKit
 * ruler (the previous one hides while it is dragged; a click without a drag
 * clears it), endpoints in slide coordinates, measured in physical units from
 * the slide's DICOM pixel spacing. `Zoom` drags zoom about the pointer; any
 * other tool pans. The wheel zooms.
 *
 * Resolves to a handle whose `dispose()` tears everything down, the slide
 * included; its `canvas` is the one drawn on. Rejects, leaving the slide with
 * the caller, when neither WebGL2 nor the WebGPU fallback starts.
 */
export async function mountWsiSlideView(
  canvas: HTMLCanvasElement,
  slide: NVSlide,
  options: WsiSlideViewOptions = {},
): Promise<WsiSlideView & { readonly canvas: HTMLCanvasElement }> {
  let levelLimit: string | null = null
  let ruler: UIKitRulerOverlay | null = null
  let syncRuler: ReturnType<typeof createRulerSync> | null = null
  let disposed = false
  let tool: string | undefined = 'Pan'
  const view = await createSlideView(canvas, {
    backend: 'webgl2',
    // Rendering is on demand: keep the frame for a later recomposite.
    preserveDrawingBuffer: true,
    antialias: false,
    slide,
    // The UIKit ruler below draws the measurement, not core's overlay.
    controllerOverlay: false,
    controller: {
      primaryDragMode: DRAG_MODE.pan,
      secondaryDragMode: DRAG_MODE.pan,
      onDrag: (_dx, dy, x, y) =>
        slide.zoomBy(Math.exp(-dy * 0.01), x, y, view.screen()),
      // One ruler at a time.
      onChange: () => {
        const ctl = view.controller
        if (ctl) ctl.measurements.splice(0, ctl.measurements.length - 1)
      },
    },
    // Ruler geometry before the frame draws it.
    onBeforeRender: (screen) => {
      const ctl = view.controller
      const m = ctl?.activeMeasurement ?? ctl?.measurements[0]
      if (!syncRuler) return
      if (!m) {
        syncRuler(null)
        return
      }
      const { spec, text } = rulerSpecFor(slide, m, screen)
      syncRuler(spec, text)
    },
    onRender: (screen) => {
      const { level, requestedLevel } =
        slide.lastVisibleTiles ?? slide.visibleTiles(screen)
      const limit =
        requestedLevel && level
          ? `L${requestedLevel.index} needs more tile memory than the cache holds; showing L${level.index}. Zoom in for full resolution.`
          : null
      if (limit === levelLimit) return
      levelLimit = limit
      options.onLevelLimit?.(limit)
    },
  })
  const ctl = view.controller
  const setTool = (next: string | undefined): void => {
    // Switching away from Length mid-drag abandons that ruler, as before.
    if (tool === 'Length' && next !== 'Length') ctl?.cancelGesture()
    tool = next
    if (!ctl) return
    const mode = dragModeFor(next)
    ctl.primaryDragMode = mode
    ctl.secondaryDragMode = mode
    ctl.middleDragMode = mode
    ctl.otherButtonDragMode = mode
  }
  if (ctl) {
    ctl.isContextMenuBlocked = false
    ctl.wheelZoomRate = 0.001
    // The old view read deltaY raw, whatever its deltaMode, and had one
    // pointer only (no pinch).
    ctl.isWheelDeltaModeScaled = false
    ctl.isPinchZoom = false
    // The old OHIF view had no double-click zoom; the Pan tool gains no gesture.
    ctl.isDoubleClickZoom = false
  }
  setTool(tool)
  // A Length press released without moving clears the ruler; a drag that
  // comes back near its start still measures, as before.
  let press: { x: number; y: number; moved: boolean } | null = null
  const onDown = (e: PointerEvent): void => {
    press = { x: e.clientX, y: e.clientY, moved: false }
  }
  const onMove = (e: PointerEvent): void => {
    if (press && (e.clientX !== press.x || e.clientY !== press.y))
      press.moved = true
  }
  const onUp = (): void => {
    const was = press
    press = null
    if (tool === 'Length' && was && !was.moved) ctl?.clearMeasurements()
  }
  view.canvas.addEventListener('pointerdown', onDown)
  view.canvas.addEventListener('pointermove', onMove)
  view.canvas.addEventListener('pointerup', onUp)
  // The ruler needs the bundled font; the view works meanwhile.
  loadDefaultFont()
    .then((font) => {
      if (disposed) return
      ruler = new UIKitRulerOverlay(font)
      syncRuler = createRulerSync(ruler, options.onMeasure)
      view.addOverlay(ruler)
    })
    .catch((err) => {
      console.error('[nv-ohif] UIKit ruler font failed to load', err)
    })

  return {
    canvas: view.canvas,
    setTool,
    resetView() {
      ctl?.clearMeasurements()
      view.fit()
    },
    zoom(factor) {
      const screen = view.screen()
      slide.zoomBy(factor, screen.widthCss / 2, screen.heightCss / 2, screen)
    },
    fit: view.fit,
    setWindow(calMin, calMax) {
      slide.setChannel(0, { calMin, calMax })
    },
    async saveBitmap(filename = 'niivue-slide.png') {
      // toBlob reads the frame drawn in this task, on either backend.
      view.renderNow()
      const blob = await new Promise<Blob | null>((resolve) =>
        view.canvas.toBlob(resolve, 'image/png'),
      )
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    },
    dispose() {
      if (disposed) return
      disposed = true
      view.canvas.removeEventListener('pointerdown', onDown)
      view.canvas.removeEventListener('pointermove', onMove)
      view.canvas.removeEventListener('pointerup', onUp)
      view.destroy()
      ruler?.destroy()
    },
  }
}
