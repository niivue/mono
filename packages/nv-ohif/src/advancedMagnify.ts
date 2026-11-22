import type { NiiVue, UIKitOverlayFrame } from '@niivue/niivue'
import { projectMMToCanvas } from '@niivue/niivue'
import { UIKitMagnifierOverlay } from '@niivue/uikit'

// Cornerstone AdvancedMagnifyTool defaults (radius in canvas CSS px).
const RADIUS_CSS = 125
const ZOOM = 3
const ZOOM_FACTORS = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]
// cornerstone MOUSE_PROXIMITY / TOUCH_PROXIMITY (CSS px) and touch press delay.
const PROXIMITY = { mouse: 6, touch: 36 }
const PRESS_MS = 700

type Vec3 = [number, number, number]
type Host = Pick<
  NiiVue,
  | 'canvas'
  | 'volumes'
  | 'clientToCanvas'
  | 'canvasToMM'
  | 'hitTest'
  | 'getScreenTiles'
  | 'registerOverlayRenderer'
  | 'drawScene'
  | 'effectiveDevicePixelRatio'
>

/** A placed glass: its centre and a rim point in world mm, so it pans, zooms and slices with the image. */
interface Glass {
  center: Vec3
  rim: Vec3
  sliceType: number
  volume: unknown
  lens: UIKitMagnifierOverlay
  /** This frame's canvas centre and radius (backing px); null when off its plane. */
  at: { x: number; y: number; r: number } | null
}

/**
 * OHIF's AdvancedMagnify on a NiiVue pane, as cornerstone's: Active places a
 * glass per click; Active or Passive glasses move (rim, or inside on touch),
 * resize (rim handles) and change zoom (Shift+right-click or a long touch);
 * Disabled removes them all.
 */
export function createAdvancedMagnifyBinding(nv: Host) {
  const glasses: Glass[] = []
  let mode: string | undefined
  let unregister: (() => void) | null = null
  const canvas = nv.canvas

  const place = (g: Glass) => {
    const vol = nv.volumes[0]
    if (g.volume !== vol) return null
    const p = vol?.pixDimsRAS
    // Half the finest voxel edge: the glass shows on its own slice only.
    const tol = 0.5 * Math.min(p?.[1] ?? 1, p?.[2] ?? 1, p?.[3] ?? 1)
    for (const t of nv.getScreenTiles()) {
      const { mvpMatrix, planeNormal: n, planePoint: q, leftTopWidthHeight } = t
      if (
        t.axCorSag !== g.sliceType ||
        !mvpMatrix ||
        !n ||
        !q ||
        !leftTopWidthHeight
      )
        continue
      const c = g.center
      if (
        Math.abs(
          n[0] * (c[0] - q[0]) + n[1] * (c[1] - q[1]) + n[2] * (c[2] - q[2]),
        ) > tol
      )
        continue
      const [x, y] = projectMMToCanvas(c, mvpMatrix, leftTopWidthHeight)
      const [rx, ry] = projectMMToCanvas(g.rim, mvpMatrix, leftTopWidthHeight)
      return { x, y, r: Math.hypot(rx - x, ry - y) }
    }
    return null
  }

  const renderer = {
    drawOverlay(frame: UIKitOverlayFrame) {
      for (const g of glasses) {
        g.at = place(g)
        if (!g.at) continue
        g.lens.radiusCss = g.at.r / frame.dpr
        g.lens.pointerMove(g.at.x, g.at.y)
        g.lens.drawOverlay(frame)
      }
    },
  }

  const register = () => {
    unregister?.()
    unregister = glasses.length ? nv.registerOverlayRenderer(renderer) : null
  }
  const clear = () => {
    if (!glasses.length) return
    for (const g of glasses.splice(0)) g.lens.destroy()
    register()
    nv.drawScene()
  }

  /** The glass under canvas point (x, y) and the grab: 'resize' on a handle, 'move' on the rim (or inside, for touch). */
  const grab = (x: number, y: number, touch: boolean) => {
    const prox =
      (touch ? PROXIMITY.touch : PROXIMITY.mouse) * nv.effectiveDevicePixelRatio
    for (let i = glasses.length - 1; i >= 0; i--) {
      const g = glasses[i] as Glass
      if (!g.at) continue
      const { x: cx, y: cy, r } = g.at
      const d = Math.hypot(x - cx, y - cy)
      if (Math.abs(d - r) < 2 * prox) {
        // Handles: top, bottom, left, right of the rim.
        const handle = [
          [cx, cy - r],
          [cx, cy + r],
          [cx - r, cy],
          [cx + r, cy],
        ].some(
          ([hx, hy]) =>
            Math.hypot(x - (hx as number), y - (hy as number)) < prox,
        )
        return { g, kind: handle ? ('resize' as const) : ('move' as const) }
      }
      if (touch && d < r) return { g, kind: 'move' as const }
    }
    return null
  }

  const showZoomList = (g: Glass, e: PointerEvent) => {
    const parent = canvas?.parentElement
    if (!parent) return
    const select = document.createElement('select')
    const box = parent.getBoundingClientRect()
    select.style.cssText = `position:absolute;left:${e.clientX - box.left}px;top:${e.clientY - box.top}px;z-index:10`
    for (const z of ZOOM_FACTORS) {
      const o = new Option(String(z), String(z), false, z === g.lens.zoom)
      o.title = `Zoom factor ${z.toFixed(1)}`
      select.add(o)
    }
    const done = () => select.remove()
    select.addEventListener('change', () => {
      g.lens.zoom = Number.parseFloat(select.value)
      done()
      nv.drawScene()
    })
    select.addEventListener('blur', done)
    parent.appendChild(select)
    select.focus()
  }

  let drag: {
    g: Glass
    kind: 'move' | 'resize'
    last: Vec3 | null
    id: number
  } | null = null
  let press: ReturnType<typeof setTimeout> | undefined
  const mmAt = (e: PointerEvent) => {
    const p = nv.clientToCanvas(e.clientX, e.clientY)
    return p ? nv.canvasToMM(p[0], p[1]) : null
  }

  const down = (e: PointerEvent) => {
    if (!mode) return
    const p = nv.clientToCanvas(e.clientX, e.clientY)
    if (!p) return
    const touch = e.pointerType === 'touch'
    const hit = grab(p[0], p[1], touch)
    if (hit && e.button === 2 && e.shiftKey) {
      e.stopImmediatePropagation()
      e.preventDefault()
      showZoomList(hit.g, e)
      return
    }
    if (e.button !== 0) return
    if (hit) {
      e.stopImmediatePropagation()
      drag = { ...hit, last: mmAt(e), id: e.pointerId }
      if (touch)
        press = setTimeout(() => {
          drag = null
          showZoomList(hit.g, e)
        }, PRESS_MS)
      return
    }
    if (mode !== 'Active') return
    const tile = nv.hitTest(p[0], p[1])
    const center = nv.canvasToMM(p[0], p[1])
    // A rim point one radius away on this plane: scaled from a 1 px step, which
    // stays on the tile where the rim itself may not.
    const step = nv.canvasToMM(p[0] + 1, p[1]) ?? nv.canvasToMM(p[0] - 1, p[1])
    if (!tile || tile.isRender || !center || !step) return
    const k = RADIUS_CSS * nv.effectiveDevicePixelRatio
    const rim = center.map((c, i) => c + ((step[i] as number) - c) * k) as Vec3
    e.stopImmediatePropagation()
    glasses.push({
      center,
      rim,
      sliceType: tile.sliceType,
      volume: nv.volumes[0],
      lens: new UIKitMagnifierOverlay({ zoom: ZOOM }),
      at: null,
    })
    if (glasses.length === 1) register()
    nv.drawScene()
  }

  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    e.stopImmediatePropagation()
    clearTimeout(press)
    const mm = mmAt(e)
    if (!mm) return
    const { g } = drag
    if (drag.kind === 'resize') g.rim = mm
    else if (drag.last) {
      const d = [0, 1, 2].map(
        (i) => (mm[i] as number) - (drag?.last?.[i] as number),
      )
      g.center = g.center.map((v, i) => v + (d[i] as number)) as Vec3
      g.rim = g.rim.map((v, i) => v + (d[i] as number)) as Vec3
    }
    drag.last = mm
    nv.drawScene()
  }

  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    e.stopImmediatePropagation()
    clearTimeout(press)
    drag = null
  }

  // Shift+right-click on a glass opens its zoom list, not OHIF's menu.
  const menu = (e: MouseEvent) => {
    const p = e.shiftKey && nv.clientToCanvas(e.clientX, e.clientY)
    if (p && grab(p[0], p[1], false)) {
      e.stopImmediatePropagation()
      e.preventDefault()
    }
  }

  const o = { capture: true }
  canvas?.addEventListener('pointerdown', down, o)
  canvas?.addEventListener('pointermove', move, o)
  canvas?.addEventListener('pointerup', up, o)
  canvas?.addEventListener('pointercancel', up, o)
  canvas?.addEventListener('contextmenu', menu, o)

  return {
    /** OHIF's AdvancedMagnify mode in the pane's tool group. */
    setMode(m: string | undefined): void {
      mode =
        m === 'Active' || m === 'Passive' || m === 'Enabled' ? m : undefined
      if (!mode) clear()
    },
    /** Re-register last, above overlays registered since (the lens magnifies them). */
    raise: register,
    dispose(): void {
      clearTimeout(press)
      canvas?.removeEventListener('pointerdown', down, o)
      canvas?.removeEventListener('pointermove', move, o)
      canvas?.removeEventListener('pointerup', up, o)
      canvas?.removeEventListener('pointercancel', up, o)
      canvas?.removeEventListener('contextmenu', menu, o)
      clear()
    },
  }
}
