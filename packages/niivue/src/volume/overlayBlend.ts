import { OVERLAY_ALPHA_BLEND, OVERLAY_COLOR_BLEND } from '@/NVConstants'

/**
 * Blend multiple overlay RGBA8 textures into one. Per voxel, accumulates the
 * premultiplied colour sum P, alpha sum S, max alpha M and union alpha
 * U = 1 - prod(1 - a); `alphaBlend` picks the output alpha A (M, min(1, S) or
 * U) and `colorBlend` the output colour (P / A, or the weighted mean P / S).
 * All are commutative, so overlay order does not matter. The result is
 * un-premultiplied so render/slice shaders work unchanged. Each overlay's
 * opacity is already baked into its alpha by the orient shader.
 * Mirrors blendOverlaysGPU in wgpu/orient.ts.
 */
export function blendOverlayData(
  overlays: Uint8Array[],
  dims: number[],
  alphaBlend: number = OVERLAY_ALPHA_BLEND.MAX,
  colorBlend: number = OVERLAY_COLOR_BLEND.ADDITIVE,
): Uint8Array {
  const nVoxels = dims[0] * dims[1] * dims[2]
  // P.rgb, S, then U (OVER) or M (otherwise; ignored by ADDITIVE)
  const accum = new Float32Array(nVoxels * 5)
  for (const data of overlays) {
    for (let i = 0; i < nVoxels; i++) {
      const a = data[i * 4 + 3] / 255
      if (a <= 0) continue
      const j = i * 4
      const k = i * 5
      accum[k] += (data[j] / 255) * a
      accum[k + 1] += (data[j + 1] / 255) * a
      accum[k + 2] += (data[j + 2] / 255) * a
      accum[k + 3] += a
      accum[k + 4] =
        alphaBlend === OVERLAY_ALPHA_BLEND.OVER
          ? accum[k + 4] + a - accum[k + 4] * a
          : Math.max(accum[k + 4], a)
    }
  }
  const result = new Uint8Array(nVoxels * 4)
  for (let i = 0; i < nVoxels; i++) {
    const k = i * 5
    const sum = accum[k + 3]
    if (sum <= 0) continue
    const alpha =
      alphaBlend === OVERLAY_ALPHA_BLEND.ADDITIVE
        ? Math.min(sum, 1)
        : accum[k + 4]
    const norm = colorBlend === OVERLAY_COLOR_BLEND.MEAN ? sum : alpha
    const j = i * 4
    result[j] = Math.min(Math.round((accum[k] / norm) * 255), 255)
    result[j + 1] = Math.min(Math.round((accum[k + 1] / norm) * 255), 255)
    result[j + 2] = Math.min(Math.round((accum[k + 2] / norm) * 255), 255)
    result[j + 3] = Math.round(alpha * 255)
  }
  return result
}
