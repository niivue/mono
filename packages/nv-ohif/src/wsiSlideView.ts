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
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false })
  if (!gl) throw new Error('WebGL2 is required for the whole-slide viewer')

  const renderer = new SlideRenderer()
  renderer.init(gl)

  let disposed = false
  let rafHandle = 0
  let fitted = false

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
    // Fit once, the first time the canvas has real dimensions.
    if (!fitted && screen.widthCss > 1 && screen.heightCss > 1) {
      slide.fitToScreen(screen)
      fitted = true
    }
    slide.clampViewport(screen)
    // draw() self-requests the visible tiles; missing tiles fetch+decode async
    // and fire 'change' when ready, which schedules the next frame.
    renderer.draw(gl, [slide], screen)
  }

  const scheduleRender = (): void => {
    if (rafHandle !== 0 || disposed) return
    rafHandle = requestAnimationFrame(() => {
      rafHandle = 0
      render()
    })
  }

  const onChange = (): void => scheduleRender()
  slide.addEventListener('change', onChange)

  // Pointer pan.
  let dragging = false
  let lastX = 0
  let lastY = 0
  const onPointerDown = (e: PointerEvent): void => {
    dragging = true
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

  const resizeObserver = new ResizeObserver(() => scheduleRender())
  resizeObserver.observe(canvas)

  scheduleRender()

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      if (rafHandle !== 0) cancelAnimationFrame(rafHandle)
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
