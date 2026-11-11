// Optional whole-slide minimap from @niivue/uikit. To drop it, delete this
// file, its import and call in main.ts, and the @niivue/uikit dependency.
import type {
  NVSlide,
  SlideRenderer,
  SlideRendererGPU,
  UIKitOverlayFrame,
} from '@niivue/niivue'
import { UIKitControls, UIKitSlideMinimapOverlay } from '@niivue/uikit'

/** Draws the minimap through the renderer's overlay hook and adds a toolbar checkbox. */
export function attachMinimap(
  canvas: HTMLCanvasElement,
  renderer: SlideRenderer | SlideRendererGPU,
  getSlide: () => NVSlide | null,
  requestRender: () => void,
): void {
  const label = document.createElement('label')
  label.title = 'Whole-slide overview; click or drag it to jump'
  const toggle = Object.assign(document.createElement('input'), {
    type: 'checkbox',
    checked: true,
    autocomplete: 'off',
  })
  label.append(toggle, ' Minimap')
  document.getElementById('status')?.before(label)
  toggle.addEventListener('change', requestRender)

  // Rebuilt lazily when the slide on screen changes (or the toggle flips).
  let shown: NVSlide | null = null
  let minimap: UIKitSlideMinimapOverlay | null = null
  let lastFrame: UIKitOverlayFrame | null = null
  const sync = (): void => {
    const slide = toggle.checked ? getSlide() : null
    if (slide === shown) return
    if (minimap) {
      controls.remove(minimap)
      minimap.destroy()
    }
    // Top right: the HUD is top left and the credit bottom right.
    minimap = slide
      ? new UIKitSlideMinimapOverlay(slide, { corner: 'top-right' })
      : null
    if (minimap) controls.add(minimap)
    // A minimap hit-tests against its last drawn layout; seed it from the last
    // frame so a press before the next draw still lands on it.
    if (minimap && lastFrame) {
      const { bounds, dpr } = lastFrame
      minimap.layoutFor(bounds.width, bounds.height, dpr)
    }
    shown = slide
  }
  // Registered before the control layer's, so a press between a slide swap and
  // the next frame reaches the new slide's minimap, not the disposed one's.
  canvas.addEventListener('pointerdown', sync, { capture: true })

  // The control layer's capture-phase listeners stop presses the minimap takes,
  // so they never reach the NVSlideController pan / zoom-box gestures.
  const controls = new UIKitControls()
  controls.attach({
    canvas,
    clientToCanvas: (clientX, clientY) => {
      const r = canvas.getBoundingClientRect()
      const x = ((clientX - r.left) * canvas.width) / r.width
      const y = ((clientY - r.top) * canvas.height) / r.height
      return x >= 0 && y >= 0 && x < canvas.width && y < canvas.height
        ? [x, y]
        : null
    },
    drawScene: requestRender,
  })
  renderer.overlayDraw = (frame) => {
    lastFrame = frame
    sync()
    controls.drawOverlay(frame)
  }
}
