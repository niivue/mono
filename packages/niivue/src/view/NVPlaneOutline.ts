import { SLICE_TYPE } from '@/NVConstants'
import type { PlaneOutline } from '@/NVTypes'
import type { Annotation3DRenderData } from './NVAnnotation'
import type { BuildLineFn, LineData } from './NVLine'
import type { SliceTile } from './NVSliceLayout'
import { projectMMToCanvas } from './sliceUtils'

type Vec3 = [number, number, number]

// The 3D frame's width, as a fraction of the rectangle's longer side.
const FRAME_FRACTION = 0.01

/**
 * Each outline's four edges projected onto every 2D tile: a rectangle on a
 * parallel slice, a line on an orthogonal one. The render tile is skipped
 * (see {@link buildPlaneOutline3DRenderData}).
 */
export function buildPlaneOutlineLines(
  outlines: readonly PlaneOutline[],
  screenSlices: readonly SliceTile[],
  buildLine: BuildLineFn,
  defaultColor: number[],
): LineData[] {
  const lines: LineData[] = []
  for (const tile of screenSlices) {
    const mvp = tile.mvpMatrix
    const ltwh = tile.leftTopWidthHeight
    if (tile.axCorSag === SLICE_TYPE.RENDER || !mvp || !ltwh) continue
    for (const o of outlines) {
      const corners = o.cornersMM.map((c) => projectMMToCanvas(c, mvp, ltwh))
      for (let i = 0; i < corners.length; i++) {
        const [x0, y0] = corners[i]
        const [x1, y1] = corners[(i + 1) % corners.length]
        lines.push(
          buildLine(x0, y0, x1, y1, o.width ?? 2, o.color ?? defaultColor),
        )
      }
    }
  }
  return lines
}

/**
 * Each outline as a thin frame of triangles in world mm, for the 3D render's
 * polygon pass (solid where visible, faint where the volume hides it).
 */
export function buildPlaneOutline3DRenderData(
  outlines: readonly PlaneOutline[],
  defaultColor: number[],
): Annotation3DRenderData | null {
  const verts: number[] = []
  const indices: number[] = []
  for (const o of outlines) {
    const c = o.cornersMM
    const [r, g, b, a] = o.color ?? defaultColor
    const centre = [0, 1, 2].map(
      (k) => (c[0][k] + c[1][k] + c[2][k] + c[3][k]) / 4,
    ) as Vec3
    const side = Math.max(dist(c[0], c[1]), dist(c[1], c[2]))
    const inset = side * FRAME_FRACTION
    // Each corner pulled toward the centre by the frame width (in proportion
    // to its distance, so the frame stays even on a rectangle).
    const inner = c.map((p) => {
      const d = dist(p, centre)
      const t = d > 0 ? inset / d : 0
      return [0, 1, 2].map((k) => p[k] + (centre[k] - p[k]) * t) as Vec3
    })
    const base = verts.length / 7
    for (const p of [...c, ...inner]) verts.push(p[0], p[1], p[2], r, g, b, a)
    // Outer corner i, outer i+1, inner i+1, inner i: one quad per edge.
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      indices.push(base + i, base + j, base + 4 + j)
      indices.push(base + i, base + 4 + j, base + 4 + i)
    }
  }
  if (indices.length === 0) return null
  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(indices),
  }
}

/** Two render-data sets as one, for a single polygon pass. */
export function mergeRenderData(
  a: Annotation3DRenderData | null,
  b: Annotation3DRenderData | null,
): Annotation3DRenderData | null {
  if (!a || !b) return a ?? b
  const offset = a.vertices.length / 7
  const indices = new Uint32Array(a.indices.length + b.indices.length)
  indices.set(a.indices)
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i] + offset
  }
  const vertices = new Float32Array(a.vertices.length + b.vertices.length)
  vertices.set(a.vertices)
  vertices.set(b.vertices, a.vertices.length)
  return { vertices, indices }
}

function dist(p: readonly number[], q: readonly number[]): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}
