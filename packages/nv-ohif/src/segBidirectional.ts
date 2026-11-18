import type NiiVue from '@niivue/niivue'
import { rasToLps } from './commands'
import { activeSegmentValue } from './segEdit'
import { annotationFromRow } from './srImport'
import { acquisitionSliceType } from './standardCommands'

type Vec3 = [number, number, number]
type Axis = 0 | 1 | 2
const AXES = [0, 1, 2] as const

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
 * cornerstone's getSegmentLargestBidirectional on a NiiVue drawing. NiiVue's
 * annotations lie on world (RAS mm) planes across axis `depth`, the normal of
 * the view's plane, and on an oblique grid a voxel slice is not one: so the
 * segment is sampled on world planes one voxel apart (a grid at the finest
 * voxel spacing, aligned to voxel 0, each point testing its nearest voxel), and
 * each plane's boundary samples (a 4-neighbour outside) are its contour, every
 * point inside the segment. In each plane the major axis is the farthest pair;
 * the minor is the widest chord perpendicular to it (points binned along the
 * major by one voxel). Returns [major start, major end, minor start, minor
 * end] (RAS mm) of the plane with the longest major, or undefined without
 * voxels. On an axis-aligned grid the samples are the voxel centres.
 * ponytail: O(n^2) farthest pair over a plane's contour; a convex hull first
 * if a large segment makes it slow.
 */
export function largestBidirectional(
  img: ArrayLike<number>,
  dims: readonly [number, number, number],
  vox2mm: (v: Vec3) => Vec3,
  value: number,
  depth: 0 | 1 | 2,
): [Vec3, Vec3, Vec3, Vec3] | undefined {
  const [nx, ny, nz] = dims
  const o = vox2mm([0, 0, 0])
  const cols = [0, 1, 2].map((a) => {
    const v: Vec3 = [0, 0, 0]
    v[a] = 1
    return sub(vox2mm(v), o)
  }) as [Vec3, Vec3, Vec3]
  // Plane spacing: the voxel step most aligned with the view's normal.
  const steps = cols.map((c) => Math.abs(c[depth]))
  const dz = Math.max(...steps)
  // Grid and chord bins at the in-plane step: a thin slice step would only
  // oversample the plane.
  const through = steps.indexOf(dz)
  const bin = Math.min(
    ...cols.filter((_, a) => a !== through).map((c) => Math.hypot(...c)),
  )
  const [ia, ib] = AXES.filter((a) => a !== depth) as [Axis, Axis]
  const normal: Vec3 = [0, 0, 0]
  normal[depth] = 1
  // mm -> voxel: the inverse of [cols] (vox2mm is affine).
  const [c0, c1, c2] = cols
  const r0 = cross(c1, c2)
  const r1 = cross(c2, c0)
  const r2 = cross(c0, c1)
  const det = dot(c0, r0)
  if (!det) return undefined
  const label = (p: Vec3) => {
    const d = sub(p, o)
    const x = Math.round(dot(d, r0) / det)
    const y = Math.round(dot(d, r1) / det)
    const z = Math.round(dot(d, r2) / det)
    return x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz
      ? undefined
      : img[x + nx * (y + ny * z)]
  }
  // The segment's world bounds, from its voxel centres.
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (img[x + nx * (y + ny * z)] !== value) continue
        for (const a of AXES) {
          const v = o[a] + c0[a] * x + c1[a] * y + c2[a] * z
          if (v < lo[a]) lo[a] = v
          if (v > hi[a]) hi[a] = v
        }
      }
  if (lo[0] > hi[0]) return undefined
  // Grid steps from voxel 0, half a voxel beyond the centres on every side.
  const range = (a: Axis, step: number) => [
    Math.floor((lo[a] - o[a]) / step - 0.5),
    Math.ceil((hi[a] - o[a]) / step + 0.5),
  ]
  const [k0, k1] = range(depth, dz) as [number, number]
  const [i0, i1] = range(ia, bin) as [number, number]
  const [j0, j1] = range(ib, bin) as [number, number]
  const ni = i1 - i0 + 1
  const nj = j1 - j0 + 1
  const slabs: Vec3[][] = []
  const inside = new Uint8Array(ni * nj)
  for (let k = k0; k <= k1; k++) {
    const p: Vec3 = [0, 0, 0]
    p[depth] = o[depth] + k * dz
    for (let j = 0; j < nj; j++)
      for (let i = 0; i < ni; i++) {
        p[ia] = o[ia] + (i0 + i) * bin
        p[ib] = o[ib] + (j0 + j) * bin
        inside[i + ni * j] = label(p) === value ? 1 : 0
      }
    const pts: Vec3[] = []
    const isIn = (i: number, j: number) =>
      i >= 0 && j >= 0 && i < ni && j < nj && inside[i + ni * j] === 1
    for (let j = 0; j < nj; j++)
      for (let i = 0; i < ni; i++) {
        if (!isIn(i, j)) continue
        if (
          isIn(i - 1, j) &&
          isIn(i + 1, j) &&
          isIn(i, j - 1) &&
          isIn(i, j + 1)
        )
          continue
        const q: Vec3 = [0, 0, 0]
        q[depth] = o[depth] + k * dz
        q[ia] = o[ia] + (i0 + i) * bin
        q[ib] = o[ib] + (j0 + j) * bin
        pts.push(q)
      }
    if (pts.length > 0) slabs.push(pts)
  }
  let best: [Vec3, Vec3, Vec3, Vec3] | undefined
  let bestLength = 0
  for (const pts of slabs) {
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

// World (RAS mm) axis normal to each 2D view (axial z, coronal y, sagittal x).
const WORLD_DEPTH = [2, 1, 0] as const

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
    WORLD_DEPTH[sliceType] ?? 2,
  )
  const annotation =
    ends &&
    annotationFromRow(nv, {
      uid: crypto.randomUUID(),
      toolName: 'Bidirectional',
      points: ends.map((p) => rasToLps(p)),
      metadata: { sliceType },
    })
  if (!ends || !annotation) return false
  nv.addAnnotation(annotation)
  nv.setCrosshairPos(ends[0])
  return true
}
