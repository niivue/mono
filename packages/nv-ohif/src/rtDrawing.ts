import type NiiVue from '@niivue/niivue'
import type { OhifDisplaySet } from './ohif-types'
import { lpsToVoxelOf } from './quantify'
import {
  type PanelSegment,
  panelColormap,
  SEG_FILL_OPACITY,
  SEG_RIM_OPACITY,
  type SegmentStats,
} from './segPanel'

// A DICOM RTSTRUCT hung in a NiiVue pane shows as a NiiVue drawing over the CT
// it references: each ROI's closed planar contours are filled onto the base
// volume's voxel grid, one label per ROI. A drawing holds one label per voxel,
// so where ROIs overlap the smaller one is shown (see rasterizeStructureSet).

type Vox2mm = (vox: [number, number, number]) => number[] | null

/**
 * Style the installed drawing via `apply`. The returned restore puts the prior
 * colormap and opacities back; it runs itself when another drawing replaces this
 * one, but only for fields still holding the style last applied here (by
 * `apply` or a `restyle` that changed them); any other value is the user's.
 */
export function styleDrawing(
  nv: Pick<
    NiiVue,
    | 'drawingVolume'
    | 'drawColormap'
    | 'drawOpacity'
    | 'drawRimOpacity'
    | 'drawRimWidth'
    | 'addEventListener'
    | 'removeEventListener'
  >,
  apply: () => void,
): { restore: () => void; restyle: Restyle } {
  const installed = nv.drawingVolume
  const snap = () => ({
    drawColormap: nv.drawColormap,
    drawOpacity: nv.drawOpacity,
    drawRimOpacity: nv.drawRimOpacity,
    drawRimWidth: nv.drawRimWidth,
  })
  const prior = snap()
  apply()
  const applied = snap()
  const restyle: Restyle = (write) => {
    const before = snap()
    write()
    const after = snap()
    // Claim only what the write changed: an untouched field may be the user's.
    if (after.drawColormap !== before.drawColormap)
      applied.drawColormap = after.drawColormap
    if (after.drawOpacity !== before.drawOpacity)
      applied.drawOpacity = after.drawOpacity
    if (after.drawRimOpacity !== before.drawRimOpacity)
      applied.drawRimOpacity = after.drawRimOpacity
    if (after.drawRimWidth !== before.drawRimWidth)
      applied.drawRimWidth = after.drawRimWidth
  }
  let done = false
  const onDrawingChanged = () => {
    if (nv.drawingVolume !== installed) restore()
  }
  const restore = () => {
    if (done) return
    done = true
    nv.removeEventListener('drawingChanged', onDrawingChanged)
    if (nv.drawColormap === applied.drawColormap)
      nv.drawColormap = prior.drawColormap
    if (nv.drawOpacity === applied.drawOpacity)
      nv.drawOpacity = prior.drawOpacity
    if (nv.drawRimOpacity === applied.drawRimOpacity)
      nv.drawRimOpacity = prior.drawRimOpacity
    if (nv.drawRimWidth === applied.drawRimWidth)
      nv.drawRimWidth = prior.drawRimWidth
  }
  nv.addEventListener('drawingChanged', onDrawingChanged)
  return { restore, restyle }
}

/** Write the drawing's style as its owner, so a later restore still undoes it. */
export type Restyle = (write: () => void) => void

interface RtContour {
  type?: string
  points: ReadonlyArray<{ x: number; y: number; z: number }>
}
export interface RtRoi {
  ROINumber?: number
  ROIName?: string
  colorArray?: number[]
  contourPoints?: ReadonlyArray<RtContour>
}

/**
 * Row-major 3x4 matrix taking DICOM patient (LPS) mm to the base volume's RAS
 * voxel indices, from NiiVue's vox2mm (RAS mm). Null when it is not invertible.
 */
export function lpsToVoxel(vox2mm: Vox2mm): number[] | null {
  const o = vox2mm([0, 0, 0])
  const cx = vox2mm([1, 0, 0])
  const cy = vox2mm([0, 1, 0])
  const cz = vox2mm([0, 0, 1])
  if (!o || !cx || !cy || !cz) return null
  return lpsToVoxelOf(
    [0, 1, 2].flatMap((r) => [
      (cx[r] as number) - (o[r] as number),
      (cy[r] as number) - (o[r] as number),
      (cz[r] as number) - (o[r] as number),
      o[r] as number,
    ]),
  )
}

/**
 * Rasterize `contours` (LPS mm triplets) on a grid of `dims` voxels. Per slice,
 * a contour inside an odd number of others is a hole and the rest are unioned,
 * so overlapping CLOSED_PLANAR rings merge while a nested ring cuts a hole;
 * `xor` (CLOSEDPLANAR_XOR) fills even-odd instead. A contour lies on
 * the slice its points are nearest across the axis they vary least along;
 * voxels whose centres fall inside are in. A tilted contour (a gantry-tilted
 * or other series' plane) puts each voxel on the slice nearest its plane. Returns their count and centroid
 * (RAS voxels) and the runs (start index, length, step) for fillRuns.
 */
export function rasterizeContours(
  dims: readonly [number, number, number],
  lps2vox: ReadonlyArray<number>,
  contours: ReadonlyArray<ArrayLike<number>>,
  xor = false,
): SegmentStats & { runs: number[] } {
  const [
    m0 = 0,
    m1 = 0,
    m2 = 0,
    m3 = 0,
    m4 = 0,
    m5 = 0,
    m6 = 0,
    m7 = 0,
    m8 = 0,
    m9 = 0,
    m10 = 0,
    m11 = 0,
  ] = lps2vox
  const strides = [1, dims[0], dims[0] * dims[1]] as const
  // Contours (voxel coordinates) grouped by slice, or by plane when tilted.
  type Group = {
    w: 0 | 1 | 2
    slice: number
    isTilted: boolean
    contours: Float64Array[]
  }
  const slices = new Map<string, Group>()
  // Flat rings wait until every tilted plane is known: a hole too small to show
  // the slope still lies on its outer ring's plane and must share its group.
  const flat: { vox: Float64Array; w: 0 | 1 | 2; slice: number }[] = []
  for (const lps of contours) {
    const n = Math.floor(lps.length / 3)
    if (n < 3) continue
    const vox = new Float64Array(n * 3)
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < n * 3; i += 3) {
      const x = lps[i] as number
      const y = lps[i + 1] as number
      const z = lps[i + 2] as number
      vox[i] = m0 * x + m1 * y + m2 * z + m3
      vox[i + 1] = m4 * x + m5 * y + m6 * z + m7
      vox[i + 2] = m8 * x + m9 * y + m10 * z + m11
      for (let a = 0; a < 3; a++) {
        const c = vox[i + a] as number
        if (c < (lo[a] as number)) lo[a] = c
        if (c > (hi[a] as number)) hi[a] = c
      }
    }
    // Slice across the axis the plane faces most; a span-based pick collapses a
    // steep oblique ring whose extent along the faced axis is the larger one.
    const nrm = newellNormal(vox).map(Math.abs)
    const span = hi.map((h, a) => h - (lo[a] as number))
    const facing = nrm.some((x) => x > 0) ? nrm : span.map((x) => -x)
    let w: 0 | 1 | 2 = 0
    if ((facing[1] as number) > (facing[w] as number)) w = 1
    if ((facing[2] as number) > (facing[w] as number)) w = 2
    const slice = Math.round(((lo[w] as number) + (hi[w] as number)) / 2)
    const [a, b, c] = contourPlane(vox, w)
    // A slope that shows in the key marks the ring tilted even when it spans one
    // slice, so a small hole on its outer ring's tilted plane groups with it.
    const isTilted =
      Math.round(lo[w] as number) !== Math.round(hi[w] as number) ||
      Math.abs(a) >= 5e-4 ||
      Math.abs(b) >= 5e-4
    if (!isTilted) {
      flat.push({ vox, w, slice })
      continue
    }
    // Coplanar rings (an outer and its hole) share a plane, not a midpoint.
    if ((hi[w] as number) < -0.5 || (lo[w] as number) >= dims[w] - 0.5) continue
    const key = `${w}:${a.toFixed(3)}:${b.toFixed(3)}:${c.toFixed(1)}`
    const group = slices.get(key)
    if (group) group.contours.push(vox)
    else slices.set(key, { w, slice, isTilted, contours: [vox] })
  }
  const tilted = [...slices.values()]
  for (const { vox, w, slice } of flat) {
    const u = w === 0 ? 1 : 0
    const v = w === 2 ? 1 : 2
    const onPlane = tilted.find((g) => {
      if (g.w !== w) return false
      const [a, b, c] = contourPlane(g.contours[0] as Float64Array, w)
      for (let i = 0; i < vox.length; i += 3)
        if (
          Math.abs(
            a * (vox[i + u] as number) +
              b * (vox[i + v] as number) +
              c -
              (vox[i + w] as number),
          ) > 0.01
        )
          return false
      return true
    })
    if (onPlane) {
      onPlane.contours.push(vox)
      continue
    }
    if (slice < 0 || slice >= dims[w]) continue
    const key = `${w}:${slice}`
    const group = slices.get(key)
    if (group) group.contours.push(vox)
    else slices.set(key, { w, slice, isTilted: false, contours: [vox] })
  }
  let count = 0
  const runs: number[] = []
  const sum = [0, 0, 0]
  for (const { w, slice, isTilted, contours: group } of slices.values()) {
    // In-plane axes: u (row direction, the lower axis) and v.
    const u = w === 0 ? 1 : 0
    const v = w === 2 ? 1 : 2
    const nu = dims[u]
    const su = strides[u]
    const sv = strides[v]
    const base = slice * strides[w]
    let vmin = Infinity
    let vmax = -Infinity
    for (const p of group)
      for (let i = v; i < p.length; i += 3) {
        const c = p[i] as number
        if (c < vmin) vmin = c
        if (c > vmax) vmax = c
      }
    const [tiltU, tiltV, tiltC] = isTilted
      ? contourPlane(group[0] as Float64Array, w)
      : [0, 0, slice]
    const rowFirst = Math.max(0, Math.ceil(vmin))
    const rowLast = Math.min(dims[v] - 1, Math.floor(vmax))
    if (rowLast < rowFirst) continue
    // Bucket each edge's crossings by row: O(edges + crossings), not rows x edges.
    const rowCrossings: number[][] = Array.from(
      { length: rowLast - rowFirst + 1 },
      () => [],
    )
    // Union mode tags each crossing with its contour: +1 outer, -1 hole.
    const signed = !xor && group.length > 1
    const signs = signed ? holeSigns(group, u, v) : []
    const rowSigns: number[][] = signed ? rowCrossings.map(() => []) : []
    for (let k = 0; k < group.length; k++) {
      const p = group[k] as Float64Array
      const n = p.length
      let u0 = p[n - 3 + u] as number
      let v0 = p[n - 3 + v] as number
      for (let i = 0; i < n; i += 3) {
        const u1 = p[i + u] as number
        const v1 = p[i + v] as number
        // Rows in [min v, max v): half-open, so a vertex on a row counts once.
        const first = Math.max(rowFirst, Math.ceil(Math.min(v0, v1)))
        const last = Math.min(rowLast, Math.ceil(Math.max(v0, v1)) - 1)
        const slope = (u1 - u0) / (v1 - v0)
        for (let row = first; row <= last; row++) {
          ;(rowCrossings[row - rowFirst] as number[]).push(
            u0 + (row - v0) * slope,
          )
          if (signed) (rowSigns[row - rowFirst] as number[]).push(k)
        }
        u0 = u1
        v0 = v1
      }
    }
    for (let row = rowFirst; row <= rowLast; row++) {
      const crossings = signed
        ? unionSpans(
            rowCrossings[row - rowFirst] as number[],
            rowSigns[row - rowFirst] as number[],
            signs,
          )
        : (rowCrossings[row - rowFirst] as number[]).sort((a, b) => a - b)
      const rowBase = base + row * sv
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const first = Math.max(0, Math.ceil(crossings[i] as number))
        const last = Math.min(nu - 1, Math.ceil(crossings[i + 1] as number) - 1)
        if (last < first) continue
        if (!isTilted) {
          const run = last - first + 1
          runs.push(rowBase + first * su, run, su)
          count += run
          sum[u] = (sum[u] as number) + ((first + last) * run) / 2
          sum[v] = (sum[v] as number) + row * run
          sum[w] = (sum[w] as number) + slice * run
          continue
        }
        // One run per stretch of the row on the same nearest slice.
        const rowW = tiltV * row + tiltC
        for (let col = first; col <= last; ) {
          const at = Math.round(tiltU * col + rowW)
          let end = col
          while (end < last && Math.round(tiltU * (end + 1) + rowW) === at)
            end++
          const run = end - col + 1
          if (at >= 0 && at < dims[w]) {
            runs.push(at * strides[w] + row * sv + col * su, run, su)
            count += run
            sum[u] = (sum[u] as number) + ((col + end) * run) / 2
            sum[v] = (sum[v] as number) + row * run
            sum[w] = (sum[w] as number) + at * run
          }
          col = end + 1
        }
      }
    }
  }
  const centroid = sum.map((s) => (count ? s / count : 0)) as [
    number,
    number,
    number,
  ]
  return { count, centroid, runs }
}

/**
 * A contour's plane as w = a u + b v + c (Newell normal), u and v the other
 * two axes in rasterizeContours' order; w varies least, so its normal
 * component is the largest.
 */
/** A ring's Newell normal (area-weighted; zero for a degenerate ring). */
export function newellNormal(p: Float64Array): number[] {
  const nrm = [0, 0, 0]
  for (let i = 0, j = p.length - 3; i < p.length; j = i, i += 3)
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3
      const c = (a + 2) % 3
      nrm[a] =
        (nrm[a] as number) +
        ((p[j + b] as number) - (p[i + b] as number)) *
          ((p[j + c] as number) + (p[i + c] as number))
    }
  return nrm
}

function contourPlane(p: Float64Array, w: 0 | 1 | 2): [number, number, number] {
  const u = w === 0 ? 1 : 0
  const v = w === 2 ? 1 : 2
  const nrm = newellNormal(p)
  const nw = nrm[w] as number
  if (!nw) return [0, 0, p[w] as number]
  return [
    -(nrm[u] as number) / nw,
    -(nrm[v] as number) / nw,
    ((nrm[0] as number) * (p[0] as number) +
      (nrm[1] as number) * (p[1] as number) +
      (nrm[2] as number) * (p[2] as number)) /
      nw,
  ]
}

/** Set `bitmap` to `label` over rasterizeContours' runs. */
export function fillRuns(
  bitmap: Uint8Array,
  runs: ArrayLike<number>,
  label: number,
): void {
  for (let i = 0; i < runs.length; i += 3) {
    const start = runs[i] as number
    const run = runs[i + 1] as number
    const step = runs[i + 2] as number
    if (step === 1) bitmap.fill(label, start, start + run)
    else for (let j = 0; j < run; j++) bitmap[start + j * step] = label
  }
}

/** Whether point (pu, pv) is inside ring `q` (even-odd, in-plane axes u, v). */
function pointInRing(
  q: Float64Array,
  u: number,
  v: number,
  pu: number,
  pv: number,
): boolean {
  let inside = false
  let u0 = q[q.length - 3 + u] as number
  let v0 = q[q.length - 3 + v] as number
  for (let i = 0; i < q.length; i += 3) {
    const u1 = q[i + u] as number
    const v1 = q[i + v] as number
    if (v0 > pv !== v1 > pv && pu < u0 + ((pv - v0) * (u1 - u0)) / (v1 - v0))
      inside = !inside
    u0 = u1
    v0 = v1
  }
  return inside
}

/**
 * Whether ring `p` lies inside ring `q`: each edge of p, split where it meets
 * q, has every piece inside q or along its boundary (and at least one inside).
 */
export function ringInside(
  p: Float64Array,
  q: Float64Array,
  u: number,
  v: number,
): boolean {
  const eps = 1e-9
  let interior = false
  const ts: number[] = []
  let au = p[p.length - 3 + u] as number
  let av = p[p.length - 3 + v] as number
  for (let i = 0; i < p.length; i += 3) {
    const bu = p[i + u] as number
    const bv = p[i + v] as number
    const du = bu - au
    const dv = bv - av
    const len2 = du * du + dv * dv
    ts.length = 0
    ts.push(0, 1)
    let cu = q[q.length - 3 + u] as number
    let cv = q[q.length - 3 + v] as number
    for (let j = 0; j < q.length; j += 3) {
      const eu = q[j + u] as number
      const ev = q[j + v] as number
      const fu = eu - cu
      const fv = ev - cv
      const den = du * fv - dv * fu
      if (Math.abs(den) > eps) {
        const t = ((cu - au) * fv - (cv - av) * fu) / den
        const s = ((cu - au) * dv - (cv - av) * du) / den
        if (t > 0 && t < 1 && s >= -eps && s <= 1 + eps) ts.push(t)
      } else if (len2 > 0) {
        // Parallel: q's endpoints split p's edge where they lie on it.
        ts.push(((cu - au) * du + (cv - av) * dv) / len2)
        ts.push(((eu - au) * du + (ev - av) * dv) / len2)
      }
      cu = eu
      cv = ev
    }
    ts.sort((x, y) => x - y)
    for (let k = 1; k < ts.length; k++) {
      const t0 = Math.max(0, ts[k - 1] as number)
      const t1 = Math.min(1, ts[k] as number)
      if (t1 - t0 <= eps) continue
      const mu = au + ((t0 + t1) / 2) * du
      const mv = av + ((t0 + t1) / 2) * dv
      if (onRing(q, u, v, mu, mv)) continue
      if (!pointInRing(q, u, v, mu, mv)) return false
      interior = true
    }
    au = bu
    av = bv
  }
  return interior
}

/** Whether (pu, pv) lies on an edge of ring `q`. */
function onRing(
  q: Float64Array,
  u: number,
  v: number,
  pu: number,
  pv: number,
): boolean {
  let u0 = q[q.length - 3 + u] as number
  let v0 = q[q.length - 3 + v] as number
  for (let i = 0; i < q.length; i += 3) {
    const u1 = q[i + u] as number
    const v1 = q[i + v] as number
    const cross = (u1 - u0) * (pv - v0) - (v1 - v0) * (pu - u0)
    const dot = (pu - u0) * (u1 - u0) + (pv - v0) * (v1 - v0)
    const len2 = (u1 - u0) ** 2 + (v1 - v0) ** 2
    if (Math.abs(cross) <= 1e-9 * Math.max(1, len2) && dot >= 0 && dot <= len2)
      return true
    u0 = u1
    v0 = v1
  }
  return false
}

/** -1 for a hole (inside an odd number of the other rings), else +1. */
function holeSigns(group: Float64Array[], u: number, v: number): number[] {
  return group.map((p, k) => {
    let depth = 0
    for (let j = 0; j < group.length; j++)
      if (j !== k && ringInside(p, group[j] as Float64Array, u, v)) depth++
    return depth % 2 ? -1 : 1
  })
}

/** A row's crossings (tagged by contour) as [enter, exit] pairs of the union. */
function unionSpans(xs: number[], ks: number[], signs: number[]): number[] {
  const order = xs
    .map((_, i) => i)
    .sort((a, b) => (xs[a] as number) - (xs[b] as number))
  const inside = new Uint8Array(signs.length)
  const spans: number[] = []
  let level = 0
  for (const i of order) {
    const k = ks[i] as number
    const entering = !inside[k]
    inside[k] = entering ? 1 : 0
    const was = level
    level += (entering ? 1 : -1) * (signs[k] as number)
    if (was > 0 !== level > 0) spans.push(xs[i] as number)
  }
  return spans
}

/**
 * An ROI's closed planar contours as flat LPS triplets, and whether any is
 * CLOSEDPLANAR_XOR (filled even-odd, see rasterizeContours).
 */
export function roiContours(roi: RtRoi): {
  contours: Float64Array[]
  xor: boolean
} {
  const contours: Float64Array[] = []
  let xor = false
  for (const c of roi.contourPoints ?? []) {
    if (c.type !== 'CLOSED_PLANAR' && c.type !== 'CLOSEDPLANAR_XOR') continue
    xor ||= c.type === 'CLOSEDPLANAR_XOR'
    contours.push(
      Float64Array.from(c.points.flatMap((pt) => [pt.x, pt.y, pt.z])),
    )
  }
  return { contours, xor }
}

/** An RT drawing's per-ROI stats and its refill showing only `visible` ROIs. */
export interface RtLabels {
  stats: Map<number, SegmentStats>
  showOnly(visible?: ReadonlySet<number>): void
}

/**
 * Rasterize the first 255 ROIs with closed contours (the drawing's range),
 * labelled 1.. in list order; `draw` fills a bitmap and returns its refill.
 * Larger ROIs (by voxel count) are drawn first so nested ones stay visible on
 * top; stats are each ROI's own, and the refill without hidden ROIs uncovers
 * what they overlapped.
 */
export function rasterizeStructureSet(
  dims: readonly [number, number, number],
  lps2vox: ReadonlyArray<number>,
  rois: ReadonlyArray<RtRoi>,
): Pick<RtLabels, 'stats'> & {
  segments: PanelSegment[]
  draw: (bitmap: Uint8Array) => RtLabels['showOnly']
  // ROIs past the 255th were left out.
  truncated: boolean
} {
  // Cap after dropping empty ROIs, so empty ones never use up labels.
  const drawn: ({ roi: RtRoi; value: number } & ReturnType<
    typeof rasterizeContours
  >)[] = []
  let truncated = false
  for (const roi of rois) {
    const { contours, xor } = roiContours(roi)
    const r = rasterizeContours(dims, lps2vox, contours, xor)
    if (!r.count) continue
    // Truncated only once a 256th drawable ROI exists, not on trailing empty ones.
    if (drawn.length === 255) {
      truncated = true
      break
    }
    drawn.push({ roi, value: drawn.length + 1, ...r })
  }
  const bySize = [...drawn].sort((a, b) => b.count - a.count)
  const runs = bySize.map((r) => Int32Array.from(r.runs))
  const stats = new Map<number, SegmentStats>(
    drawn.map((r) => [r.value, { count: r.count, centroid: r.centroid }]),
  )
  const draw = (bitmap: Uint8Array) => {
    const showOnly = (visible?: ReadonlySet<number>) => {
      bitmap.fill(0)
      bySize.forEach((r, i) => {
        if (!visible || visible.has(r.value))
          fillRuns(bitmap, runs[i] as Int32Array, r.value)
      })
    }
    showOnly()
    return showOnly
  }
  const segments = drawn.map(({ roi, value }) => roiSegment(roi, value))
  return { segments, stats, draw, truncated }
}

/** An ROI as panel segment `value`: its name (else number) and colour. */
export function roiSegment(roi: RtRoi, value: number): PanelSegment {
  const [red = 255, green = 255, blue = 255] = roi.colorArray ?? []
  return {
    value,
    label: roi.ROIName ?? String(roi.ROINumber ?? value),
    rgb: [red, green, blue],
  }
}

export type RtDisplaySet = OhifDisplaySet & {
  load?: (o: {
    headers?: Record<string, string>
    createSegmentation?: boolean
  }) => Promise<void>
  structureSet?: { ROIContours?: RtRoi[] }
}

/**
 * Load `rt`'s contours (OHIF's own RT loader, without its cornerstone
 * segmentation), fill them into a new drawing on `nv`'s base volume and hand
 * the ROIs to `onShown`. Returns the cleanup, as startSegDrawing's.
 */
export function startRtDrawing(
  nv: Pick<
    NiiVue,
    | 'createEmptyDrawing'
    | 'closeDrawing'
    | 'refreshDrawing'
    | 'drawingVolume'
    | 'volumes'
    | 'vox2mm'
    | 'drawIsEnabled'
    | 'addColormap'
    | 'drawingGeneration'
    | 'drawColormap'
    | 'drawOpacity'
    | 'drawRimOpacity'
    | 'drawRimWidth'
    | 'addEventListener'
    | 'removeEventListener'
  >,
  rt: OhifDisplaySet,
  options: {
    headers?: Record<string, string>
    setNote: (message: string) => void
    // The contours rasterize onto the base's grid: resolves once the base is in.
    whenBase: Promise<boolean>
    onShown?: (
      segments: PanelSegment[],
      labels: RtLabels,
      restyle: Restyle,
    ) => () => void
    /** Called when the load settles without a drawing (not on stop). */
    onFailed?: () => void
  },
): () => void {
  let cancelled = false
  // The drawing this call installed; a later one is not ours to close.
  let owned: unknown = null
  let stopShown: (() => void) | undefined
  let restoreStyle: (() => void) | undefined
  const show = async () => {
    const ds = rt as RtDisplaySet
    // A drawing made or loaded while the structure set loads wins.
    const atStart = nv.drawingGeneration
    const [, hasBase] = await Promise.all([
      ds.load?.({ headers: options.headers, createSegmentation: false }),
      options.whenBase,
    ])
    if (cancelled || !hasBase || nv.drawingGeneration !== atStart) return
    const rois = ds.structureSet?.ROIContours ?? []
    const dims = nv.volumes[0]?.dimsRAS?.slice(1, 4) as
      | [number, number, number]
      | undefined
    const lps2vox = lpsToVoxel((vox) => nv.vox2mm(vox))
    if (!dims || !lps2vox) {
      options.setNote('The base image has no usable orientation for contours.')
      return
    }
    const { segments, stats, draw, truncated } = rasterizeStructureSet(
      dims,
      lps2vox,
      rois,
    )
    if (truncated)
      options.setNote(
        `Showing the first 255 of ${rois.length} ROIs (the drawing's label range).`,
      )
    // Before createEmptyDrawing: nothing to show must not replace the drawing.
    if (!segments.length) {
      options.setNote('The structure set has no closed contours to show.')
      return
    }
    nv.createEmptyDrawing()
    const bitmap = nv.drawingVolume?.img
    if (!(bitmap instanceof Uint8Array)) return
    owned = nv.drawingVolume
    // createEmptyDrawing arms the pen; the pane's tools keep the left button.
    nv.drawIsEnabled = false
    const showOnly = draw(bitmap)
    const style = styleDrawing(nv, () => {
      nv.drawColormap = nv.addColormap(
        `rt-${rt.displaySetInstanceUID ?? rt.SeriesInstanceUID ?? ''}`,
        panelColormap(
          segments.map((s) => ({
            ...s,
            color: [...s.rgb, 255],
            visible: true,
          })),
        ),
      )
      nv.drawOpacity = SEG_FILL_OPACITY
      nv.drawRimOpacity = SEG_RIM_OPACITY
    })
    restoreStyle = style.restore
    nv.refreshDrawing()
    stopShown = options.onShown?.(
      segments,
      {
        stats,
        showOnly: (visible) => {
          showOnly(visible)
          nv.refreshDrawing()
        },
      },
      style.restyle,
    )
  }
  show()
    .catch((err) => {
      if (cancelled) return
      console.error('[nv-ohif] RTSTRUCT load failed', err)
      options.setNote(
        `Structure set failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    .finally(() => {
      if (!cancelled && !owned) options.onFailed?.()
    })
  return () => {
    cancelled = true
    stopShown?.()
    if (owned && nv.drawingVolume === owned) nv.closeDrawing()
    restoreStyle?.()
  }
}
