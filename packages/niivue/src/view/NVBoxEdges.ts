import type { mat4 } from 'gl-matrix'
import type NVModel from '@/NVModel'
import type { FocusBox } from '@/NVTypes'

/**
 * Per edge: start xyz, end xyz, thickness, pad, rgba. The box-line renderers
 * (gl/boxLine.ts, wgpu/boxLine.ts) project these on the GPU per render tile,
 * so a frame packs each box once, not once per tile.
 */
export const FLOATS_PER_BOX_EDGE = 12

/** A 3D render tile the boxes are drawn on: its MVP and viewport rect
 * [x, y, w, h] in the backend's own pixel space. */
export type BoxTile = { mvp: mat4; rect: number[] }

// 12 edges of an axis-aligned box, as corner bit masks (bit 0 x, 1 y, 2 z).
const BOX_EDGES = [
  0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7,
]

/** World-mm edges of every box the model shows; null when there are none. */
export function packBoxEdges(
  md: Pick<NVModel, '_focusBox' | '_lodBoxes' | '_pickedBlockBox'>,
): Float32Array<ArrayBuffer> | null {
  const shown = [
    md._focusBox,
    ...(md._lodBoxes ?? []),
    md._pickedBlockBox,
  ].filter((b): b is FocusBox => b != null)
  if (shown.length === 0) return null
  const out = new Float32Array(shown.length * 12 * FLOATS_PER_BOX_EDGE)
  let o = 0
  for (const { min, max, color, thickness } of shown) {
    const t = Math.max(1, thickness)
    const alpha = color[3] ?? 1
    for (let e = 0; e < BOX_EDGES.length; e++) {
      const c = BOX_EDGES[e]
      out[o++] = c & 1 ? max[0] : min[0]
      out[o++] = c & 2 ? max[1] : min[1]
      out[o++] = c & 4 ? max[2] : min[2]
      if (e % 2 === 0) continue
      out[o] = t
      out[o + 2] = color[0]
      out[o + 3] = color[1]
      out[o + 4] = color[2]
      out[o + 5] = alpha
      o += 6
    }
  }
  return out
}

/**
 * A tile's scissor rect: its viewport `rect` rounded to whole pixels, so
 * neighbouring tiles split a shared edge, and kept inside `clip`. Null when
 * nothing is left.
 */
export function scissorRect(rect: number[], clip: number[]): number[] | null {
  const x0 = Math.max(Math.round(rect[0]), clip[0])
  const y0 = Math.max(Math.round(rect[1]), clip[1])
  const x1 = Math.min(Math.round(rect[0] + rect[2]), clip[0] + clip[2])
  const y1 = Math.min(Math.round(rect[1] + rect[3]), clip[1] + clip[3])
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null
}
