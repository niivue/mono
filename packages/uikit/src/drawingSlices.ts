// Which slices of the drawing hold painted voxels, along each RAS axis. Kept
// current from NiiVue's `drawingChanged`: an edit that reports its voxel box
// costs only that box, anything else one pass over the bitmap.

import type { DrawingChangedDetail } from '@niivue/niivue'

/** The slice of a NiiVue instance the tracker reads. */
export interface UIKitDrawingSource {
  drawingVolume: {
    img?: ArrayLike<number> | null
    dimsRAS?: ArrayLike<number>
  } | null
  addEventListener(
    type: 'drawingChanged',
    listener: (evt: CustomEvent<DrawingChangedDetail>) => void,
  ): void
  removeEventListener(
    type: 'drawingChanged',
    listener: (evt: CustomEvent<DrawingChangedDetail>) => void,
  ): void
}

export class UIKitDrawingSlices {
  /** Painted voxel count per slice along RAS x, y and z. */
  private counts: [Uint32Array, Uint32Array, Uint32Array] = [
    new Uint32Array(0),
    new Uint32Array(0),
    new Uint32Array(0),
  ]
  /** One bit per voxel: painted at the last update, to diff a box against. */
  private painted = new Uint8Array(0)
  private readonly listener = (evt: CustomEvent<DrawingChangedDetail>) => {
    this.update(evt.detail.box)
    this.onChange?.()
  }

  /** `onChange` fires after each update, e.g. to refresh slider `marks`. */
  constructor(
    private readonly nv: UIKitDrawingSource,
    private readonly onChange?: () => void,
  ) {
    nv.addEventListener('drawingChanged', this.listener)
    this.update()
  }

  /**
   * Recount from the drawing: within `box` (inclusive RAS voxels) when only
   * that changed, else everywhere. NiiVue edits that skip `drawingChanged`
   * (e.g. `drawingVolume.img` written directly) need a call with no box.
   */
  update(box?: DrawingChangedDetail['box']): void {
    const vol = this.nv.drawingVolume
    const img = vol?.img
    const d = vol?.dimsRAS
    if (!img || !d) {
      this.reset(0, 0, 0)
      return
    }
    const [nx, ny, nz] = [d[1], d[2], d[3]]
    const [cx, cy, cz] = this.counts
    if (!box || cx.length !== nx || cy.length !== ny || cz.length !== nz) {
      this.recount(img, nx, ny, nz)
      return
    }
    const painted = this.painted
    const [ax, ay, az] = this.counts
    for (let z = box.min[2]; z <= box.max[2]; z++) {
      for (let y = box.min[1]; y <= box.max[1]; y++) {
        const row = nx * (y + ny * z)
        for (let x = box.min[0]; x <= box.max[0]; x++) {
          const i = row + x
          const bit = 1 << (i & 7)
          const was = painted[i >> 3] & bit
          if ((img[i] !== 0) === (was !== 0)) continue
          painted[i >> 3] ^= bit
          const delta = was ? -1 : 1
          ax[x] += delta
          ay[y] += delta
          az[z] += delta
        }
      }
    }
  }

  /** Painted slices along `axis` (0 x, 1 y, 2 z) as inclusive [first, last] runs. */
  runs(axis: 0 | 1 | 2): [number, number][] {
    const runs: [number, number][] = []
    this.counts[axis].forEach((count, slice) => {
      if (!count) return
      const last = runs[runs.length - 1]
      if (last && last[1] === slice - 1) last[1] = slice
      else runs.push([slice, slice])
    })
    return runs
  }

  destroy(): void {
    this.nv.removeEventListener('drawingChanged', this.listener)
  }

  /** From scratch: nothing to diff against, so count and set bits only. */
  private recount(img: ArrayLike<number>, nx: number, ny: number, nz: number) {
    this.reset(nx, ny, nz)
    const painted = this.painted
    const [ax, ay, az] = this.counts
    let i = 0
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (img[i] === 0) continue
          painted[i >> 3] |= 1 << (i & 7)
          ax[x]++
          ay[y]++
          az[z]++
        }
      }
    }
  }

  private reset(nx: number, ny: number, nz: number): void {
    this.counts = [
      new Uint32Array(nx),
      new Uint32Array(ny),
      new Uint32Array(nz),
    ]
    this.painted = new Uint8Array(Math.ceil((nx * ny * nz) / 8))
  }
}
