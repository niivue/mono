import { log } from '@/logger'
import type { NVImage } from '@/NVTypes'
import { decodeRLE } from './rle'

interface DrawUndoArgs {
  drawUndoBitmaps: Uint8Array[]
  currentDrawUndoBitmap: number
  drawBitmap: Uint8Array
}

export function drawUndo({
  drawUndoBitmaps,
  currentDrawUndoBitmap,
  drawBitmap,
}: DrawUndoArgs):
  | { drawBitmap: Uint8Array; currentDrawUndoBitmap: number }
  | undefined {
  const len = drawUndoBitmaps.length
  if (len < 1) {
    log.debug('undo bitmaps not loaded')
    return
  }
  // Clamp index into valid range
  if (currentDrawUndoBitmap >= len) {
    currentDrawUndoBitmap = len - 1
  }
  if (currentDrawUndoBitmap < 0) {
    currentDrawUndoBitmap = len - 1
  }
  if (drawUndoBitmaps[currentDrawUndoBitmap].length < 2) {
    log.debug('drawUndo is misbehaving')
    return
  }
  // Load from current index (the state saved before the most recent stroke)
  drawBitmap = decodeRLE(
    drawUndoBitmaps[currentDrawUndoBitmap],
    drawBitmap.length,
  )
  // Then decrement for the next undo call
  currentDrawUndoBitmap--
  if (currentDrawUndoBitmap < 0) {
    currentDrawUndoBitmap = len - 1
  }
  return { drawBitmap, currentDrawUndoBitmap }
}

/**
 * Install a bitmap as the drawing's contents, writing INTO the existing `img`
 * when the sizes match rather than replacing the array. Replacing it would
 * silently detach any view an extension installed with
 * `acquireSharedBuffer()` (the SharedArrayBuffer a worker previews into), so
 * the restored drawing would be the last thing that worker could see.
 */
export function setDrawingBitmap(
  drawingVol: NVImage,
  bitmap: Uint8Array,
): void {
  const img = drawingVol.img as Uint8Array | undefined
  if (img && img.length === bitmap.length && img !== bitmap) {
    img.set(bitmap)
  } else {
    drawingVol.img = bitmap
  }
}
