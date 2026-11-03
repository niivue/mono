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
 * Each outline on every 2D tile: the whole rectangle on a slice it lies in
 * (within `toleranceMM`), the segment where it crosses an oblique or
 * orthogonal slice, nothing on a slice it misses; clipped to the tile. A tile
 * without a plane equation gets the plain projection. The render tile is
 * skipped (see {@link buildPlaneOutline3DRenderData}).
 */
export function buildPlaneOutlineLines(
  outlines: readonly PlaneOutline[],
  screenSlices: readonly SliceTile[],
  buildLine: BuildLineFn,
  defaultColor: number[],
  toleranceMM = 0.5,
): LineData[] {
  const lines: LineData[] = []
  for (const tile of screenSlices) {
    const mvp = tile.mvpMatrix
    const ltwh = tile.leftTopWidthHeight
    if (tile.axCorSag === SLICE_TYPE.RENDER || !mvp || !ltwh) continue
    for (const o of outlines) {
      const width = o.width ?? 2
      const color = o.color ?? defaultColor
      for (const [a, b] of outlineOnSlice(o.cornersMM, tile, toleranceMM)) {
        const seg = clipToRect(
          projectMMToCanvas(a, mvp, ltwh),
          projectMMToCanvas(b, mvp, ltwh),
          ltwh,
        )
        if (seg) lines.push(buildLine(...seg, width, color))
      }
    }
  }
  return lines
}

/** The outline's edges (mm) that belong on this tile's slice. */
function outlineOnSlice(
  c: readonly Vec3[],
  tile: SliceTile,
  tol: number,
): Array<[Vec3, Vec3]> {
  const edges = c.map((p, i): [Vec3, Vec3] => [p, c[(i + 1) % c.length]])
  const n = tile.planeNormal
  const q = tile.planePoint
  if (!n || !q) return edges
  const d = c.map(
    (p) => (p[0] - q[0]) * n[0] + (p[1] - q[1]) * n[1] + (p[2] - q[2]) * n[2],
  )
  if (d.every((v) => Math.abs(v) <= tol)) return edges
  // Where each edge crosses the plane; a convex outline crosses it twice.
  const hits: Vec3[] = []
  edges.forEach(([p0, p1], i) => {
    const d0 = d[i]
    const d1 = d[(i + 1) % d.length]
    if (d0 === d1 || (d0 > 0 && d1 > 0) || (d0 < 0 && d1 < 0)) return
    const t = d0 / (d0 - d1)
    hits.push([0, 1, 2].map((k) => p0[k] + (p1[k] - p0[k]) * t) as Vec3)
  })
  return hits.length >= 2 ? [[hits[0], hits[hits.length - 1]]] : []
}

/** Liang-Barsky clip of a canvas segment to a tile's [left, top, w, h]. */
function clipToRect(
  a: number[],
  b: number[],
  [left, top, w, h]: number[],
): [number, number, number, number] | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  const edges: Array<[number, number]> = [
    [-dx, a[0] - left],
    [dx, left + w - a[0]],
    [-dy, a[1] - top],
    [dy, top + h - a[1]],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return null
  }
  return [a[0] + t0 * dx, a[1] + t0 * dy, a[0] + t1 * dx, a[1] + t1 * dy]
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
    const [r, g, b, a = 1] = o.color ?? defaultColor
    const sides = [0, 1, 2, 3].map((i) => dist(c[i], c[(i + 1) % 4]))
    // Capped so a long thin rectangle keeps an open middle.
    const inset = Math.min(
      Math.max(...sides) * FRAME_FRACTION,
      Math.min(...sides) / 4,
    )
    // Each corner moved inward along both its edges' directions, scaled by
    // 1/sin(angle) so every edge's band is `inset` wide.
    const inner = c.map((p, i) => {
      const e1 = unit(p, c[(i + 1) % 4])
      const e2 = unit(p, c[(i + 3) % 4])
      const sin = Math.hypot(
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      )
      const s = sin > 1e-6 ? inset / sin : 0
      return [0, 1, 2].map((k) => p[k] + (e1[k] + e2[k]) * s) as Vec3
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

function unit(p: readonly number[], q: readonly number[]): Vec3 {
  const len = dist(p, q) || 1
  return [0, 1, 2].map((k) => (q[k] - p[k]) / len) as Vec3
}

function dist(p: readonly number[], q: readonly number[]): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}
