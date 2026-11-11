// Optional whole-slide minimap from @niivue/uikit. To drop it, delete this
// file, its import and call in main.ts, and the @niivue/uikit dependency.
import type { NVSlide, SlideRenderer, SlideRendererGPU } from '@niivue/niivue'
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
  // Rebuilt lazily when the slide on screen changes (or the toggle flips).
  let shown: NVSlide | null = null
  let minimap: UIKitSlideMinimapOverlay | null = null
  renderer.overlayDraw = (frame) => {
    const slide = toggle.checked ? getSlide() : null
    if (slide !== shown) {
      if (minimap) {
        controls.remove(minimap)
        minimap.destroy()
      }
      // Top right: the HUD is top left and the credit bottom right.
      minimap = slide
        ? new UIKitSlideMinimapOverlay(slide, { corner: 'top-right' })
        : null
      if (minimap) controls.add(minimap)
      shown = slide
    }
    controls.drawOverlay(frame)
  }
}
