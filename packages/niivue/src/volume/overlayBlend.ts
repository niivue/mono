import { OVERLAY_ALPHA_BLEND, OVERLAY_COLOR_BLEND } from '@/NVConstants'

/**
 * Blend multiple overlay RGBA8 textures into one. Per voxel, accumulates the
 * premultiplied colour P, alpha sum S, max alpha M and union alpha
 * U = 1 - prod(1 - a); `alphaBlend` picks the output alpha A (M, min(1, S) or
 * U) and `colorBlend` the output colour (P / A, the weighted mean P / S, or
 * P / U). For colour OVER, P is composited in order (P = P(1 - a) + c a), so
 * later overlays cover earlier ones; the other modes are commutative. The
 * result is un-premultiplied so render/slice shaders work unchanged. Each
 * overlay's opacity is already baked into its alpha by the orient shader.
 * Mirrors blendOverlaysGPU in wgpu/orient.ts.
 */
export function blendOverlayData(
  overlays: Uint8Array[],
  dims: number[],
  alphaBlend: number = OVERLAY_ALPHA_BLEND.MAX,
  colorBlend: number = OVERLAY_COLOR_BLEND.ADDITIVE,
): Uint8Array {
  const nVoxels = dims[0] * dims[1] * dims[2]
  const isOrdered = colorBlend === OVERLAY_COLOR_BLEND.OVER
  const result = new Uint8Array(nVoxels * 4)
  for (let j = 0; j < nVoxels * 4; j += 4) {
    let r = 0
    let g = 0
    let b = 0
    let sum = 0
    let max = 0
    let union = 0
    for (const data of overlays) {
      const a = data[j + 3] / 255
      if (a <= 0) continue
      const keep = isOrdered ? 1 - a : 1
      r = r * keep + (data[j] / 255) * a
      g = g * keep + (data[j + 1] / 255) * a
      b = b * keep + (data[j + 2] / 255) * a
      sum += a
      max = Math.max(max, a)
      union += a - union * a
    }
    if (sum <= 0) continue
    const alpha =
      alphaBlend === OVERLAY_ALPHA_BLEND.ADDITIVE
        ? Math.min(sum, 1)
        : alphaBlend === OVERLAY_ALPHA_BLEND.OVER
          ? union
          : max
    const norm =
      colorBlend === OVERLAY_COLOR_BLEND.MEAN ? sum : isOrdered ? union : alpha
    result[j] = Math.min(Math.round((r / norm) * 255), 255)
    result[j + 1] = Math.min(Math.round((g / norm) * 255), 255)
    result[j + 2] = Math.min(Math.round((b / norm) * 255), 255)
    result[j + 3] = Math.round(alpha * 255)
  }
  return result
}
