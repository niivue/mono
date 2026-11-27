// A sub-volume selector: right-click two points on the scene and the box they
// span becomes an ephemeral copy of that part of the volume, as the block
// picker (`extractChunkBlock`) does for one brick. A slice tile picks the
// point under the pointer on its plane, a 3D render tile depth-picks the first
// visible voxel (an exploded chunked volume is picked brick by brick); over
// empty space the second corner goes to the depth of the first. Between
// the corners a fainter outline follows the pointer. When both corners are on
// one slice orientation the box is that slice's face: a right-click on another
// slice orientation then sets its depth (again, until a new box starts). Any
// other right-click starts a new box. Shift+right-click still opens the context menu. Register
// it as an overlay renderer too (`registerOverlayRenderer`) to outline the
// box's cross-section on each 2D slice that cuts it.
//
// Turn draw and annotation modes off while it is attached: they claim the
// right button on the render tile too.

import {
  chunkExplodeEnabled,
  type ExplodedBlockPick,
  type ExtractedSubVolume,
  extractSubVolume,
  type FocusBox,
  type NVImage,
  projectMMToCanvas,
  SLICE_TYPE,
  type SliceTile,
  type SubVolumeBox,
  subVolumeBox,
} from '@niivue/niivue'
import type { UIKitHost } from './controls'
import type { UIKitOverlayFrame } from './hook'
import { buildRect, type UIKitBox } from './rect'
import { UIKitRectOverlay } from './rectOverlay'

type Vec3 = [number, number, number]

/** The parts of NiiVue the selector picks and outlines with. */
export interface SubvolumeSelectorHost extends UIKitHost {
  readonly volumes: NVImage[]
  focusBox: FocusBox | null
  hitTest(canvasX: number, canvasY: number): { isRender: boolean } | null
  canvasToMM(canvasX: number, canvasY: number): Vec3 | null
  pickAt(canvasX: number, canvasY: number): Promise<Vec3 | null>
  pickRay(canvasX: number, canvasY: number): { origin: Vec3; dir: Vec3 } | null
  pickExplodedBlock(clientX: number, clientY: number): ExplodedBlockPick | null
  getScreenTiles(): readonly SliceTile[]
}

/** A box of `volumes[0]` (see `subVolumeBox`) and its voxel copy. */
export interface SubvolumeSelection extends SubVolumeBox {
  /**
   * The copy, or null when the voxels are not on the CPU (a streamed
   * volume: crop the source to `voxelOrigin`/`voxelDims` instead) or are
   * RGB/RGBA.
   */
  subVolume: ExtractedSubVolume | null
}

export interface UIKitSubvolumeSelectorOptions {
  /** Called once both corners are picked. */
  onSelect?: (selection: SubvolumeSelection) => void
  /** Called when the first corner is picked. */
  onCorner?: (mm: Vec3) => void
  /** Outline color of the picked box. Default yellow. */
  color?: number[]
  /** Outline thickness. Default 2. */
  thickness?: number
}

/**
 * Canvas rects (backing-store px) of `box`'s cross-section on each 2D tile
 * whose plane cuts it, at least `minPx` wide and clipped to the tile.
 * shortcut: the plane is taken along its dominant normal axis, so an oblique
 * tile gets the box's axis-aligned slab, not its exact polygon.
 */
export function sliceOutlineRects(
  tiles: readonly SliceTile[],
  box: Pick<FocusBox, 'min' | 'max'>,
  minPx: number,
): UIKitBox[] {
  const out: UIKitBox[] = []
  for (const t of tiles) {
    const { mvpMatrix: mvp, planeNormal: n, planePoint: pp } = t
    const ltwh = t.leftTopWidthHeight
    if (!mvp || !n || !pp || !ltwh || t.axCorSag === SLICE_TYPE.RENDER) continue
    const ax = [0, 1, 2]
    const k = dominantAxis(n)
    // A slice on a voxel edge, as the first corner's own slice can be, sits
    // on the box face give or take float32 rounding.
    if (pp[k] < box.min[k] - 1e-3 || pp[k] > box.max[k] + 1e-3) continue
    const [u, v] = ax.filter((a) => a !== k)
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let c = 0; c < 4; c++) {
      const mm: Vec3 = [0, 0, 0]
      mm[k] = pp[k]
      mm[u] = c & 1 ? box.max[u] : box.min[u]
      mm[v] = c & 2 ? box.max[v] : box.min[v]
      const [x, y] = projectMMToCanvas(mm, mvp, ltwh)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    // A one-voxel corner can be a pixel across: keep it visible.
    const grow = (a: number, b: number): [number, number] => {
      const pad = Math.max(0, (minPx - (b - a)) / 2)
      return [a - pad, b + pad]
    }
    ;[x0, x1] = grow(x0, x1)
    ;[y0, y1] = grow(y0, y1)
    x0 = Math.max(x0, ltwh[0])
    y0 = Math.max(y0, ltwh[1])
    x1 = Math.min(x1, ltwh[0] + ltwh[2])
    y1 = Math.min(y1, ltwh[1] + ltwh[3])
    if (x1 > x0 && y1 > y0)
      out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
  }
  return out
}

export class UIKitSubvolumeSelector {
  onSelect: ((selection: SubvolumeSelection) => void) | null
  onCorner: ((mm: Vec3) => void) | null
  color: number[]
  thickness: number
  private first: Vec3 | null = null
  // The slice axis (world RAS) the first corner was picked across, if a slice.
  private firstAxis: number | null = null
  // A box picked on one slice orientation: its corners and that slice's axis.
  private face: { a: Vec3; b: Vec3; k: number } | null = null
  /** Bumped per press and by reset(): a pick resolving under an old value is stale. */
  private pickSeq = 0
  private depthPreview = false
  private host: SubvolumeSelectorHost | null = null
  private shown: FocusBox | null = null
  private readonly rects = new UIKitRectOverlay()

  constructor(options: UIKitSubvolumeSelectorOptions = {}) {
    this.onSelect = options.onSelect ?? null
    this.onCorner = options.onCorner ?? null
    this.color = options.color ?? [1, 1, 0, 1]
    this.thickness = options.thickness ?? 2
  }

  /** The first corner, while waiting for the second. */
  get pendingCorner(): Vec3 | null {
    return this.first
  }

  /**
   * Add a picked point: the first starts a box, the second completes it.
   * `sliceAxis` is the world axis normal to the slice it was picked on.
   */
  addPoint(
    mm: Vec3,
    sliceAxis: number | null = null,
  ): SubvolumeSelection | null {
    if (!this.host?.volumes[0]) return null
    const first = this.first
    if (!first) {
      this.first = mm
      this.firstAxis = sliceAxis
      this.face = null
      this.preview(mm)
      this.onCorner?.(mm)
      return null
    }
    this.first = null
    this.face =
      sliceAxis !== null && sliceAxis === this.firstAxis
        ? { a: first, b: mm, k: sliceAxis }
        : null
    return this.select(first, mm)
  }

  /** Stretch a one-slice box to `mm` along that slice's axis; null without one. */
  setDepth(mm: Vec3): SubvolumeSelection | null {
    const face = this.face
    if (!face) return null
    const b: Vec3 = [...face.b]
    b[face.k] = mm[face.k]
    face.b = b
    return this.select(face.a, b)
  }

  /** The box `face` would have with its depth at `mm`. */
  private depthBox(mm: Vec3): SubVolumeBox | null {
    const face = this.face
    const vol = this.host?.volumes[0]
    if (!face || !vol) return null
    const b: Vec3 = [...face.b]
    b[face.k] = mm[face.k]
    return subVolumeBox(vol, face.a, b)
  }

  private select(a: Vec3, b: Vec3): SubvolumeSelection | null {
    const vol = this.host?.volumes[0]
    if (!vol) return null
    this.depthPreview = false
    const box = subVolumeBox(vol, a, b)
    if (!box) {
      this.outline(null)
      return null
    }
    this.outline({
      min: box.minMM,
      max: box.maxMM,
      color: this.color,
      thickness: this.thickness,
    })
    const selection = {
      ...box,
      subVolume: extractSubVolume(vol, box.voxelOrigin, box.voxelDims),
    }
    this.onSelect?.(selection)
    return selection
  }

  /** Outline the box from the first corner to `mm`, fainter than a picked one. */
  preview(mm: Vec3): void {
    const host = this.host
    const vol = host?.volumes[0]
    if (!host || !vol || !this.first) return
    const box = subVolumeBox(vol, this.first, mm)
    if (!box) return
    this.faint(box)
  }

  private faint(box: Pick<SubvolumeSelection, 'minMM' | 'maxMM'>): void {
    this.outline({
      min: box.minMM,
      max: box.maxMM,
      color: [this.color[0], this.color[1], this.color[2], 0.5],
      thickness: this.thickness,
    })
  }

  /** Forget a half-picked box and clear the outline. */
  reset(): void {
    // Drop picks still in flight so they cannot restore a corner.
    this.pickSeq++
    this.first = null
    this.face = null
    this.outline(null)
  }

  /** Outline the box's cross-section on each 2D slice that cuts it. */
  drawOverlay(frame: UIKitOverlayFrame): void {
    const box = this.shown
    if (!box || !this.host) return
    const tiles = this.host.getScreenTiles()
    const border = box.thickness * frame.dpr
    this.rects.setRects(
      sliceOutlineRects(tiles, box, 6 * frame.dpr).map((r) =>
        buildRect({
          ...r,
          borderWidth: border,
          fill: [0, 0, 0, 0],
          border: box.color,
        }),
      ),
    )
    this.rects.drawOverlay(frame)
  }

  /** Show `box` on the slices and, unless exploded, the 3D render. */
  private outline(box: FocusBox | null): void {
    const host = this.host
    if (!host) return
    this.shown = box
    // An exploded volume is drawn brick by brick: no one world box outlines it.
    const vol = host.volumes[0]
    if (box && vol && isExploded(vol)) {
      host.focusBox = null
      host.drawScene()
    } else host.focusBox = box
  }

  /** Take right-clicks on the host canvas; returns the unwire function. */
  attach(host: SubvolumeSelectorHost): () => void {
    const canvas = host.canvas
    if (!canvas) throw new Error('UIKit: host has no canvas to attach to')
    this.host = host
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 2 || e.shiftKey) return
      const p = host.clientToCanvas(e.clientX, e.clientY)
      const hit = p && host.hitTest(p[0], p[1])
      if (!p || !hit) return
      // Ahead of the scene's own right-drag (clip plane, 3D pen).
      e.stopImmediatePropagation()
      e.preventDefault()
      const at = ++this.pickSeq
      const axis = hit.isRender ? null : sliceAxisAt(host.getScreenTiles(), p)
      const face = this.face
      if (!this.first && face && axis !== null && axis !== face.k) {
        const mm = host.canvasToMM(p[0], p[1])
        if (mm) this.setDepth(mm)
        return
      }
      void this.pick(host, hit.isRender, p, e).then((mm) => {
        // A later press supersedes a slow depth pick.
        if (mm && at === this.pickSeq && this.host === host)
          this.addPoint(mm, axis)
      })
    }
    // One depth pick in flight at a time: moves while it runs are dropped.
    let moving = false
    const onMove = (e: PointerEvent): void => {
      const first = this.first
      if (!first) {
        this.moveDepth(host, e)
        return
      }
      if (moving) return
      const p = host.clientToCanvas(e.clientX, e.clientY)
      const hit = p && host.hitTest(p[0], p[1])
      if (!p || !hit) return
      if (!hit.isRender) {
        const mm = host.canvasToMM(p[0], p[1])
        if (mm) this.preview(mm)
        return
      }
      moving = true
      void this.renderPick(host, p)
        .then((mm) => {
          // A press while picking moved on to a new box (or finished this one).
          if (mm && this.first === first && this.host === host) this.preview(mm)
        })
        // A failed pick must not drop every later preview.
        .finally(() => {
          moving = false
        })
    }
    const opts = { capture: true }
    canvas.addEventListener('pointerdown', onDown, opts)
    canvas.addEventListener('pointermove', onMove)
    return () => {
      canvas.removeEventListener('pointerdown', onDown, opts)
      canvas.removeEventListener('pointermove', onMove)
      this.reset()
      this.host = null
    }
  }

  /** Over another slice orientation, preview a one-slice box's depth. */
  private moveDepth(host: SubvolumeSelectorHost, e: PointerEvent): void {
    const face = this.face
    if (!face) return
    const p = host.clientToCanvas(e.clientX, e.clientY)
    const hit = p && host.hitTest(p[0], p[1])
    const axis =
      p && hit && !hit.isRender ? sliceAxisAt(host.getScreenTiles(), p) : null
    const mm =
      axis !== null && axis !== face.k && p && host.canvasToMM(p[0], p[1])
    const box = mm ? this.depthBox(mm) : null
    if (box) {
      this.depthPreview = true
      this.faint(box)
    } else if (this.depthPreview) {
      // Off the other views: back to the picked box.
      this.depthPreview = false
      const vol = host.volumes[0]
      const picked = vol && subVolumeBox(vol, face.a, face.b)
      if (picked)
        this.outline({
          min: picked.minMM,
          max: picked.maxMM,
          color: this.color,
          thickness: this.thickness,
        })
    }
  }

  private async pick(
    host: SubvolumeSelectorHost,
    isRender: boolean,
    p: [number, number],
    e: PointerEvent,
  ): Promise<Vec3 | null> {
    if (!isRender) return host.canvasToMM(p[0], p[1])
    // The depth pick ray-marches the un-exploded volume, so ask the bricks.
    if (host.volumes.some(isExploded))
      return host.pickExplodedBlock(e.clientX, e.clientY)?.mm ?? null
    return this.renderPick(host, p)
  }

  /**
   * Depth-pick; over empty space with a first corner set, the ray point
   * nearest that corner, so the second corner can sit off the surface.
   */
  private async renderPick(
    host: SubvolumeSelectorHost,
    p: [number, number],
  ): Promise<Vec3 | null> {
    const mm = await host.pickAt(p[0], p[1])
    const first = this.first
    if (mm || !first) return mm
    return nearestOnRay(host.pickRay(p[0], p[1]), first)
  }
}

/** The point on a ray (unit dir) nearest `to`: the ray's cut with the plane through `to` facing the viewer. */
export function nearestOnRay(
  ray: { origin: Vec3; dir: Vec3 } | null,
  to: Vec3,
): Vec3 | null {
  if (!ray) return null
  const { origin: o, dir: d } = ray
  const t =
    (to[0] - o[0]) * d[0] + (to[1] - o[1]) * d[1] + (to[2] - o[2]) * d[2]
  return [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]]
}

/** The world axis (0 x, 1 y, 2 z) normal to the 2D tile under canvas point `p`. */
export function sliceAxisAt(
  tiles: readonly SliceTile[],
  p: readonly [number, number],
): number | null {
  for (const t of tiles) {
    const r = t.leftTopWidthHeight
    const n = t.planeNormal
    if (!r || !n || t.axCorSag === SLICE_TYPE.RENDER) continue
    // Right and bottom edges are exclusive, as in NiiVue's tile hit test.
    if (
      p[0] < r[0] ||
      p[1] < r[1] ||
      p[0] >= r[0] + r[2] ||
      p[1] >= r[1] + r[3]
    )
      continue
    return dominantAxis(n)
  }
  return null
}

function dominantAxis(n: ArrayLike<number>): number {
  return [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a))
}

function isExploded(vol: NVImage): boolean {
  return !!vol.chunkPlan && chunkExplodeEnabled(vol.chunkExplode)
}
