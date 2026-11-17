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
  let current: string | undefined
  const off = () => {
    detach?.()
    detach = null
  }
  return {
    /** Re-register the lens last, after an overlay registered since. */
    raise(): void {
      if (detach) this.setTool(current)
    },
    setTool(tool: string | undefined): void {
      current = tool
      off()
      const opts = tool ? LENS[tool] : undefined
      const canvas = nv.canvas
      if (!opts || !canvas) return
      // Registered last, so it magnifies the annotation overlay too.
      const lens = new UIKitMagnifierOverlay(opts)
      const unregister = nv.registerOverlayRenderer(lens)
      // Core's pointer handlers bubble on the canvas, and DRAG_MODE.none does
      // not stop them rotating the camera: claim the left-button gesture
      // before they see it; other buttons keep their behavior. The binding
      // drives the lens itself: UIKit's attach() exits the lens on a click.
      let held = false
      // The touch holding the lens: a second finger hands both to core's pinch.
      let touch: {
        pointerId: number
        clientX: number
        clientY: number
      } | null = null
      let replaying = false
      const at = (e: PointerEvent) => {
        const p = nv.clientToCanvas(e.clientX, e.clientY) ?? [-1, -1]
        lens.pointerMove(p[0], p[1])
        nv.drawScene()
      }
      const hide = () => {
        lens.pointerMove(-1, -1)
        nv.drawScene()
      }
      const down = (e: PointerEvent) => {
        if (replaying) return
        if (touch && e.pointerType === 'touch') {
          // Core never saw the first finger: replay its down, then let this one through.
          const first = touch
          held = false
          touch = null
          hide()
          replaying = true
          canvas.dispatchEvent(
            Object.assign(new Event('pointerdown', { bubbles: true }), {
              ...first,
              pointerType: 'touch',
              button: 0,
              buttons: 1,
            }),
          )
          replaying = false
          return
        }
        if (e.button !== 0) return
        e.stopImmediatePropagation()
        held = true
        if (e.pointerType === 'touch')
          touch = {
            pointerId: e.pointerId,
            clientX: e.clientX,
            clientY: e.clientY,
          }
        at(e)
      }
      const move = (e: PointerEvent) => {
        if (touch?.pointerId === e.pointerId)
          touch = { ...touch, clientX: e.clientX, clientY: e.clientY }
        if (held) e.stopImmediatePropagation()
        if (held || !opts.held) at(e)
      }
      const up = (e: PointerEvent) => {
        if (held) {
          e.stopImmediatePropagation()
          held = false
          touch = null
          if (opts.held) hide()
        }
        if (e.type === 'pointerleave' && !opts.held) hide()
      }
      // A double-click on the lens must not depth-pick and move the crosshair.
      const swallow = (e: Event) => e.stopImmediatePropagation()
      const ends = ['pointerup', 'pointercancel', 'pointerleave'] as const
      const o = { capture: true }
      canvas.addEventListener('pointerdown', down, o)
      canvas.addEventListener('pointermove', move, o)
      canvas.addEventListener('dblclick', swallow, o)
      for (const t of ends) canvas.addEventListener(t, up, o)
      const unwire = () => {
        canvas.removeEventListener('pointerdown', down, o)
        canvas.removeEventListener('pointermove', move, o)
        canvas.removeEventListener('dblclick', swallow, o)
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
