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
 * cornerstone's getSegmentLargestBidirectional on a NiiVue drawing. The
 * segment's edge voxels (an in-plane 4-neighbour outside it; the voxel axis
 * nearest `depth` is through-plane) are grouped into slabs
 * one voxel thick across world (RAS mm) axis `depth`, the normal of the view's
 * plane, and projected onto their slab's plane: on an oblique grid a voxel
 * slice is not a world plane, which NiiVue's annotations lie on. In each slab
 * the major axis is the farthest pair; the minor is the widest chord
 * perpendicular to it (points binned along the major by one voxel). Returns
 * [major start, major end, minor start, minor end] (RAS mm) of the slab with
 * the longest major, or undefined without voxels.
 * ponytail: O(n^2) farthest pair per slab; a convex hull first if a large
 * segment makes it slow.
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
  })
  // Slab thickness: the voxel step most aligned with the view's normal.
  const steps = cols.map((c) => Math.abs(c[depth] ?? 0))
  const dz = Math.max(...steps)
  // Through-plane neighbours stay out: a 6-neighbour surface puts every voxel
  // of a segment's end slices into the O(n^2) search (100x slower at r=100).
  const through = steps.indexOf(dz)
  // Bin along the major by the in-plane step: a thin slice step would split
  // every chord into single points.
  const bin = Math.min(
    ...cols.filter((_, a) => a !== through).map((c) => Math.hypot(...c)),
  )
  const normal: Vec3 = [0, 0, 0]
  normal[depth] = 1
  const at = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz
      ? undefined
      : img[x + nx * (y + ny * z)]
  const slabs = new Map<number, Vec3[]>()
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (at(x, y, z) !== value) continue
        const edge =
          (through !== 0 &&
            (at(x - 1, y, z) !== value || at(x + 1, y, z) !== value)) ||
          (through !== 1 &&
            (at(x, y - 1, z) !== value || at(x, y + 1, z) !== value)) ||
          (through !== 2 &&
            (at(x, y, z - 1) !== value || at(x, y, z + 1) !== value))
        if (!edge) continue
        const p = vox2mm([x, y, z])
        // Slabs centred on voxel planes through the origin, not world zero.
        const k = Math.round((p[depth] - o[depth]) / dz)
        p[depth] = o[depth] + k * dz
        const list = slabs.get(k)
        if (list) list.push(p)
        else slabs.set(k, [p])
      }
  let best: [Vec3, Vec3, Vec3, Vec3] | undefined
  let bestLength = 0
  for (const pts of slabs.values()) {
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
