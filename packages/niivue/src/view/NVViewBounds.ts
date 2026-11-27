import { getCanvasViewport } from '@/control/canvasRegistry'
import * as NVConstants from '@/NVConstants'
import type { NVBounds, ViewHitTest } from '@/NVTypes'
import type { SliceTile } from '@/view/NVSliceLayout'

/** A view's pixel rect on its canvas. */
export type BoundsPixels = {
  x: number
  y: number
  width: number
  height: number
  /** False when the view covers the whole canvas. */
  isSub: boolean
  /** True when the rect lies entirely outside the canvas. */
  isOffscreen: boolean
}

/** The pixel rect of normalized `bounds` after the canvas viewport's zoom and pan. */
export function computeBoundsPixels(
  canvas: HTMLCanvasElement,
  bounds: NVBounds | undefined,
): BoundsPixels {
  const cw = canvas.width
  const ch = canvas.height
  const vp = getCanvasViewport(canvas)
  const isIdentity = vp.pan[0] === 0 && vp.pan[1] === 0 && vp.zoom === 1
  if (
    isIdentity &&
    (!bounds ||
      (bounds[0][0] === 0 &&
        bounds[0][1] === 0 &&
        bounds[1][0] === 1 &&
        bounds[1][1] === 1))
  ) {
    return {
      x: 0,
      y: 0,
      width: cw,
      height: ch,
      isSub: false,
      isOffscreen: false,
    }
  }
  const worldX1 = bounds ? bounds[0][0] : 0
  const worldY1 = bounds ? bounds[0][1] : 0
  const worldX2 = bounds ? bounds[1][0] : 1
  const worldY2 = bounds ? bounds[1][1] : 1
  // Apply viewport: world -> screen-normalized (zoom around centre, then translate by pan)
  const z = vp.zoom
  const px = vp.pan[0]
  const py = vp.pan[1]
  const sx1 = (worldX1 - 0.5) * z + 0.5 + px
  const sx2 = (worldX2 - 0.5) * z + 0.5 + px
  const sy1 = (worldY1 - 0.5) * z + 0.5 + py
  const sy2 = (worldY2 - 0.5) * z + 0.5 + py
  // Round pixel edges, then derive size by subtraction to prevent
  // offset + size > canvas (which breaks copyTextureToTexture on odd dimensions)
  const left = Math.round(sx1 * cw)
  const right = Math.round(sx2 * cw)
  const top = Math.round((1 - sy2) * ch)
  const bottom = Math.round((1 - sy1) * ch)
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    isSub: true,
    isOffscreen: right <= 0 || left >= cw || bottom <= 0 || top >= ch,
  }
}

/** The tile under canvas pixel (x, y), with the point normalized to the tile. */
export function hitTestTiles(
  screenSlices: SliceTile[],
  x: number,
  y: number,
): ViewHitTest | null {
  for (let idx = 0; idx < screenSlices.length; idx++) {
    const tile = screenSlices[idx]
    const ltwh = tile.leftTopWidthHeight as number[]
    const left = ltwh[0]
    const top = ltwh[1]
    const width = ltwh[2]
    const height = ltwh[3]
    if (x >= left && x < left + width && y >= top && y < top + height) {
      return {
        tileIndex: idx,
        sliceType: tile.axCorSag,
        isRender: tile.axCorSag === NVConstants.SLICE_TYPE.RENDER,
        normalizedX: (x - left) / width,
        normalizedY: (y - top) / height,
      }
    }
  }
  return null
}
