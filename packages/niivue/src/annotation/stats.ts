import { mat4, vec4 } from 'gl-matrix'
import { sliceTypeDim } from '@/NVConstants'
import type {
  AnnotationPoint,
  AnnotationStats,
  AnnotationTool,
  NVImage,
  VectorAnnotation,
} from '@/NVTypes'
import { getVoxelValue } from '@/volume/utils'
import { clipperRegionArea } from './clipper'
import { constrainCircleEnd, isAnnotationErased, isCircleTool } from './shapes'
import { IN_PLANE_AXES, mmToSlice2D, slice2DToMM } from './sliceProjection'

export function isMeasureTool(tool: AnnotationTool): boolean {
  return (
    tool === 'measureEllipse' ||
    tool === 'measureRect' ||
    tool === 'measureLine' ||
    tool === 'measureCircle' ||
    tool === 'measureSpline' ||
    tool === 'measureLivewire' ||
    tool === 'measurePoint'
  )
}

/**
 * Degrees between a shape's two lines (start->end, start2->end2). measureAngle:
 * the angle at the shared vertex (0-180); measureCobbAngle: the acute angle
 * between the line directions (0-90), as cornerstone.
 */
export function shapeAngle(
  shape: {
    type: AnnotationTool
    start: AnnotationPoint
    end: AnnotationPoint
    start2?: AnnotationPoint
    end2?: AnnotationPoint
  },
  // Slice-2D -> world mm on the drawn plane: on an oblique slice the 2D axes
  // are a projection, so the angle must be taken in 3D.
  toMM: (p: AnnotationPoint) => ArrayLike<number> = (p) => [p.x, p.y, 0],
): number {
  const { start, end, start2 = end, end2 = end } = shape
  const [s, e, s2, e2] = [start, end, start2, end2].map(toMM) as [
    ArrayLike<number>,
    ArrayLike<number>,
    ArrayLike<number>,
    ArrayLike<number>,
  ]
  // Angle: both arms point away from the vertex (end === start2).
  const sign = shape.type === 'measureAngle' ? -1 : 1
  const a = [0, 1, 2].map((i) => sign * ((e[i] as number) - (s[i] as number)))
  const b = [0, 1, 2].map((i) => (e2[i] as number) - (s2[i] as number))
  const [ax, ay, az] = a as [number, number, number]
  const [bx, by, bz] = b as [number, number, number]
  const dot = ax * bx + ay * by + az * bz
  const cross = Math.hypot(
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx,
  )
  const rad = Math.atan2(
    cross,
    shape.type === 'measureCobbAngle' ? Math.abs(dot) : dot,
  )
  return (rad * 180) / Math.PI
}

/**
 * The drawn outline's area in mm², as cornerstone reports it: exact for an
 * intact rectangle, ellipse or circle (its polygon is a 64-gon, 0.16% short of
 * pi*a*b), else the polygons' even-odd area, as the voxel mask (freehand,
 * eraser cuts, self-crossing contours).
 * Measured in slice-2D (projected) coordinates; the caller corrects for tilt.
 */
function projectedArea(annotation: VectorAnnotation): number {
  const { shape } = annotation
  if (shape && !isAnnotationErased(annotation)) {
    const w = Math.abs(shape.end.x - shape.start.x)
    const h = Math.abs(shape.end.y - shape.start.y)
    if (shape.type === 'rectangle' || shape.type === 'measureRect') return w * h
    const ell = intactEllipse(annotation)
    if (ell) return Math.PI * ell.a * ell.b
  }
  return clipperRegionArea(annotation.polygons)
}

// Relative tolerance for a voxel centre on an ellipse's curve.
const ELLIPSE_TOL = 1e-9

/**
 * Slice-2D coordinates are the slice's projection onto an axis plane; on a
 * tilted volume (oblique matRAS) the slice is the plane of voxel axes ax0, ax1,
 * whose true areas are larger by 1 / |its unit normal's depth component|, as
 * the renderer's slice2DToMMOnPlane places the points.
 */
function tiltAreaScale(
  matRAS: ArrayLike<number>,
  ax0: number,
  ax1: number,
  depthDim: number,
): number {
  // matRAS is row-major: column k is voxel axis k in mm.
  const col = (k: number) => [matRAS[k], matRAS[4 + k], matRAS[8 + k]] as const
  const [a0, a1, a2] = col(ax0)
  const [b0, b1, b2] = col(ax1)
  const n = [a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0]
  return Math.hypot(n[0], n[1], n[2]) / Math.abs(n[depthDim] as number)
}

/**
 * Length in mm of slice-2D segment a-b on its slice's voxel plane: on a tilted
 * volume the plane's depth changes along the segment, as slice2DToMMOnPlane
 * places it, so the slice-2D distance alone is short.
 */
export function planeLength(
  matRAS: ArrayLike<number>,
  sliceType: number,
  a: AnnotationPoint,
  b: AnnotationPoint,
): number {
  const [ax0, ax1] = IN_PLANE_AXES[sliceType] as [number, number]
  const col = (k: number) => [matRAS[k], matRAS[4 + k], matRAS[8 + k]] as const
  const [a0, a1, a2] = col(ax0)
  const [b0, b1, b2] = col(ax1)
  const n = [a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0]
  const nd = n[sliceTypeDim(sliceType)] as number
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz =
    Math.abs(nd) > 1e-12
      ? -((n[ax0] as number) * dx + (n[ax1] as number) * dy) / nd
      : 0
  return Math.hypot(dx, dy, dz)
}

/**
 * Sets row `i1`'s voxels inside `ring` to `value`, by pointInRing's rule: x is
 * inside when an odd number of crossings lie strictly right of it, i.e. x in
 * [c0, c1), [c2, c3) ...
 */
function fillRingRow(
  ring: readonly AnnotationPoint[],
  i1: number,
  row: Uint8Array,
  r0min: number,
  r0max: number,
  value: number,
  xs: number[],
): void {
  xs.length = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as AnnotationPoint
    const b = ring[j] as AnnotationPoint
    if (a.y > i1 !== b.y > i1)
      xs.push(((b.x - a.x) * (i1 - a.y)) / (b.y - a.y) + a.x)
  }
  xs.sort((p, q) => p - q)
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const lo = Math.max(r0min, Math.ceil(xs[k] as number))
    const hi = Math.min(r0max, Math.ceil(xs[k + 1] as number) - 1)
    for (let i0 = lo; i0 <= hi; i0++) row[i0 - r0min] = value
  }
}

/** An intact ellipse or circle's centre and semi-axes (slice-2D mm), else null. */
function intactEllipse(
  annotation: VectorAnnotation,
): { cx: number; cy: number; a: number; b: number } | null {
  const { shape } = annotation
  if (
    !shape ||
    !(
      shape.type === 'ellipse' ||
      shape.type === 'measureEllipse' ||
      isCircleTool(shape.type)
    ) ||
    isAnnotationErased(annotation)
  )
    return null
  const { start } = shape
  // A circle is drawn in the square its end is constrained to (generateCircle).
  const end = isCircleTool(shape.type)
    ? constrainCircleEnd(start, shape.end)
    : shape.end
  return {
    cx: (start.x + end.x) / 2,
    cy: (start.y + end.y) / 2,
    a: Math.abs(end.x - start.x) / 2,
    b: Math.abs(end.y - start.y) / 2,
  }
}

/** The voxel plane an annotation lies on, and its slice-2D -> voxel map. */
function annotationPlane(annotation: VectorAnnotation, volume: NVImage) {
  const firstPt = annotation.polygons[0]?.outer[0]
  const dims = volume.dimsRAS
  const pixDims = volume.pixDimsRAS
  if (!firstPt || !dims || !pixDims) return null

  const sliceType = annotation.sliceType
  const depthDim = sliceTypeDim(sliceType)
  const [ax0, ax1] = IN_PLANE_AXES[sliceType] as [number, number]
  const pixDim0 = pixDims[ax0 + 1]
  const pixDim1 = pixDims[ax1 + 1]

  if (!volume.matRAS) return null

  // The slice's voxel plane: the one holding the anchor the renderer places
  // the ROI by (a tilted plane's depth varies across the outline).
  const vox2mm = mat4.transpose(mat4.create(), volume.matRAS)
  const mm2vox = mat4.invert(mat4.create(), vox2mm)
  if (!mm2vox) return null
  const tmpVec = vec4.create()
  const mm0 =
    annotation.anchorMM ??
    slice2DToMM(firstPt, annotation.slicePosition, sliceType)
  vec4.transformMat4(
    tmpVec,
    vec4.set(tmpVec, mm0[0], mm0[1], mm0[2], 1),
    mm2vox,
  )
  const depthVox = Math.round(tmpVec[depthDim] as number)
  if (depthVox < 0 || depthVox >= dims[depthDim + 1]) return null

  // Voxel (i0, i1) on that plane -> slice-2D mm is affine (projecting along the
  // mm depth axis, as slice2DToMMOnPlane places annotations). The rings, their
  // bounds and the ellipse rows all use it, so tilted volumes agree.
  const toSlice2D = (i0: number, i1: number): AnnotationPoint => {
    const v = [0, 0, 0]
    v[ax0] = i0
    v[ax1] = i1
    v[depthDim] = depthVox
    vec4.transformMat4(tmpVec, vec4.set(tmpVec, v[0], v[1], v[2], 1), vox2mm)
    return mmToSlice2D([tmpVec[0], tmpVec[1], tmpVec[2]], sliceType)
  }
  const o = toSlice2D(0, 0)
  const p0 = toSlice2D(1, 0)
  const p1 = toSlice2D(0, 1)
  const e0 = { x: p0.x - o.x, y: p0.y - o.y } // one voxel along i0
  const e1 = { x: p1.x - o.x, y: p1.y - o.y } // one voxel along i1
  const det = e0.x * e1.y - e1.x * e0.y
  // Continuous voxel coordinates: centres are tested against the exact
  // outline (as cornerstone does), not one rounded to whole voxels.
  const toVox = (pt: AnnotationPoint): AnnotationPoint => {
    const dx = pt.x - o.x
    const dy = pt.y - o.y
    return {
      x: (dx * e1.y - e1.x * dy) / det,
      y: (e0.x * dy - dx * e0.y) / det,
    }
  }
  return {
    depthDim,
    dims,
    ax0,
    ax1,
    pixDim0: pixDim0 as number,
    pixDim1: pixDim1 as number,
    matRAS: volume.matRAS,
    depthVox,
    o,
    e0,
    e1,
    det,
    toVox,
  }
}

/**
 * Visit the RAS voxel indices (reused array) whose centres lie inside an area
 * annotation, on its voxel plane, as computeAnnotationStats measures them
 * (holes excluded, an intact ellipse by its true curve, oblique planes by the
 * anchor's voxel depth). False when the outline covers no part of the image.
 * The scanline repeats computeAnnotationStats': sharing it slowed stats ~20%.
 */
export function forEachAnnotationVoxel(
  annotation: VectorAnnotation,
  volume: NVImage,
  visit: (ras: readonly [number, number, number]) => void,
): boolean {
  const plane = annotationPlane(annotation, volume)
  if (!plane) return false
  const { dims, ax0, ax1, depthDim, depthVox, toVox, o, e0, e1, det } = plane
  // Every piece of an eraser-split ROI counts (#115); a voxel inside any of a
  // piece's holes does not.
  const polygonsVox = annotation.polygons
    .filter((poly) => poly.outer.length >= 3)
    .map((poly) => [poly.outer, ...poly.holes].map((ring) => ring.map(toVox)))
  if (polygonsVox.length === 0) return false
  let minV0 = Infinity,
    minV1 = Infinity,
    maxV0 = -Infinity,
    maxV1 = -Infinity
  const ell = intactEllipse(annotation)
  if (ell) {
    // Bound the true curve, not its 64-gon: the gon falls short by
    // r(1 - cos(pi/64)), several voxels on a large shape. toVox is linear, so
    // the curve's voxel half-extents are the norms of its axes' rows.
    const c = toVox({ x: ell.cx, y: ell.cy })
    const h0 = Math.hypot(ell.a * e1.y, ell.b * e1.x) / Math.abs(det)
    const h1 = Math.hypot(ell.a * e0.y, ell.b * e0.x) / Math.abs(det)
    minV0 = c.x - h0
    maxV0 = c.x + h0
    minV1 = c.y - h1
    maxV1 = c.y + h1
  } else
    for (const [outer] of polygonsVox) {
      for (const pt of outer as AnnotationPoint[]) {
        if (pt.x < minV0) minV0 = pt.x
        if (pt.y < minV1) minV1 = pt.y
        if (pt.x > maxV0) maxV0 = pt.x
        if (pt.y > maxV1) maxV1 = pt.y
      }
    }
  const r0min = Math.max(0, Math.floor(minV0))
  const r0max = Math.min(dims[ax0 + 1] - 1, Math.ceil(maxV0))
  const r1min = Math.max(0, Math.floor(minV1))
  const r1max = Math.min(dims[ax1 + 1] - 1, Math.ceil(maxV1))
  // Off the image (e.g. drawn in a zoomed-out canvas margin): nothing to measure.
  if (r0max < r0min || r1max < r1min) return false

  // Scanline fill: per voxel row, where the outline crosses it, then the spans
  // between crossings; rows cost O(edges), not O(voxels x edges).
  const inRow = new Uint8Array(r0max - r0min + 1)
  const pieceRow = new Uint8Array(inRow.length)
  const xs: number[] = []
  const ras: [number, number, number] = [0, 0, 0]
  ras[depthDim] = depthVox
  for (let i1 = r1min; i1 <= r1max; i1++) {
    inRow.fill(0)
    if (ell) {
      // Along a row the slice point is o + i1*e1 + i0*e0: the row meets the
      // curve where a quadratic in i0 is zero. A closed curve, as cornerstone's
      // createEllipseShape: centres on it (and tangent rows) count.
      const u = (o.x + i1 * e1.x - ell.cx) / ell.a
      const w = (o.y + i1 * e1.y - ell.cy) / ell.b
      const du = e0.x / ell.a
      const dw = e0.y / ell.b
      const A = du * du + dw * dw
      const B = 2 * (u * du + w * dw)
      const disc = B * B - 4 * A * (u * u + w * w - 1 - ELLIPSE_TOL)
      if (disc >= 0) {
        const sq = Math.sqrt(disc)
        const lo = Math.max(r0min, Math.ceil((-B - sq) / (2 * A)))
        const hi = Math.min(r0max, Math.floor((-B + sq) / (2 * A)))
        for (let i0 = lo; i0 <= hi; i0++) inRow[i0 - r0min] = 1
      }
    } else
      for (const [outer, ...holes] of polygonsVox) {
        if (holes.length === 0) {
          fillRingRow(
            outer as AnnotationPoint[],
            i1,
            inRow,
            r0min,
            r0max,
            1,
            xs,
          )
          continue
        }
        pieceRow.fill(0)
        fillRingRow(
          outer as AnnotationPoint[],
          i1,
          pieceRow,
          r0min,
          r0max,
          1,
          xs,
        )
        for (const hole of holes)
          fillRingRow(hole, i1, pieceRow, r0min, r0max, 0, xs)
        for (let k = 0; k < pieceRow.length; k++)
          inRow[k] |= pieceRow[k] as number
      }
    ras[ax1] = i1
    for (let k = 0; k < inRow.length; k++) {
      if (!inRow[k]) continue
      ras[ax0] = r0min + k
      visit(ras)
    }
  }
  return true
}

/**
 * Stats over the voxels whose centres lie inside the outline (an intact
 * ellipse or circle: the true curve, not its drawn 64-gon, as cornerstone). `area` is their
 * count times the voxel area, or with `isAreaGeometric` the outline's own area
 * ({@link AnnotationConfig.isAreaGeometric}).
 */
export function computeAnnotationStats(
  annotation: VectorAnnotation,
  volume: NVImage,
  isAreaGeometric = false,
): AnnotationStats | null {
  const shape = annotation.shape
  if (!shape) return null
  if (!volume.dimsRAS || !volume.pixDimsRAS) return null

  if (shape.type === 'measureLine')
    return {
      area: 0,
      min: 0,
      mean: 0,
      max: 0,
      stdDev: 0,
      length: volume.matRAS
        ? planeLength(
            volume.matRAS,
            annotation.sliceType,
            shape.start,
            shape.end,
          )
        : Math.hypot(shape.end.x - shape.start.x, shape.end.y - shape.start.y),
    }

  if (shape.type === 'measureAngle' || shape.type === 'measureCobbAngle')
    // Drawing records the angle on its (maybe oblique) plane, which this
    // signature cannot see; recompute only as a slice-2D fallback.
    return {
      area: 0,
      min: 0,
      mean: 0,
      max: 0,
      stdDev: 0,
      angle: annotation.stats?.angle ?? shapeAngle(shape),
    }

  const firstPt = annotation.polygons[0]?.outer[0]
  if (!firstPt) return null

  const sliceType = annotation.sliceType
  const depthDim = sliceTypeDim(sliceType)
  const dims = volume.dimsRAS
  const pixDims = volume.pixDimsRAS
  const [ax0, ax1] = IN_PLANE_AXES[sliceType] as [number, number]
  const pixDim0 = pixDims[ax0 + 1]
  const pixDim1 = pixDims[ax1 + 1]

  if (!volume.matRAS) return null

  // The slice's voxel plane: the one holding the anchor the renderer places
  // the ROI by (a tilted plane's depth varies across the outline).
  const vox2mm = mat4.transpose(mat4.create(), volume.matRAS)
  const mm2vox = mat4.invert(mat4.create(), vox2mm)
  if (!mm2vox) return null
  const tmpVec = vec4.create()
  const isPoint = shape.type === 'measurePoint'
  const mm0 =
    annotation.anchorMM ??
    slice2DToMM(firstPt, annotation.slicePosition, sliceType)
  vec4.transformMat4(
    tmpVec,
    vec4.set(tmpVec, mm0[0], mm0[1], mm0[2], 1),
    mm2vox,
  )
  const depthVox = Math.round(tmpVec[depthDim] as number)
  if (depthVox < 0 || depthVox >= dims[depthDim + 1]) return null

  // Voxel (i0, i1) on that plane -> slice-2D mm is affine (projecting along the
  // mm depth axis, as slice2DToMMOnPlane places annotations). The rings, their
  // bounds and the ellipse rows all use it, so tilted volumes agree.
  const toSlice2D = (i0: number, i1: number): AnnotationPoint => {
    const v = [0, 0, 0]
    v[ax0] = i0
    v[ax1] = i1
    v[depthDim] = depthVox
    vec4.transformMat4(tmpVec, vec4.set(tmpVec, v[0], v[1], v[2], 1), vox2mm)
    return mmToSlice2D([tmpVec[0], tmpVec[1], tmpVec[2]], sliceType)
  }
  const o = toSlice2D(0, 0)
  const p0 = toSlice2D(1, 0)
  const p1 = toSlice2D(0, 1)
  const e0 = { x: p0.x - o.x, y: p0.y - o.y } // one voxel along i0
  const e1 = { x: p1.x - o.x, y: p1.y - o.y } // one voxel along i1
  const det = e0.x * e1.y - e1.x * e0.y
  // Continuous voxel coordinates: centres are tested against the exact
  // outline (as cornerstone does), not one rounded to whole voxels.
  const toVox = (pt: AnnotationPoint): AnnotationPoint => {
    const dx = pt.x - o.x
    const dy = pt.y - o.y
    return {
      x: (dx * e1.y - e1.x * dy) / det,
      y: (e0.x * dy - dx * e0.y) / det,
    }
  }
  const frame = volume.frame4D ?? 0
  if (isPoint) {
    const v = toVox(shape.end)
    const ras = [0, 0, 0]
    ras[ax0] = Math.round(v.x)
    ras[ax1] = Math.round(v.y)
    ras[depthDim] = depthVox
    if (ras.some((x, i) => x < 0 || x >= (dims[i + 1] as number))) return null
    // The displayed 4D frame, as the crosshair readout samples it.
    const value = getVoxelValue(volume, ras[0], ras[1], ras[2], frame)
    if (!Number.isFinite(value)) return null
    return { area: 0, min: value, mean: value, max: value, stdDev: 0, value }
  }
  // Every piece of an eraser-split ROI counts (#115); a voxel inside any of a
  // piece's holes does not.
  const polygonsVox = annotation.polygons
    .filter((poly) => poly.outer.length >= 3)
    .map((poly) => [poly.outer, ...poly.holes].map((ring) => ring.map(toVox)))
  if (polygonsVox.length === 0) return null
  let minV0 = Infinity,
    minV1 = Infinity,
    maxV0 = -Infinity,
    maxV1 = -Infinity
  const ell = intactEllipse(annotation)
  if (ell) {
    // Bound the true curve, not its 64-gon: the gon falls short by
    // r(1 - cos(pi/64)), several voxels on a large shape. toVox is linear, so
    // the curve's voxel half-extents are the norms of its axes' rows.
    const c = toVox({ x: ell.cx, y: ell.cy })
    const h0 = Math.hypot(ell.a * e1.y, ell.b * e1.x) / Math.abs(det)
    const h1 = Math.hypot(ell.a * e0.y, ell.b * e0.x) / Math.abs(det)
    minV0 = c.x - h0
    maxV0 = c.x + h0
    minV1 = c.y - h1
    maxV1 = c.y + h1
  } else
    for (const [outer] of polygonsVox) {
      for (const pt of outer as AnnotationPoint[]) {
        if (pt.x < minV0) minV0 = pt.x
        if (pt.y < minV1) minV1 = pt.y
        if (pt.x > maxV0) maxV0 = pt.x
        if (pt.y > maxV1) maxV1 = pt.y
      }
    }
  const r0min = Math.max(0, Math.floor(minV0))
  const r0max = Math.min(dims[ax0 + 1] - 1, Math.ceil(maxV0))
  const r1min = Math.max(0, Math.floor(minV1))
  const r1max = Math.min(dims[ax1 + 1] - 1, Math.ceil(maxV1))
  // Off the image (e.g. drawn in a zoomed-out canvas margin): nothing to measure.
  if (r0max < r0min || r1max < r1min) return null

  let count = 0
  let sum = 0
  let sumSq = 0
  let min = Infinity
  let max = -Infinity

  // Scanline fill: per voxel row, where the outline crosses it, then the spans
  // between crossings; rows cost O(edges), not O(voxels x edges).
  const inRow = new Uint8Array(r0max - r0min + 1)
  const pieceRow = new Uint8Array(inRow.length)
  const xs: number[] = []
  const ras: [number, number, number] = [0, 0, 0]
  ras[depthDim] = depthVox
  for (let i1 = r1min; i1 <= r1max; i1++) {
    inRow.fill(0)
    if (ell) {
      // Along a row the slice point is o + i1*e1 + i0*e0: the row meets the
      // curve where a quadratic in i0 is zero. A closed curve, as cornerstone's
      // createEllipseShape: centres on it (and tangent rows) count.
      const u = (o.x + i1 * e1.x - ell.cx) / ell.a
      const w = (o.y + i1 * e1.y - ell.cy) / ell.b
      const du = e0.x / ell.a
      const dw = e0.y / ell.b
      const A = du * du + dw * dw
      const B = 2 * (u * du + w * dw)
      const disc = B * B - 4 * A * (u * u + w * w - 1 - ELLIPSE_TOL)
      if (disc >= 0) {
        const sq = Math.sqrt(disc)
        const lo = Math.max(r0min, Math.ceil((-B - sq) / (2 * A)))
        const hi = Math.min(r0max, Math.floor((-B + sq) / (2 * A)))
        for (let i0 = lo; i0 <= hi; i0++) inRow[i0 - r0min] = 1
      }
    } else
      for (const [outer, ...holes] of polygonsVox) {
        if (holes.length === 0) {
          fillRingRow(
            outer as AnnotationPoint[],
            i1,
            inRow,
            r0min,
            r0max,
            1,
            xs,
          )
          continue
        }
        pieceRow.fill(0)
        fillRingRow(
          outer as AnnotationPoint[],
          i1,
          pieceRow,
          r0min,
          r0max,
          1,
          xs,
        )
        for (const hole of holes)
          fillRingRow(hole, i1, pieceRow, r0min, r0max, 0, xs)
        for (let k = 0; k < pieceRow.length; k++)
          inRow[k] |= pieceRow[k] as number
      }
    ras[ax1] = i1
    for (let i0 = r0min; i0 <= r0max; i0++) {
      if (!inRow[i0 - r0min]) continue
      ras[ax0] = i0
      const val = getVoxelValue(volume, ras[0], ras[1], ras[2], frame)
      // NaN: no data there (float padding, a streamed brick not yet decoded).
      if (!Number.isFinite(val)) continue
      count++
      sum += val
      sumSq += val * val
      if (val < min) min = val
      if (val > max) max = val
    }
  }

  const area = isAreaGeometric
    ? projectedArea(annotation) *
      tiltAreaScale(volume.matRAS, ax0, ax1, depthDim)
    : count * pixDim0 * pixDim1
  if (count === 0)
    // A sub-voxel outline still has a geometric area; no voxels, no intensities.
    return isAreaGeometric ? { area, min: 0, mean: 0, max: 0, stdDev: 0 } : null
  const mean = sum / count
  const variance = sumSq / count - mean * mean
  const stdDev = Math.sqrt(Math.max(0, variance))

  return { area, min, mean, max, stdDev }
}
