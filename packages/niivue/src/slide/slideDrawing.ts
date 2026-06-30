import {
  drawLine,
  drawPenFilled,
  drawPoint,
  PEN_SLICE_TYPE,
} from '@/drawing/penTool'
import { encodeRLE } from '@/drawing/rle'
import { drawUndo } from '@/drawing/undo'

// A drawing surface in *slide* space: a 2D label raster covering the whole slide
// extent. It is intentionally a thin holder over the existing voxel-drawing
// primitives — by presenting the raster as a single axial slice of a
// `[W, H, 1]` volume, drawPoint/drawLine/drawPenFilled and the RLE undo
// stack (encodeRLE snapshot + drawUndo) all apply unchanged, so every drawing
// function stays compatible. Bucket fill is a seeded flood over the raster. (Snapshots are taken directly via the RLE codec
// rather than drawingManager.addUndoBitmap, to avoid coupling slide drawing to
// the volume NVImage; the codec and drawUndo are the same as the volume path.)
// The annotation lives in slide pixels (not the base volume), so it stays glued
// to the slide as the plane pans / zooms / changes LOD.

const MAX_UNDO = 10

export class SlideDrawing {
  readonly width: number
  readonly height: number
  /** Label-index raster (0 = transparent), row-major width*height. */
  img: Uint8Array
  /** Bumped whenever `img` changes, so the renderer re-uploads its texture. */
  version = 0
  private _undoBitmaps: Uint8Array[] = []
  private _undoIndex = -1

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width))
    this.height = Math.max(1, Math.round(height))
    this.img = new Uint8Array(this.width * this.height)
  }

  // NIfTI-style dims the pen tools expect: [ndim, dimX, dimY, dimZ].
  private dims(): number[] {
    return [3, this.width, this.height, 1]
  }

  /** Snapshot the raster before a stroke into the RLE undo ring buffer. */
  beginStroke(): void {
    let idx = this._undoIndex + 1
    if (idx >= MAX_UNDO) idx = 0
    this._undoBitmaps[idx] = encodeRLE(this.img)
    this._undoIndex = idx
  }

  /** Paint a brush dot at slide-raster pixel (x, y). */
  point(
    x: number,
    y: number,
    penValue: number,
    penSize: number,
    overwrite: boolean,
  ): void {
    drawPoint({
      x,
      y,
      z: 0,
      penValue,
      drawBitmap: this.img,
      dims: this.dims(),
      penSize,
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
      penOverwrites: overwrite,
    })
    this.version++
  }

  /** Paint a line between two slide-raster pixels (continuous strokes). */
  line(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    penValue: number,
    penSize: number,
    overwrite: boolean,
  ): void {
    drawLine({
      ptA: [ax, ay, 0],
      ptB: [bx, by, 0],
      penValue,
      drawBitmap: this.img,
      dims: this.dims(),
      penSize,
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
      penOverwrites: overwrite,
    })
    this.version++
  }

  /**
   * Bucket fill: flood the connected region of pixels sharing the seed's value
   * (4-connected) with `penValue`. Drawn strokes of a different value bound the
   * fill. With `overwrite` false, only fills into empty (0) regions.
   */
  bucketFill(x: number, y: number, penValue: number, overwrite: boolean): void {
    const w = this.width
    const h = this.height
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= w || py >= h) return
    const img = this.img
    const seed = py * w + px
    const target = img[seed]
    if (target === penValue) return
    if (!overwrite && penValue !== 0 && target !== 0) return
    const stack = [seed]
    img[seed] = penValue
    while (stack.length > 0) {
      const idx = stack.pop() as number
      const ix = idx % w
      if (ix > 0 && img[idx - 1] === target) {
        img[idx - 1] = penValue
        stack.push(idx - 1)
      }
      if (ix < w - 1 && img[idx + 1] === target) {
        img[idx + 1] = penValue
        stack.push(idx + 1)
      }
      if (idx - w >= 0 && img[idx - w] === target) {
        img[idx - w] = penValue
        stack.push(idx - w)
      }
      if (idx + w < img.length && img[idx + w] === target) {
        img[idx + w] = penValue
        stack.push(idx + w)
      }
    }
    this.version++
  }

  /**
   * Filled pen: close the freehand outline `points` (slide-raster pixels) and
   * fill the enclosed region with `penValue` (reuses drawPenFilled). Returns
   * false if the outline is too short to enclose an area.
   */
  fillPen(
    points: ReadonlyArray<readonly [number, number]>,
    penValue: number,
    overwrite: boolean,
  ): boolean {
    if (points.length < 2) return false
    const r = drawPenFilled({
      penFillPts: points.map(([x, y]) => [x, y, 0]),
      penAxCorSag: PEN_SLICE_TYPE.AXIAL,
      drawBitmap: this.img,
      dims: this.dims(),
      penValue,
      fillOverwrites: overwrite,
      currentUndoBitmap:
        this._undoIndex >= 0 ? this._undoBitmaps[this._undoIndex] : null,
    })
    if (!r.success) return false
    this.img = r.drawBitmap
    this.version++
    return true
  }

  /** Undo the most recent stroke. Returns false when the stack is empty. */
  undo(): boolean {
    const r = drawUndo({
      drawUndoBitmaps: this._undoBitmaps,
      currentDrawUndoBitmap: this._undoIndex,
      drawBitmap: this.img,
    })
    if (!r) return false
    this.img = r.drawBitmap
    this._undoIndex = r.currentDrawUndoBitmap
    this.version++
    return true
  }

  /** Clear all annotation pixels (keeps the undo history). */
  clear(): void {
    this.img.fill(0)
    this.version++
  }
}
