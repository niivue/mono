import type { NiiVue, NVImage, OverlayFrame } from '@niivue/niivue'
import { projectMMToCanvas } from '@niivue/niivue'
import { UIKitMagnifierOverlay } from '@niivue/uikit'
import { apply, invertAffine, rasGrid, SLICE_AXIS } from './quantify'

// Cornerstone AdvancedMagnifyTool defaults (radius in canvas CSS px).
const RADIUS_CSS = 125
const ZOOM = 3
const ZOOM_FACTORS = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]
// cornerstone MOUSE_PROXIMITY / TOUCH_PROXIMITY (CSS px), touch press delay,
// and the movement (CSS px) that still counts as a press or tap.
const PROXIMITY = { mouse: 6, touch: 36 }
const PRESS_MS = 700
const SLOP_CSS = 10
// RAS axis across axial, coronal, sagittal slices.

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
  | 'addEventListener'
  | 'removeEventListener'
>

/** A placed glass: centre in world mm and the rim as a world offset, so it pans, zooms and slices with the image. */
interface Glass {
  center: Vec3
  rim: Vec3
  sliceType: number
  volume: NVImage
  lens: UIKitMagnifierOverlay
  /** This frame's tile and canvas centre and radius (backing px); null when not shown. */
  at: { tile: number; x: number; y: number; r: number } | null
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/**
 * OHIF's AdvancedMagnify on a NiiVue pane, as cornerstone's: Active places a
 * glass per click; Active or Passive glasses move (rim, or inside on touch),
 * resize (rim handles) and change zoom (Shift+right-click or a long touch);
 * any other mode removes them all.
 */
export function createAdvancedMagnifyBinding(nv: Host) {
  const glasses: Glass[] = []
  let mode: 'Active' | 'Passive' | undefined
  let unregister: (() => void) | null = null
  let select: HTMLSelectElement | null = null
  // Removing a focused select fires its blur: unhook first, or blur removes it twice.
  const closeList = () => {
    const s = select
    select = null
    if (s) s.onblur = null
    s?.remove()
  }
  // Core swaps in a new canvas on a backend change and says so in viewAttached.
  let canvas: HTMLCanvasElement | null = null

  const renderer = {
    drawOverlay(frame: OverlayFrame) {
      const vol = nv.volumes[0]
      // A series swap in this pane drops the old series' glasses.
      for (const g of glasses.filter((g) => g.volume !== vol)) drop(g)
      const grid = vol && rasGrid(vol)
      if (!grid) return
      const mm2vox = invertAffine(grid.affine)
      const tiles = nv.getScreenTiles()
      for (const g of glasses) {
        g.at = null
        const axis = SLICE_AXIS[g.sliceType] as number
        const slice = Math.round(apply(mm2vox, g.center, axis))
        tiles.some((t, tile) => {
          const { mvpMatrix: m, planePoint: q, leftTopWidthHeight: ltwh } = t
          // Shown on its own slice only: the tile's plane follows the
          // (unsnapped) crosshair, so compare voxel slice indices.
          if (t.axCorSag !== g.sliceType || !m || !q || !ltwh) return false
          if (Math.round(apply(mm2vox, q, axis)) !== slice) return false
          const [x, y] = projectMMToCanvas(g.center, m, ltwh)
          const [l = 0, top = 0, w = 0, h = 0] = ltwh
          // ponytail: a glass near a tile edge spills over its neighbour (the lens has no scissor).
          if (x < l || x >= l + w || y < top || y >= top + h) return false
          const [rx, ry] = projectMMToCanvas(add(g.center, g.rim), m, ltwh)
          g.at = { tile, x, y, r: Math.hypot(rx - x, ry - y) }
          return true
        })
        const at = g.at as Glass['at']
        if (!at) continue
        g.lens.radiusCss = at.r / frame.dpr
        g.lens.pointerMove(at.x, at.y)
        g.lens.drawOverlay(frame)
      }
    },
  }

  const register = () => {
    unregister?.()
    unregister = glasses.length ? nv.registerOverlayRenderer(renderer) : null
  }
  const drop = (g: Glass) => {
    glasses.splice(glasses.indexOf(g), 1)
    g.lens.destroy()
    if (drag?.g === g) {
      drag = null
      touches.clear()
    }
    // Called from the renderer: unregistering now would splice core's
    // renderer list mid-dispatch and skip the next renderer this frame.
    if (!glasses.length) queueMicrotask(register)
  }
  const clear = () => {
    drag = null
    touches.clear()
    closeList()
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
        ].some(([hx = 0, hy = 0]) => Math.hypot(x - hx, y - hy) < prox)
        return { g, kind: handle ? ('resize' as const) : ('move' as const) }
      }
      if (touch && d < r) return { g, kind: 'move' as const }
    }
    return null
  }

  const showZoomList = (g: Glass, clientX: number, clientY: number) => {
    const parent = canvas?.parentElement
    if (!parent) return
    closeList()
    const s = document.createElement('select')
    select = s
    const box = parent.getBoundingClientRect()
    s.style.cssText = `position:absolute;left:${clientX - box.left}px;top:${clientY - box.top}px;z-index:10`
    for (const z of ZOOM_FACTORS) {
      const o = new Option(String(z), String(z), false, z === g.lens.zoom)
      o.title = `Zoom factor ${z.toFixed(1)}`
      s.add(o)
    }
    s.addEventListener('change', () => {
      g.lens.zoom = Number.parseFloat(s.value)
      closeList()
      nv.drawScene()
    })
    s.onblur = closeList
    parent.appendChild(s)
    s.focus()
  }

  // A drag on a glass, held to the tile it started on (another tile's pick
  // lies on another plane and would push the glass off its slice).
  let drag: {
    g: Glass
    kind: 'move' | 'resize'
    last: Vec3 | null
    id: number
    tile: number
  } | null = null
  // Touches still within the slop of where they began (a tap or a press);
  // a second finger makes the gesture core's pinch.
  const touches = new Map<number, { x: number; y: number; t: number }>()
  let pinched = false
  // Fingers added to a glass drag: the gesture is the glass's, so core sees none of it.
  const owned = new Set<number>()
  // Fingers down on this canvas (each OHIF pane has its own; isPrimary is page-wide).
  const fingers = new Set<number>()
  const mmOnTile = (e: PointerEvent, tile: number) => {
    const p = nv.clientToCanvas(e.clientX, e.clientY)
    if (!p || nv.hitTest(p[0], p[1])?.tileIndex !== tile) return null
    return nv.canvasToMM(p[0], p[1])
  }

  const placeAt = (x: number, y: number) => {
    const tile = nv.hitTest(x, y)
    const center = nv.canvasToMM(x, y)
    const vol = nv.volumes[0]
    if (!tile || tile.isRender || !center || !vol) return false
    // A rim offset one radius away on this plane, scaled from a 1 px step on
    // the same tile (the rim itself may lie past the tile's edge).
    const dx = nv.hitTest(x + 1, y)?.tileIndex === tile.tileIndex ? 1 : -1
    const step = nv.canvasToMM(x + dx, y)
    if (!step) return false
    const k = RADIUS_CSS * nv.effectiveDevicePixelRatio
    glasses.push({
      center,
      rim: sub(step, center).map((v) => v * k) as Vec3,
      sliceType: tile.sliceType,
      volume: vol,
      lens: new UIKitMagnifierOverlay({ zoom: ZOOM }),
      at: null,
    })
    if (glasses.length === 1) register()
    nv.drawScene()
    return true
  }

  const down = (e: PointerEvent) => {
    const touch = e.pointerType === 'touch'
    const second = touch && fingers.size > 0
    if (touch) fingers.add(e.pointerId)
    // A mouse drag still live at a new press was released off the canvas.
    else if (drag?.id === e.pointerId) drag = null
    if (!mode) return
    const p = nv.clientToCanvas(e.clientX, e.clientY)
    if (!p) return
    if (touch && drag) {
      owned.add(e.pointerId)
      // No longer a still press: lifting the drag finger must not open the zoom list.
      touches.delete(drag.id)
      e.stopImmediatePropagation()
      return
    }
    if (second) {
      // A finger added while another is down (moved or not): core's pinch;
      // no finger of it places.
      touches.clear()
      pinched = true
      return
    }
    const hit = grab(p[0], p[1], touch)
    if (hit && e.button === 2 && e.shiftKey) {
      e.stopImmediatePropagation()
      e.preventDefault()
      showZoomList(hit.g, e.clientX, e.clientY)
      return
    }
    if (e.button !== 0) return
    if (touch) {
      pinched = false
      if (hit || mode === 'Active')
        touches.set(e.pointerId, { x: p[0], y: p[1], t: e.timeStamp })
    }
    if (hit) {
      e.stopImmediatePropagation()
      const tile = hit.g.at?.tile ?? -1
      drag = { ...hit, last: mmOnTile(e, tile), id: e.pointerId, tile }
      return
    }
    // A mouse press places now. A touch places on a still lift (up); its
    // press reaches core so a second finger can still pinch.
    // ponytail: core also sees the tap (it may move the crosshair there).
    if (mode === 'Active' && !touch && placeAt(p[0], p[1]))
      e.stopImmediatePropagation()
  }

  const move = (e: PointerEvent) => {
    if (owned.has(e.pointerId)) {
      e.stopImmediatePropagation()
      return
    }
    const t = touches.get(e.pointerId)
    const p = t && nv.clientToCanvas(e.clientX, e.clientY)
    if (
      t &&
      p &&
      Math.hypot(p[0] - t.x, p[1] - t.y) >
        SLOP_CSS * nv.effectiveDevicePixelRatio
    )
      touches.delete(e.pointerId)
    if (!drag || e.pointerId !== drag.id) return
    // A mouse released off the canvas never sent its pointerup here.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      drag = null
      return
    }
    e.stopImmediatePropagation()
    const mm = mmOnTile(e, drag.tile)
    if (!mm) return
    const { g } = drag
    if (drag.kind === 'resize') g.rim = sub(mm, g.center)
    else if (drag.last) g.center = add(g.center, sub(mm, drag.last))
    drag.last = mm
    nv.drawScene()
  }

  const up = (e: PointerEvent) => {
    fingers.delete(e.pointerId)
    if (owned.delete(e.pointerId)) {
      e.stopImmediatePropagation()
      return
    }
    const t = touches.get(e.pointerId)
    touches.delete(e.pointerId)
    const still = t && e.type === 'pointerup' ? t : undefined
    if (drag && e.pointerId === drag.id) {
      e.stopImmediatePropagation()
      // A still touch held PRESS_MS on a glass opens its zoom list on lift,
      // so the lift cannot blur it shut.
      if (still && e.timeStamp - still.t >= PRESS_MS)
        showZoomList(drag.g, e.clientX, e.clientY)
      drag = null
      return
    }
    // Core saw this tap's press, so it also gets the release (else its drag and
    // pinch trackers keep a lifted finger).
    if (still && !pinched && mode === 'Active') placeAt(still.x, still.y)
  }

  const onGlass = (e: MouseEvent) => {
    const p = nv.clientToCanvas(e.clientX, e.clientY)
    return p ? grab(p[0], p[1], false) : null
  }
  // Shift+right-click on a glass opens its zoom list, not OHIF's menu.
  const menu = (e: MouseEvent) => {
    if (e.shiftKey && onGlass(e)) {
      e.stopImmediatePropagation()
      e.preventDefault()
    }
  }
  // A double-click placing or grabbing a glass must not depth-pick the crosshair.
  const dblclick = (e: MouseEvent) => {
    if (!mode) return
    const p = nv.clientToCanvas(e.clientX, e.clientY)
    const tile = p && nv.hitTest(p[0], p[1])
    if (onGlass(e) || (mode === 'Active' && tile && !tile.isRender))
      e.stopImmediatePropagation()
  }

  const listeners = [
    ['pointerdown', down],
    ['pointermove', move],
    ['pointerup', up],
    ['pointercancel', up],
    ['contextmenu', menu],
    ['dblclick', dblclick],
  ] as const
  const o = { capture: true }
  const listen = (on: boolean) => {
    for (const [type, fn] of listeners)
      if (on) canvas?.addEventListener(type, fn as EventListener, o)
      else canvas?.removeEventListener(type, fn as EventListener, o)
  }
  const attach = () => {
    listen(false)
    // The old canvas will not deliver the releases of gestures still down on it.
    drag = null
    touches.clear()
    owned.clear()
    fingers.clear()
    pinched = false
    closeList()
    canvas = nv.canvas
    listen(true)
  }
  attach()
  nv.addEventListener('viewAttached', attach)

  return {
    /** OHIF's AdvancedMagnify mode in the pane's tool group. */
    setMode(m: string | undefined): void {
      mode = m === 'Active' || m === 'Passive' ? m : undefined
      if (!mode) clear()
    },
    /** Re-register last, above overlays registered since (the lens magnifies them). */
    raise: register,
    dispose(): void {
      nv.removeEventListener('viewAttached', attach)
      listen(false)
      clear()
    },
  }
}
