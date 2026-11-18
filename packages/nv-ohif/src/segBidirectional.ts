import type NiiVue from '@niivue/niivue'
import { rasToLps } from './commands'
import { activeSegmentValue } from './segEdit'
import { annotationFromRow } from './srImport'
import { acquisitionSliceType } from './standardCommands'

type Vec3 = [number, number, number]

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/**
 * cornerstone's getSegmentLargestBidirectional on a NiiVue drawing: on each
 * slice across RAS voxel axis `axis`, the segment's boundary voxel centres
 * (mm); the major axis is the farthest pair, the minor the widest chord
 * perpendicular to it (boundary points binned along the major by one voxel).
 * Returns [major start, major end, minor start, minor end] (RAS mm) of the
 * slice with the longest major, or undefined without voxels.
 * ponytail: O(n^2) farthest pair per slice; a convex hull first if a large
 * segment makes it slow.
 */
export function largestBidirectional(
  img: ArrayLike<number>,
  dims: readonly [number, number, number],
  vox2mm: (v: Vec3) => Vec3,
  value: number,
  axis: number,
): [Vec3, Vec3, Vec3, Vec3] | undefined {
  const [nx, ny, nz] = dims
  const n = [nx, ny, nz]
  // In-plane voxel axes.
  const [ua, va] = [0, 1, 2].filter((a) => a !== axis) as [number, number]
  const o = vox2mm([0, 0, 0])
  const unit = (a: number) => {
    const v: Vec3 = [0, 0, 0]
    v[a] = 1
    return sub(vox2mm(v), o)
  }
  const normal = norm(unit(axis))
  const bin = Math.min(Math.hypot(...unit(ua)), Math.hypot(...unit(va)))
  const at = (v: Vec3) => img[v[0] + nx * (v[1] + ny * v[2])]
  let best: [Vec3, Vec3, Vec3, Vec3] | undefined
  let bestLength = 0
  for (let k = 0; k < (n[axis] as number); k++) {
    const pts: Vec3[] = []
    for (let j = 0; j < (n[va] as number); j++)
      for (let i = 0; i < (n[ua] as number); i++) {
        const v: Vec3 = [0, 0, 0]
        v[axis] = k
        v[ua] = i
        v[va] = j
        if (at(v) !== value) continue
        const edge = [
          [ua, -1],
          [ua, 1],
          [va, -1],
          [va, 1],
        ].some(([a, d]) => {
          const w: Vec3 = [...v]
          const c = (w[a as number] as number) + (d as number)
          w[a as number] = c
          return c < 0 || c >= (n[a as number] as number) || at(w) !== value
        })
        if (edge) pts.push(vox2mm(v))
      }
    let major: [Vec3, Vec3] | undefined
    let length = bestLength
    for (let p = 0; p < pts.length; p++)
      for (let q = p + 1; q < pts.length; q++) {
        const d = Math.hypot(...sub(pts[p] as Vec3, pts[q] as Vec3))
        if (d > length) {
          length = d
          major = [pts[p] as Vec3, pts[q] as Vec3]
        }
      }
    if (!major) continue
    const [A, B] = major
    const along = norm(sub(B, A))
    const across = norm(cross(normal, along))
    const bins = new Map<number, [Vec3, number, Vec3, number]>()
    for (const p of pts) {
      const d = sub(p, A)
      const t = Math.round(dot(d, along) / bin)
      const s = dot(d, across)
      const b = bins.get(t)
      if (!b) bins.set(t, [p, s, p, s])
      else if (s < b[1]) bins.set(t, [p, s, b[2], b[3]])
      else if (s > b[3]) bins.set(t, [b[0], b[1], p, s])
    }
    let minor: [Vec3, Vec3] = [A, A]
    let width = -1
    for (const [lo, sLo, hi, sHi] of bins.values())
      if (sHi - sLo > width) {
        width = sHi - sLo
        minor = [lo, hi]
      }
    bestLength = length
    best = [A, B, minor[0], minor[1]]
  }
  return best
}

// RAS voxel axis normal to each 2D view (axial z, coronal y, sagittal x),
// and the world (RAS mm) axis normal to it.
const NORMAL_AXIS = [2, 1, 0]
const WORLD_DEPTH = [2, 1, 0]

/**
 * OHIF's runSegmentBidirectional on a NiiVue pane: the active segment's
 * largest bidirectional on the acquisition plane, added as a Bidirectional
 * measurement and shown. False when the segment has no voxels.
 * ponytail: the panel's segment statistics do not list it (cornerstone's do).
 */
export function addSegmentBidirectional(nv: NiiVue): boolean {
  const img = nv.drawingVolume?.img
  const d = nv.volumes[0]?.dimsRAS
  if (!img || !d) return false
  const sliceType = acquisitionSliceType(nv) ?? nv.sliceType
  const ends = largestBidirectional(
    img,
    [d[1], d[2], d[3]] as Vec3,
    (v) => nv.vox2mm(v) ?? [0, 0, 0],
    activeSegmentValue(nv),
    NORMAL_AXIS[sliceType] ?? 2,
  )
  const row = (points: Vec3[]) =>
    annotationFromRow(nv, {
      uid: crypto.randomUUID(),
      toolName: 'Bidirectional',
      points: points.map((p) => rasToLps(p)),
      metadata: { sliceType },
    })
  // A tilted grid's voxel slice is not a world plane, which NiiVue's
  // annotations live on: project the ends onto the nearest one (their mean
  // depth). ponytail: the tilted axis then reads up to 1 - cos(tilt) short.
  const depth = (WORLD_DEPTH[sliceType] ?? 2) as 0 | 1 | 2
  const mean = ends ? ends.reduce((a, p) => a + p[depth], 0) / ends.length : 0
  const flat = (p: Vec3): Vec3 => {
    const q: Vec3 = [p[0], p[1], p[2]]
    q[depth] = mean
    return q
  }
  const annotation = ends && (row(ends) ?? row(ends.map(flat)))
  if (!ends || !annotation) return false
  nv.addAnnotation(annotation)
  nv.setCrosshairPos(ends[0])
  return true
}
