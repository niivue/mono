import type { NVSlide, NVSlideScreen } from '@niivue/niivue'
import { SlideRenderer } from '@niivue/niivue'
import { loadDefaultFont, UIKitRulerOverlay } from '@niivue/uikit'

export interface WsiSlideViewOptions {
  /**
   * Called when the measurement (ruler) changes: a formatted length string
   * while measuring, or null when the ruler is cleared. Lets the host reflect
   * the reading into its own status UI.
   */
  onMeasure?: (text: string | null) => void
}

export interface WsiSlideView {
  setTool(tool: string | undefined): void
  resetView(): void
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
 * Mount a standalone NVSlide deep-zoom view on a canvas: WebGL2 + SlideRenderer,
 * an on-demand render loop (redraw only when tiles stream in or the user
 * interacts), and pointer pan / wheel zoom. This is independent of NiiVue's
 * volume renderer; the caller uses it for DICOM-WSI (SM) display sets.
 *
 * When the active tool is `Length`, clicks place a two-point ruler (a UIKit
 * overlay drawn over the slide) that measures in real physical units recovered
 * from the slide's DICOM pixel spacing. Endpoints are stored in slide
 * coordinates so the ruler tracks the tissue through pan and zoom.
 *
 * Returns a handle whose `dispose()` tears down every listener, the RAF, and
 * the GL resources.
 */
export function mountWsiSlideView(
  canvas: HTMLCanvasElement,
  slide: NVSlide,
  options: WsiSlideViewOptions = {},
): WsiSlideView {
  // preserveDrawingBuffer is required because this viewport renders on demand
  // (on fit / tile-load / interaction) rather than every frame. Without it the
  // browser clears the drawing buffer after each composite, so once rendering
  // settles any later recomposite (focus/scroll/DPR change) shows a blank canvas.
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
  })
  if (!gl) throw new Error('WebGL2 is required for the whole-slide viewer')

  const renderer = new SlideRenderer()
  renderer.init(gl)

  let disposed = false
  // Keep the whole slide fit-to-view until the user takes over with a pan/zoom.
  // Re-fitting on every render until the first interaction is robust to the
  // canvas not yet having a real size on the very first render (clientWidth 0),
  // which would otherwise leave the slide zoomed into a corner.
  let userInteracted = false
  let activeTool: string | undefined = 'Pan'
  let lastFitWidth = 0
  let lastFitHeight = 0

  // Ruler: created once the bundled font resolves. Endpoints live in slide
  // coordinates so the ruler tracks the tissue through pan/zoom. Placed by a
  // click-drag (press = start, drag = extend, release = fix), matching the
  // volume viewport.
  let ruler: UIKitRulerOverlay | null = null
  let ruleA: { x: number; y: number } | null = null
  let ruleB: { x: number; y: number } | null = null
  const onMeasure = options.onMeasure

  const screenOf = (): NVSlideScreen => ({
    widthCss: canvas.clientWidth || 1,
    heightCss: canvas.clientHeight || 1,
    devicePixelRatio: window.devicePixelRatio || 1,
  })

  const slideToDevice = (
    p: { x: number; y: number },
    screen: NVSlideScreen,
  ): [number, number] => {
    const { xCss, yCss } = slide.slideToScreen(p.x, p.y, screen)
    const dpr = screen.devicePixelRatio ?? 1
    return [xCss * dpr, yCss * dpr]
  }

  const clearMeasurement = (): void => {
    ruleA = null
    ruleB = null
    ruler?.clear()
    onMeasure?.(null)
  }

  const updateRuler = (screen: NVSlideScreen): void => {
    if (!ruler) return
    const a = ruleA
    const b = ruleB
    if (!a || !b) {
      ruler.clear()
      return
    }
    const m = measure(a, b, slide.manifest.pixelSpacingMM)
    // The overlay draws in DEVICE pixels (endpoints are scaled by dpr above), so
    // the label/line sizes must scale by dpr too, otherwise a CSS-px value looks
    // half-size on a 2x (retina) display.
    const dpr = screen.devicePixelRatio ?? 1
    ruler.setRuler({
      a: slideToDevice(a, screen),
      b: slideToDevice(b, screen),
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
    })
    onMeasure?.(`${m.length.toFixed(m.decimals)} ${m.units}`)
  }

  const syncCanvasSize = (screen: NVSlideScreen): void => {
    const dpr = screen.devicePixelRatio ?? 1
    const width = Math.max(1, Math.floor(screen.widthCss * dpr))
    const height = Math.max(1, Math.floor(screen.heightCss * dpr))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
  }

  const render = (): void => {
    if (disposed) return
    const screen = screenOf()
    syncCanvasSize(screen)
    if (
      !userInteracted &&
      screen.widthCss > 1 &&
      screen.heightCss > 1 &&
      (screen.widthCss !== lastFitWidth || screen.heightCss !== lastFitHeight)
    ) {
      lastFitWidth = screen.widthCss
      lastFitHeight = screen.heightCss
      slide.fitToScreen(screen)
    }
    slide.clampViewport(screen)
    // Set the ruler geometry BEFORE the frame draws it (the renderer invokes the
    // overlay hook at the end of its own draw).
    updateRuler(screen)
    renderer.draw(gl, [slide], screen)
  }

  // Event-driven rendering rather than a continuous RAF loop: the slide is static
  // between interactions and tile arrivals, so there is nothing to animate. A
  // single coalesced render is scheduled per burst of events. requestAnimationFrame
  // gives a vsync-aligned redraw while the tab is visible; a setTimeout runs in
  // parallel as a safety net because RAF is paused in a hidden/backgrounded tab
  // (the `scheduled` flag makes whichever fires second a no-op).
  let scheduled = false
  const flush = (): void => {
    if (!scheduled || disposed) return
    scheduled = false
    render()
  }
  const scheduleRender = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    requestAnimationFrame(flush)
    setTimeout(flush, 100)
  }

  // Load the bundled UIKit font, then attach the ruler overlay. Async: the
  // viewer works immediately; the ruler simply cannot draw until the font is in.
  loadDefaultFont()
    .then((font) => {
      if (disposed) return
      ruler = new UIKitRulerOverlay(font)
      renderer.overlayDraw = (frame) => ruler?.drawOverlay(frame)
      scheduleRender()
    })
    .catch((err) => {
      console.error('[nv-ohif] UIKit ruler font failed to load', err)
    })

  const cssPos = (e: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  // Wheel zoom, anchored at the cursor.
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    userInteracted = true
    const rect = canvas.getBoundingClientRect()
    const factor = Math.exp(-e.deltaY * 0.001)
    slide.zoomBy(
      factor,
      e.clientX - rect.left,
      e.clientY - rect.top,
      screenOf(),
    )
    scheduleRender()
  }

  // Pointer interaction, matching the volume viewport's tool semantics: with the
  // Length tool, a click-drag draws the measurement (press = start, drag =
  // extend, release = fix); with the Pan / Zoom tool, a drag pans / zooms. A
  // slide point at the pointer's current position.
  const slidePointAt = (e: PointerEvent): { x: number; y: number } => {
    const [cx, cy] = cssPos(e)
    return slide.screenToSlide(cx, cy, screenOf())
  }
  let dragging = false // panning / zooming (Pan or Zoom tool)
  let measuring = false // drawing a ruler (Length tool)
  let lastX = 0
  let lastY = 0
  const onPointerDown = (e: PointerEvent): void => {
    canvas.setPointerCapture?.(e.pointerId)
    if (activeTool === 'Length') {
      // Start a fresh measurement at the press point.
      measuring = true
      const s = slidePointAt(e)
      ruleA = { x: s.x, y: s.y }
      ruleB = { x: s.x, y: s.y }
      scheduleRender()
      return
    }
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (measuring) {
      // Extend the measurement to the current point.
      ruleB = slidePointAt(e)
      scheduleRender()
      return
    }
    if (!dragging) return
    userInteracted = true
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    if (activeTool === 'Zoom') {
      const rect = canvas.getBoundingClientRect()
      slide.zoomBy(
        Math.exp(-dy * 0.01),
        e.clientX - rect.left,
        e.clientY - rect.top,
        screenOf(),
      )
    } else {
      slide.panByScreenDelta(dx, dy, screenOf())
    }
    scheduleRender()
  }
  const onPointerUp = (e: PointerEvent): void => {
    canvas.releasePointerCapture?.(e.pointerId)
    if (measuring) {
      measuring = false
      ruleB = slidePointAt(e)
      // A press with no drag isn't a measurement.
      if (ruleA && ruleB && ruleA.x === ruleB.x && ruleA.y === ruleB.y) {
        clearMeasurement()
      }
      scheduleRender()
      return
    }
    dragging = false
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  // Redraw as tiles stream in and as the viewport is resized.
  const onChange = (): void => scheduleRender()
  slide.addEventListener('change', onChange)
  const resizeObserver = new ResizeObserver(() => scheduleRender())
  resizeObserver.observe(canvas)

  scheduleRender()

  return {
    setTool(tool: string | undefined): void {
      // Abandon an in-progress drag when switching away from Length; a completed
      // ruler stays visible.
      if (tool !== 'Length') measuring = false
      activeTool = tool
    },
    resetView(): void {
      userInteracted = false
      lastFitWidth = 0
      lastFitHeight = 0
      clearMeasurement()
      scheduleRender()
    },
    async saveBitmap(filename = 'niivue-slide.png'): Promise<void> {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      )
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      resizeObserver.disconnect()
      slide.removeEventListener('change', onChange)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      ruler?.destroy()
      slide.dispose()
      renderer.destroy()
    },
  }
}
