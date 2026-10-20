import { log } from '@/logger'
import type { NVImage } from '@/NVTypes'
import * as NVVolume from '@/volume/NVVolume'
import { decodeRLE, encodeRLE } from './rle'

export interface AddUndoBitmapParams {
  drawBitmap: Uint8Array | null
  drawUndoBitmaps: Uint8Array[]
  currentDrawUndoBitmap: number
  maxDrawUndoBitmaps: number
  drawFillOverwrites: boolean
}

export interface AddUndoBitmapResult {
  drawBitmap: Uint8Array | null
  drawUndoBitmaps: Uint8Array[]
  currentDrawUndoBitmap: number
  needsRefresh: boolean
}

export interface ClearUndoBitmapsResult {
  drawUndoBitmaps: Uint8Array[]
  currentDrawUndoBitmap: number
}

export function clearAllUndoBitmaps(
  drawUndoBitmaps: Uint8Array[],
  maxDrawUndoBitmaps: number,
): ClearUndoBitmapsResult {
  const newDrawUndoBitmaps = [...drawUndoBitmaps]
  const currentDrawUndoBitmap = maxDrawUndoBitmaps

  if (!newDrawUndoBitmaps || newDrawUndoBitmaps.length < 1) {
    return { drawUndoBitmaps: newDrawUndoBitmaps, currentDrawUndoBitmap }
  }

  for (let i = newDrawUndoBitmaps.length - 1; i >= 0; i--) {
    newDrawUndoBitmaps[i] = new Uint8Array()
  }

  return { drawUndoBitmaps: newDrawUndoBitmaps, currentDrawUndoBitmap }
}

export function addUndoBitmap(
  params: AddUndoBitmapParams,
): AddUndoBitmapResult {
  const {
    drawBitmap,
    drawUndoBitmaps,
    currentDrawUndoBitmap: currentIndex,
    maxDrawUndoBitmaps,
    drawFillOverwrites,
  } = params

  if (!drawBitmap || drawBitmap.length < 1) {
    log.debug('addUndoBitmap error: No drawing open')
    return {
      drawBitmap,
      drawUndoBitmaps,
      currentDrawUndoBitmap: currentIndex,
      needsRefresh: false,
    }
  }

  const newDrawUndoBitmaps = [...drawUndoBitmaps]
  let newDrawBitmap = drawBitmap
  let needsRefresh = false

  if (!drawFillOverwrites && newDrawUndoBitmaps.length > 0) {
    const len = drawBitmap.length
    const bmp = decodeRLE(newDrawUndoBitmaps[currentIndex], len)
    newDrawBitmap = new Uint8Array(drawBitmap)
    for (let i = 0; i < len; i++) {
      if (bmp[i] > 0) {
        newDrawBitmap[i] = bmp[i]
      }
    }
    needsRefresh = true
  }

  let newCurrentIndex = currentIndex + 1
  if (newCurrentIndex >= maxDrawUndoBitmaps) {
    newCurrentIndex = 0
  }

  newDrawUndoBitmaps[newCurrentIndex] = encodeRLE(newDrawBitmap)

  return {
    drawBitmap: newDrawBitmap,
    drawUndoBitmaps: newDrawUndoBitmaps,
    currentDrawUndoBitmap: newCurrentIndex,
    needsRefresh,
  }
}

export function createDrawingVolume(backgroundVolume: NVImage): NVImage {
  const clonedHdr = JSON.parse(JSON.stringify(backgroundVolume.hdr))
  clonedHdr.datatypeCode = 2 // DT_UINT8
  clonedHdr.numBitsPerVoxel = 8
  clonedHdr.scl_slope = 1
  clonedHdr.scl_inter = 0
  clonedHdr.cal_min = 0
  clonedHdr.cal_max = 0
  clonedHdr.dims[0] = 3
  clonedHdr.dims[4] = 1
  clonedHdr.dims[5] = 1
  clonedHdr.dims[6] = 1
  const nVox3D = clonedHdr.dims[1] * clonedHdr.dims[2] * clonedHdr.dims[3]
  const img = new Uint8Array(nVox3D)
  return NVVolume.nii2volume(clonedHdr, img, 'drawing')
}

export function getDrawingBitmap(vol: NVImage): Uint8Array {
  if (!(vol.img instanceof Uint8Array)) {
    throw new Error('Drawing volume img is not a Uint8Array')
  }
  return vol.img
}

export function validateDrawingDimensions(
  drawingDims: number[],
  backgroundDims: number[],
): boolean {
  return (
    drawingDims[1] === backgroundDims[1] &&
    drawingDims[2] === backgroundDims[2] &&
    drawingDims[3] === backgroundDims[3]
  )
}
