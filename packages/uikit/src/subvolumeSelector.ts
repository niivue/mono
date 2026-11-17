// A sub-volume selector: right-click two points on the scene and the box they
// span becomes an ephemeral copy of that part of the volume, as the block
// picker (`extractChunkBlock`) does for one brick. A slice tile picks the
// point under the pointer on its plane, a 3D render tile depth-picks the first
// visible voxel (an exploded chunked volume is picked brick by brick); over
// empty space the second corner goes to the depth of the first. Between
// the corners a fainter outline follows the pointer. A third right-click
// starts a new box. Shift+right-click still opens the context menu. Register
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
  type UIKitOverlayFrame,
} from '@niivue/niivue'
import type { UIKitHost } from './controls'
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

export interface SubvolumeSelection {
  /** The box's first voxel and extent in `volumes[0]`'s RAS voxel grid. */
  voxelOrigin: Vec3
  voxelDims: Vec3
  /** The box's outer edges in world mm (its voxels' corners, not centres). */
  minMM: Vec3
  maxMM: Vec3
  /**
   * The copy, or null when the voxels are not on the CPU (a streamed
   * volume): crop the source to `voxelOrigin`/`voxelDims` instead.
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
 * The voxel box of `vol` holding both mm points, with its outer mm edges.
 * Null when the volume has no RAS grid or the box misses it.
 */
export function subvolumeBox(
  vol: NVImage,
  aMM: Vec3,
  bMM: Vec3,
): Omit<SubvolumeSelection, 'subVolume'> | null {
  const m = vol.matRAS as ArrayLike<number> | undefined
  const d = vol.dimsRAS as number[] | undefined
  if (!m || !d) return null
  const a = mmToVoxel(m, aMM)
  const b = mmToVoxel(m, bMM)
  const voxelOrigin: Vec3 = [0, 0, 0]
  const voxelDims: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const lo = Math.max(0, Math.round(Math.min(a[k], b[k])))
    const hi = Math.min(d[k + 1] - 1, Math.round(Math.max(a[k], b[k])))
    if (hi < lo) return null
    voxelOrigin[k] = lo
    voxelDims[k] = hi - lo + 1
  }
  const minMM: Vec3 = [Infinity, Infinity, Infinity]
  const maxMM: Vec3 = [-Infinity, -Infinity, -Infinity]
  // Eight corners, so an oblique volume's outline still encloses its voxels.
  for (let c = 0; c < 8; c++) {
    const v = [0, 1, 2].map(
      (k) => voxelOrigin[k] - 0.5 + ((c >> k) & 1) * voxelDims[k],
    )
    for (let r = 0; r < 3; r++) {
      const mm =
        m[r * 4] * v[0] +
        m[r * 4 + 1] * v[1] +
        m[r * 4 + 2] * v[2] +
        m[r * 4 + 3]
      minMM[r] = Math.min(minMM[r], mm)
      maxMM[r] = Math.max(maxMM[r], mm)
    }
  }
  return { voxelOrigin, voxelDims, minMM, maxMM }
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
    const k = ax.reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a))
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

/** Invert the row-major voxel->mm affine for one point. */
function mmToVoxel(m: ArrayLike<number>, mm: Vec3): Vec3 {
  const [a, b, c, e, f, g, h, i, j] = [
    m[0],
    m[1],
    m[2],
    m[4],
    m[5],
    m[6],
    m[8],
    m[9],
    m[10],
  ]
  const x = mm[0] - m[3]
  const y = mm[1] - m[7]
  const z = mm[2] - m[11]
  const det = a * (f * j - g * i) - b * (e * j - g * h) + c * (e * i - f * h)
  return [
    ((f * j - g * i) * x - (b * j - c * i) * y + (b * g - c * f) * z) / det,
    (-(e * j - g * h) * x + (a * j - c * h) * y - (a * g - c * e) * z) / det,
    ((e * i - f * h) * x - (a * i - b * h) * y + (a * f - b * e) * z) / det,
  ]
}

export class UIKitSubvolumeSelector {
  onSelect: ((selection: SubvolumeSelection) => void) | null
  onCorner: ((mm: Vec3) => void) | null
  color: number[]
  thickness: number
  private first: Vec3 | null = null
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

  /** Add a picked point: the first starts a box, the second completes it. */
  addPoint(mm: Vec3): SubvolumeSelection | null {
    const host = this.host
    const vol = host?.volumes[0]
    if (!host || !vol) return null
    if (!this.first) {
      this.first = mm
      this.preview(mm)
      this.onCorner?.(mm)
      return null
    }
    const box = subvolumeBox(vol, this.first, mm)
    this.first = null
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
    const box = subvolumeBox(vol, this.first, mm)
    if (!box) return
    this.outline({
      min: box.minMM,
      max: box.maxMM,
      color: [this.color[0], this.color[1], this.color[2], 0.5],
      thickness: this.thickness,
    })
  }

  /** Forget a half-picked box and clear the outline. */
  reset(): void {
    this.first = null
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
    let seq = 0
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 2 || e.shiftKey) return
      const p = host.clientToCanvas(e.clientX, e.clientY)
      const hit = p && host.hitTest(p[0], p[1])
      if (!p || !hit) return
      // Ahead of the scene's own right-drag (clip plane, 3D pen).
      e.stopImmediatePropagation()
      e.preventDefault()
      const at = ++seq
      void this.pick(host, hit.isRender, p, e).then((mm) => {
        // A later press supersedes a slow depth pick.
        if (mm && at === seq && this.host === host) this.addPoint(mm)
      })
    }
    // One depth pick in flight at a time: moves while it runs are dropped.
    let moving = false
    const onMove = (e: PointerEvent): void => {
      const first = this.first
      if (!first || moving) return
      const p = host.clientToCanvas(e.clientX, e.clientY)
      const hit = p && host.hitTest(p[0], p[1])
      if (!p || !hit) return
      if (!hit.isRender) {
        const mm = host.canvasToMM(p[0], p[1])
        if (mm) this.preview(mm)
        return
      }
      moving = true
      void this.renderPick(host, p).then((mm) => {
        moving = false
        // A press while picking moved on to a new box (or finished this one).
        if (mm && this.first === first && this.host === host) this.preview(mm)
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

function isExploded(vol: NVImage): boolean {
  return !!vol.chunkPlan && chunkExplodeEnabled(vol.chunkExplode)
}
