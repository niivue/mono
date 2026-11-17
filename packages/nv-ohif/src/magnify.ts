import type { UIKitOverlayRenderer } from '@niivue/niivue'
import type { UIKitHost } from '@niivue/uikit'
import { UIKitMagnifierOverlay } from '@niivue/uikit'

// Cornerstone defaults: Magnify 250 px box at magnifySize 10, shown only while
// the primary button is held; AdvancedMagnify radius 125 at zoomFactor 3
// (a placed glass there; here it follows the pointer).
const PINCH_WAIT_MS = 150

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
  let reregister: (() => void) | null = null
  const off = () => {
    detach?.()
    detach = null
  }
  return {
    /** Re-register the lens last, after an overlay registered since. */
    raise(): void {
      reregister?.()
    },
    setTool(tool: string | undefined): void {
      off()
      const opts = tool ? LENS[tool] : undefined
      const canvas = nv.canvas
      if (!opts || !canvas) return
      // Registered last, so it magnifies the annotation overlay too.
      const lens = new UIKitMagnifierOverlay(opts)
      let unregister = nv.registerOverlayRenderer(lens)
      // Moves only the overlay, so a press in progress keeps its state.
      reregister = () => {
        unregister()
        unregister = nv.registerOverlayRenderer(lens)
        nv.drawScene()
      }
      // Core's pointer handlers bubble on the canvas, and DRAG_MODE.none does
      // not stop them rotating the camera: claim the left-button gesture
      // before they see it; other buttons keep their behavior. The binding
      // drives the lens itself: UIKit's attach() exits the lens on a click.
      let held = false
      // Touches on the lens by pointer: a second finger pinches the lens zoom.
      const touches = new Map<number, [number, number]>()
      let pinch: { span: number; zoom: number } | null = null
      // After a pinch the lens stays put until every finger is up.
      let pinned = false
      // AdvancedMagnify's glass stays put while a pinch may still start: a
      // single touch waits this long for a second finger before moving it.
      let wait: ReturnType<typeof setTimeout> | undefined
      const settle = () => {
        clearTimeout(wait)
        wait = undefined
      }
      const span = () => {
        const [a, b] = [...touches.values()] as [
          [number, number],
          [number, number],
        ]
        return Math.hypot(a[0] - b[0], a[1] - b[1])
      }
      const at = (e: { clientX: number; clientY: number }) => {
        const p = nv.clientToCanvas(e.clientX, e.clientY) ?? [-1, -1]
        lens.pointerMove(p[0], p[1])
        nv.drawScene()
      }
      const hide = () => {
        lens.pointerMove(-1, -1)
        nv.drawScene()
      }
      const down = (e: PointerEvent) => {
        if (touches.size && e.pointerType === 'touch') {
          e.stopImmediatePropagation()
          touches.set(e.pointerId, [e.clientX, e.clientY])
          settle()
          pinned = true
          pinch = touches.size === 2 ? { span: span(), zoom: lens.zoom } : null
          return
        }
        if (e.button !== 0) return
        e.stopImmediatePropagation()
        held = true
        if (e.pointerType !== 'touch' || opts.held) {
          at(e)
          if (e.pointerType === 'touch')
            touches.set(e.pointerId, [e.clientX, e.clientY])
          return
        }
        const id = e.pointerId
        touches.set(id, [e.clientX, e.clientY])
        wait = setTimeout(() => {
          wait = undefined
          const p = touches.get(id)
          if (p && !pinned) at({ clientX: p[0], clientY: p[1] })
        }, PINCH_WAIT_MS)
      }
      const move = (e: PointerEvent) => {
        if (touches.has(e.pointerId)) {
          e.stopImmediatePropagation()
          touches.set(e.pointerId, [e.clientX, e.clientY])
          if (touches.size === 1 && !pinned && !wait) at(e)
          else if (pinch && pinch.span > 0) {
            // UIKit's own lens pinch range.
            lens.zoom = Math.min(
              10,
              Math.max(1.5, (pinch.zoom * span()) / pinch.span),
            )
            nv.drawScene()
          }
          return
        }
        if (held) e.stopImmediatePropagation()
        // Touch has no hover: an unheld touch move is not the lens's.
        if (held || (!opts.held && e.pointerType !== 'touch')) at(e)
      }
      const up = (e: PointerEvent) => {
        if (touches.delete(e.pointerId)) {
          e.stopImmediatePropagation()
          settle()
          // The glass goes where a lone touch lifts; a pinch leaves it put.
          if (!pinned && !opts.held) at(e)
          pinch = touches.size === 2 ? { span: span(), zoom: lens.zoom } : null
          if (touches.size) return
          pinned = false
        }
        if (held) {
          e.stopImmediatePropagation()
          held = false
          if (opts.held) hide()
          else if (e.pointerType !== 'touch') at(e)
        }
        // Touch fires pointerleave on every lift: the glass stays where it was put.
        if (
          e.type === 'pointerleave' &&
          !opts.held &&
          e.pointerType !== 'touch'
        )
          hide()
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
        reregister = null
        settle()
        unwire()
        unregister()
        lens.destroy()
        nv.drawScene()
      }
    },
    dispose: off,
  }
}
