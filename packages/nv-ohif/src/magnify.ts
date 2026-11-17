import type { UIKitOverlayRenderer } from '@niivue/niivue'
import type { UIKitHost } from '@niivue/uikit'
import { UIKitMagnifierOverlay } from '@niivue/uikit'

// Cornerstone defaults: Magnify 250 px box at magnifySize 10, shown only while
// the primary button is held; AdvancedMagnify radius 125 at zoomFactor 3
// (a placed glass there; here it follows the pointer).
const LENS: Record<string, { radiusCss: number; zoom: number; held: boolean }> =
  {
    Magnify: { radiusCss: 125, zoom: 10, held: true },
    AdvancedMagnify: { radiusCss: 125, zoom: 3, held: false },
  }

type Host = UIKitHost & {
  canvas: HTMLCanvasElement | null
  registerOverlayRenderer(r: UIKitOverlayRenderer): () => void
}

/** Shows a lens on the pane while OHIF's active tool is a magnifier. */
export function createMagnifyBinding(nv: Host) {
  let detach: (() => void) | null = null
  const off = () => {
    detach?.()
    detach = null
  }
  return {
    setTool(tool: string | undefined): void {
      off()
      const opts = tool ? LENS[tool] : undefined
      const canvas = nv.canvas
      if (!opts || !canvas) return
      // Registered last, so it magnifies the annotation overlay too.
      const lens = new UIKitMagnifierOverlay(opts)
      const unregister = nv.registerOverlayRenderer(lens)
      // attach() listens in capture phase too, registered first, so its lens
      // still follows the moves claimed below.
      const unfollow = opts.held ? null : lens.attach(nv)
      // Core's pointer handlers bubble on the canvas, and DRAG_MODE.none does
      // not stop them rotating the camera: claim the left-button gesture
      // before they see it; other buttons keep their behavior.
      let held = false
      const at = (e: PointerEvent) => {
        if (!opts.held) return
        const p = nv.clientToCanvas(e.clientX, e.clientY) ?? [-1, -1]
        lens.pointerMove(p[0], p[1])
        nv.drawScene()
      }
      const down = (e: PointerEvent) => {
        if (e.button !== 0) return
        e.stopImmediatePropagation()
        held = true
        at(e)
      }
      const move = (e: PointerEvent) => {
        if (!held) return
        e.stopImmediatePropagation()
        at(e)
      }
      const up = (e: PointerEvent) => {
        if (!held) return
        e.stopImmediatePropagation()
        held = false
        if (!opts.held) return
        lens.pointerMove(-1, -1)
        nv.drawScene()
      }
      const ends = ['pointerup', 'pointercancel', 'pointerleave'] as const
      const o = { capture: true }
      canvas.addEventListener('pointerdown', down, o)
      canvas.addEventListener('pointermove', move, o)
      for (const t of ends) canvas.addEventListener(t, up, o)
      const unwire = () => {
        unfollow?.()
        canvas.removeEventListener('pointerdown', down, o)
        canvas.removeEventListener('pointermove', move, o)
        for (const t of ends) canvas.removeEventListener(t, up, o)
      }
      detach = () => {
        unwire()
        unregister()
        lens.destroy()
        nv.drawScene()
      }
    },
    dispose: off,
  }
}
