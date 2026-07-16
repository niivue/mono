import type { NVSlide, NVSlideScreen } from '@niivue/niivue'
import { SlideRenderer } from '@niivue/niivue'

export interface WsiSlideView {
  dispose(): void
}

/**
 * Mount a standalone NVSlide deep-zoom view on a canvas: WebGL2 + SlideRenderer,
 * an on-demand render loop (redraw only when tiles stream in or the user
 * interacts), and pointer pan / wheel zoom. This is independent of NiiVue's
 * volume renderer; the caller uses it for DICOM-WSI (SM) display sets.
 *
 * Returns a handle whose `dispose()` tears down every listener, the RAF, and
 * the GL resources.
 */
export function mountWsiSlideView(
  canvas: HTMLCanvasElement,
  slide: NVSlide,
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

  const screenOf = (): NVSlideScreen => ({
    widthCss: canvas.clientWidth || 1,
    heightCss: canvas.clientHeight || 1,
    devicePixelRatio: window.devicePixelRatio || 1,
  })

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
    if (!userInteracted && screen.widthCss > 1 && screen.heightCss > 1) {
      slide.fitToScreen(screen)
    }
    slide.clampViewport(screen)
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

  // Pointer pan.
  let dragging = false
  let lastX = 0
  let lastY = 0
  const onPointerDown = (e: PointerEvent): void => {
    dragging = true
    userInteracted = true
    lastX = e.clientX
    lastY = e.clientY
    canvas.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return
    slide.panByScreenDelta(e.clientX - lastX, e.clientY - lastY, screenOf())
    lastX = e.clientX
    lastY = e.clientY
    scheduleRender()
  }
  const onPointerUp = (e: PointerEvent): void => {
    dragging = false
    canvas.releasePointerCapture?.(e.pointerId)
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
      slide.dispose()
      renderer.destroy()
    },
  }
}
