// A sub-volume selector: right-click two points on the scene and the box they
// span becomes an ephemeral copy of that part of the volume, as the block
// picker (`extractChunkBlock`) does for one brick. A slice tile picks the
// point under the pointer on its plane, a 3D render tile depth-picks the first
// visible voxel (an exploded chunked volume is picked brick by brick). Between
// the corners a fainter outline follows the pointer. A third right-click
// starts a new box. Shift+right-click still opens the context menu.
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
} from '@niivue/niivue'
import type { UIKitHost } from './controls'

type Vec3 = [number, number, number]

/** The parts of NiiVue the selector picks and outlines with. */
export interface SubvolumeSelectorHost extends UIKitHost {
  readonly volumes: NVImage[]
  focusBox: FocusBox | null
  hitTest(canvasX: number, canvasY: number): { isRender: boolean } | null
  canvasToMM(canvasX: number, canvasY: number): Vec3 | null
  pickAt(canvasX: number, canvasY: number): Promise<Vec3 | null>
  pickExplodedBlock(clientX: number, clientY: number): ExplodedBlockPick | null
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
      host.focusBox = null
      this.preview(mm)
      this.onCorner?.(mm)
      return null
    }
    const box = subvolumeBox(vol, this.first, mm)
    this.first = null
    if (!box) return null
    // An exploded volume is drawn brick by brick: no one world box outlines it.
    if (!isExploded(vol))
      host.focusBox = {
        min: box.minMM,
        max: box.maxMM,
        color: this.color,
        thickness: this.thickness,
      }
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
    if (!host || !vol || !this.first || isExploded(vol)) return
    const box = subvolumeBox(vol, this.first, mm)
    if (!box) return
    host.focusBox = {
      min: box.minMM,
      max: box.maxMM,
      color: [this.color[0], this.color[1], this.color[2], 0.5],
      thickness: this.thickness,
    }
  }

  /** Forget a half-picked box and clear the outline. */
  reset(): void {
    this.first = null
    if (this.host) this.host.focusBox = null
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
      void host.pickAt(p[0], p[1]).then((mm) => {
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
    return host.pickAt(p[0], p[1])
  }
}

function isExploded(vol: NVImage): boolean {
  return !!vol.chunkPlan && chunkExplodeEnabled(vol.chunkExplode)
}
