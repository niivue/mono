import { makeLabelLut } from '@/cmap/NVCmaps'
import type { ColorMap, LUT } from '@/NVTypes'

/**
 * Convert a drawing bitmap (label indices) to an RGBA Uint8Array using a label colormap LUT.
 * Index 0 is always transparent.
 */
export function drawingBitmapToRGBA(
  drawBitmap: Uint8Array,
  lut: Uint8ClampedArray,
  lutMin: number,
  opacity: number,
): Uint8Array {
  const len = drawBitmap.length
  const rgba = new Uint8Array(len * 4)
  const alphaScale = Math.min(Math.max(opacity, 0), 1)
  for (let i = 0; i < len; i++) {
    const label = drawBitmap[i]
    if (label === 0) continue // transparent — rgba already zeroed
    const lutIdx = (label - lutMin) * 4
    if (lutIdx < 0 || lutIdx + 3 >= lut.length) continue
    const o = i * 4
    rgba[o] = lut[lutIdx]
    rgba[o + 1] = lut[lutIdx + 1]
    rgba[o + 2] = lut[lutIdx + 2]
    rgba[o + 3] = Math.round(lut[lutIdx + 3] * alphaScale)
  }
  return rgba
}

/**
 * Build a cached label LUT from a drawing colormap JSON definition.
 */
export function buildDrawingLut(cm: ColorMap): LUT {
  return makeLabelLut(cm)
}
