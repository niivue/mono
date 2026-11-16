import type { NVSlide } from '@niivue/niivue'
import { createSlideView, DRAG_MODE, isRgbSlide } from '@niivue/niivue'
import { attachSlideMinimap } from '@niivue/uikit'

export interface WsiSlideViewOptions {
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

// Core's ruler in the old UIKit ruler's yellow.
const RULER_COLOR: [number, number, number, number] = [1, 0.85, 0, 1]

// The OHIF tool runs on every button, as before; any tool but Length and
// Zoom pans.
const dragModeFor = (tool: string | undefined): DRAG_MODE =>
  tool === 'Length'
    ? DRAG_MODE.measurement
    : tool === 'Zoom'
      ? DRAG_MODE.callbackOnly
      : tool === 'WindowLevel'
        ? DRAG_MODE.windowing
        : DRAG_MODE.pan

/**
 * Cornerstone's WindowLevel drag on a slide: round(range / 1024) stored units
 * per CSS px (unrounded below 1, so 8-bit RGB moves 0.25/px), right widens,
 * down raises the centre. An RGB slide windows its red, green and blue
 * channels together (brightness/contrast); others only `channel`.
 */
export function windowSlideDrag(
  slide: Pick<NVSlide, 'channels' | 'manifest' | 'setChannel'>,
  channel: number,
  dx: number,
  dy: number,
): void {
  const top = 2 ** (slide.manifest.levels[0]?.bitsStored ?? 8) - 1
  const ratio = top / 1024
  const perPixel = ratio > 1 ? Math.round(ratio) : ratio
  const channels = isRgbSlide(slide.manifest)
    ? slide.channels.map((_, c) => c)
    : [channel]
  for (const c of channels) {
    const ch = slide.channels[c]
    const lo = Number.isFinite(ch?.calMin) ? (ch?.calMin as number) : 0
    const hi = Number.isFinite(ch?.calMax) ? (ch?.calMax as number) : top
    const width = Math.max(perPixel, hi - lo + dx * perPixel)
    const centre = (lo + hi) / 2 + dy * perPixel
    slide.setChannel(c, {
      calMin: centre - width / 2,
      calMax: centre + width / 2,
    })
  }
}

/** One ruler at a time: the last finished one, none while a new one is dragged. */
export function keepOneRuler(ctl: {
  measurements: unknown[]
  activeMeasurement: unknown
}): void {
  ctl.measurements.splice(
    0,
    ctl.measurements.length - (ctl.activeMeasurement ? 0 : 1),
  )
}

/**
 * Mount a standalone NVSlide deep-zoom view on a canvas: a core slide view on
 * WebGL2, redrawn on demand, refitting on resize until the user moves it. The
 * caller uses it for DICOM-WSI (SM) display sets.
 *
 * The active tool runs on the left and middle buttons; a right drag boxes a
 * region and zooms to it (the browser menu is suppressed). With `Length` a drag draws one ruler
 * (core's slide overlay; the previous one clears once a new one is dragged;
 * a click without a drag clears it), endpoints in slide coordinates, measured in
 * physical units from the slide's DICOM pixel spacing. `Zoom` drags zoom
 * about the pointer; any other tool pans. The wheel zooms.
 *
 * Resolves to a handle whose `dispose()` tears everything down, the slide
 * included; its `canvas` is the one drawn on. Rejects, leaving the slide with
 * the caller, when neither WebGL2 nor the WebGPU fallback starts.
 */
const MINIMAP_CORNER = 'bottom-right'

export async function mountWsiSlideView(
  canvas: HTMLCanvasElement,
  slide: NVSlide,
  options: WsiSlideViewOptions = {},
): Promise<WsiSlideView & { readonly canvas: HTMLCanvasElement }> {
  let levelLimit: string | null = null
  let disposed = false
  let tool: string | undefined = 'Pan'
  const view = await createSlideView(canvas, {
    backend: 'webgl2',
    // Rendering is on demand: keep the frame for a later recomposite.
    preserveDrawingBuffer: true,
    antialias: false,
    slide,
    overlayStyle: {
      measureLineColor: RULER_COLOR,
      measureTextColor: RULER_COLOR,
      // Scale bar, as OHIF's slide viewer shows one.
      isRulerVisible: true,
    },
    controller: {
      primaryDragMode: DRAG_MODE.pan,
      secondaryDragMode: DRAG_MODE.pan,
      onDrag: (_dx, dy, x, y) =>
        slide.zoomBy(Math.exp(-dy * 0.01), x, y, view.screen()),
      onWindow: (dx, dy) =>
        windowSlideDrag(slide, view.controller?.windowChannel ?? 0, dx, dy),
      onChange: () => {
        if (view.controller) keepOneRuler(view.controller)
      },
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
  // Whole-slide overview with the visible region boxed, as OHIF's slide viewer shows.
  const detachMinimap = attachSlideMinimap(view, { corner: MINIMAP_CORNER })
  const ctl = view.controller
  const setTool = (next: string | undefined): void => {
    // Switching away from Length mid-drag abandons that ruler, as before.
    if (tool === 'Length' && next !== 'Length') ctl?.cancelGesture()
    tool = next
    if (!ctl) return
    const mode = dragModeFor(next)
    ctl.primaryDragMode = mode
    // Right drags a box and zooms to it, as NiiVue's slide viewer; WindowLevel
    // keeps middle-button panning, as cornerstone binds it.
    const windowing = mode === DRAG_MODE.windowing
    ctl.secondaryDragMode = DRAG_MODE.roiSelection
    ctl.middleDragMode = windowing ? DRAG_MODE.pan : mode
    ctl.otherButtonDragMode = windowing ? DRAG_MODE.pan : mode
  }
  if (ctl) {
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
      detachMinimap()
      view.destroy()
    },
  }
}
