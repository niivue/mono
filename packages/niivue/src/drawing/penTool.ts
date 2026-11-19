import { log } from '@/logger'
import { PEN_SHAPE } from '@/NVConstants'
import { decodeRLE } from './rle'

export enum PEN_SLICE_TYPE {
  AXIAL = 0,
  CORONAL = 1,
  SAGITTAL = 2,
}

export interface DrawPointParams {
  x: number
  y: number
  z: number
  penValue: number
  drawBitmap: Uint8Array
  dims: number[]
  penSize: number
  penShape?: PEN_SHAPE
  penAxCorSag: number
  penOverwrites?: boolean
  // NIfTI-style [_, mmX, mmY, mmZ] (RAS) for PEN_SHAPE.SPHERE; default 1 mm.
  pixDims?: readonly number[]
}

export interface DrawLineParams {
  ptA: number[]
  ptB: number[]
  penValue: number
  drawBitmap: Uint8Array
  dims: number[]
  penSize: number
  penShape?: PEN_SHAPE
  penAxCorSag: number
  penOverwrites?: boolean
  // NIfTI-style [_, mmX, mmY, mmZ] (RAS) for PEN_SHAPE.SPHERE; default 1 mm.
  pixDims?: readonly number[]
}

interface FloodFillSectionParams {
  img2D: Uint8Array
  dims2D: readonly number[]
  minPt: readonly number[]
  maxPt: readonly number[]
}

export interface DrawPenFilledParams {
  penFillPts: number[][]
  penAxCorSag: number
  drawBitmap: Uint8Array
  dims: number[]
  penValue: number
  fillOverwrites: boolean
  currentUndoBitmap: Uint8Array | null
}

export interface DrawPenFilledResult {
  drawBitmap: Uint8Array
  success: boolean
}

export function voxelIndex(
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
): number {
  return x + y * dx + z * dx * dy
}

export function clampToDimension(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max - 1)
}

export interface DrawSphereParams {
  x: number
  y: number
  z: number
  // Voxels: one number is an isotropic radius (floored); a triple gives per-axis
  // radii (an ellipsoid in voxels, i.e. a ball in mm on anisotropic voxels; 0 on
  // an axis flattens it to a disc in that plane).
  radius: number | readonly number[]
  penValue: number
  drawBitmap: Uint8Array
  dims: number[] // NIfTI-style [ndim, dimX, dimY, dimZ]
  penOverwrites: boolean
}

// Fill bitmap[start..end] (inclusive) with v; skip non-zero voxels when `keep`.
function fillRun(
  bmp: Uint8Array,
  start: number,
  end: number,
  v: number,
  keep: boolean,
): void {
  if (!keep) {
    bmp.fill(v, start, end + 1)
    return
  }
  for (let i = start; i <= end; i++) if (bmp[i] === 0) bmp[i] = v
}

/**
 * Paint a solid voxel ball centred at integer voxel (x,y,z). Unlike `drawPoint`
 * (a disk on a 2D slice plane), this is a true 3D brush: the ball pen
 * (`PEN_SHAPE.SPHERE`), sphere/circle fills, and drawing directly on a 3D render
 * (e.g. exploded blocks), where there is no slice plane. Radius 0 paints a
 * single voxel. Honors `penOverwrites` (skip non-zero voxels when false and not
 * erasing). Walks x-runs clipped to the volume, so no per-voxel bounds test.
 */
export function drawSphere(params: DrawSphereParams): void {
  const { x, y, z, radius, penValue, drawBitmap } = params
  const dx = params.dims[1]
  const dy = params.dims[2]
  const dz = params.dims[3]
  const r = typeof radius === 'number' ? Math.max(0, Math.floor(radius)) : 0
  const [rx, ry, rz] = typeof radius === 'number' ? [r, r, r] : radius
  const keep = params.penOverwrites === false && penValue !== 0
  const iy = Math.floor(ry)
  const iz = Math.floor(rz)
  const z1 = Math.min(dz - 1, z + iz)
  const y0 = Math.max(0, y - iy)
  const y1 = Math.min(dy - 1, y + iy)
  for (let vz = Math.max(0, z - iz); vz <= z1; vz++) {
    const tz = rz > 0 ? ((vz - z) / rz) ** 2 : 0
    for (let vy = y0; vy <= y1; vy++) {
      const rest = 1 - tz - (ry > 0 ? ((vy - y) / ry) ** 2 : 0)
      // 1e-9: keep on-surface voxels that rounding puts a hair outside, e.g.
      // (0,3,4) at radius 5 gives rest = -5.6e-17.
      if (rest < -1e-9) continue
      const hx = Math.floor(rx * Math.sqrt(Math.max(0, rest)) + 1e-9)
      const x0 = Math.max(0, x - hx)
      const x1 = Math.min(dx - 1, x + hx)
      if (x0 > x1) continue
      const row = (vy + vz * dy) * dx
      fillRun(drawBitmap, row + x0, row + x1, penValue, keep)
    }
  }
}

export interface DrawShapeFillParams {
  shape: PEN_SHAPE
  // Voxel coordinates (RAS). Circle/sphere: a = centre, b = a point on the
  // edge. Rectangle: opposite corners, in the plane through a.
  a: ArrayLike<number>
  b: ArrayLike<number>
  // Plane of a circle or rectangle (PEN_SLICE_TYPE, else axial); ignored by a sphere.
  sliceType: number
  penValue: number
  drawBitmap: Uint8Array
  dims: number[] // NIfTI-style [ndim, dimX, dimY, dimZ]
  pixDims: readonly number[] // NIfTI-style [_, mmX, mmY, mmZ], RAS
  penOverwrites: boolean
}

/**
 * Fill a circle (slice plane), rectangle (slice plane) or sphere. Radii are
 * measured in mm, so circles and spheres stay round on anisotropic voxels.
 * Returns the largest per-axis voxel radius (the dirty-box margin around `a`).
 */
export function drawShapeFill(p: DrawShapeFillParams): number {
  const a = [Math.round(p.a[0]), Math.round(p.a[1]), Math.round(p.a[2])]
  // axial -> z, coronal -> y, sagittal -> x; multiplanar or render -> axial
  const normal = p.sliceType >= 0 && p.sliceType <= 2 ? 2 - p.sliceType : 2
  if (p.shape === PEN_SHAPE.RECTANGLE) {
    const lo = [0, 0, 0]
    const hi = [0, 0, 0]
    for (let i = 0; i < 3; i++) {
      const b = i === normal ? a[i] : Math.round(p.b[i])
      lo[i] = Math.max(0, Math.min(a[i], b))
      hi[i] = Math.min(p.dims[i + 1] - 1, Math.max(a[i], b))
    }
    const dx = p.dims[1]
    const dy = p.dims[2]
    const keep = p.penOverwrites === false && p.penValue !== 0
    if (lo[0] > hi[0]) return 0
    for (let z = lo[2]; z <= hi[2]; z++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        const row = (y + z * dy) * dx
        fillRun(p.drawBitmap, row + lo[0], row + hi[0], p.penValue, keep)
      }
    }
    return 0
  }
  const isCircle = p.shape === PEN_SHAPE.CIRCLE
  let r2 = 0
  for (let i = 0; i < 3; i++) {
    if (isCircle && i === normal) continue
    r2 += ((p.b[i] - p.a[i]) * p.pixDims[i + 1]) ** 2
  }
  const rMm = Math.sqrt(r2)
  const radius = [0, 1, 2].map((i) =>
    isCircle && i === normal ? 0 : rMm / p.pixDims[i + 1],
  )
  drawSphere({
    x: a[0],
    y: a[1],
    z: a[2],
    radius,
    penValue: p.penValue,
    drawBitmap: p.drawBitmap,
    dims: p.dims,
    penOverwrites: p.penOverwrites,
  })
  return Math.max(...radius)
}

export interface FloodFill3DParams {
  seed: readonly [number, number, number]
  drawBitmap: Uint8Array
  dims: number[] // NIfTI-style [ndim, dimX, dimY, dimZ]
  penValue: number
  // Returns true for a voxel that belongs to the region being filled (e.g. its
  // source intensity is above the visible-tissue threshold). The seed must pass
  // it too or nothing is filled.
  keep: (x: number, y: number, z: number) => boolean
  // When false, do not repaint already-nonzero draw voxels (unless erasing).
  fillOverwrites: boolean
  // Safety cap so a fill over a huge connected region can't run unbounded.
  maxVoxels?: number
}

export interface FloodFill3DResult {
  filled: number
  min: [number, number, number]
  max: [number, number, number]
  hitCap: boolean
}

/**
 * 3D region-grow flood fill for drawing on exploded blocks (no slice plane).
 * Seeded at `seed`, grows over 6-connected voxels for which `keep` is true and
 * paints them `penValue`. Honors `fillOverwrites` (skip already-painted voxels
 * when false and not erasing) and stops at `maxVoxels`. Returns the painted-voxel
 * count and inclusive AABB (for the incremental drawing flush); `filled` is 0 and
 * the AABB collapses to the seed when the seed itself fails `keep`.
 */
export function floodFill3D(params: FloodFill3DParams): FloodFill3DResult {
  const { seed, drawBitmap, dims, penValue, keep, fillOverwrites } = params
  const dx = dims[1]
  const dy = dims[2]
  const dz = dims[3]
  const cap = params.maxVoxels ?? dx * dy * dz
  const sx = Math.round(seed[0])
  const sy = Math.round(seed[1])
  const sz = Math.round(seed[2])
  const min: [number, number, number] = [sx, sy, sz]
  const max: [number, number, number] = [sx, sy, sz]
  const inBounds = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < dx && y < dy && z < dz
  if (!inBounds(sx, sy, sz) || !keep(sx, sy, sz)) {
    return { filled: 0, min, max, hitCap: false }
  }
  const skipOverwrite = fillOverwrites === false && penValue !== 0
  // Visited marks prevent re-enqueuing; separate from the draw bitmap so an
  // eraser fill (penValue 0) still terminates.
  const visited = new Uint8Array(dx * dy * dz)
  const stack: number[] = [sx, sy, sz]
  // Mark visited on PUSH (not on pop), so each voxel is enqueued at most once and
  // the stack stays bounded by the region size instead of ~6x it.
  visited[voxelIndex(sx, sy, sz, dx, dy)] = 1
  const pushIfNew = (nx: number, ny: number, nz: number): void => {
    const nf = voxelIndex(nx, ny, nz, dx, dy)
    if (!visited[nf]) {
      visited[nf] = 1
      stack.push(nx, ny, nz)
    }
  }
  let filled = 0
  let hitCap = false
  while (stack.length > 0) {
    const z = stack.pop() as number
    const y = stack.pop() as number
    const x = stack.pop() as number
    const flat = voxelIndex(x, y, z, dx, dy)
    if (!keep(x, y, z)) continue
    if (!(skipOverwrite && drawBitmap[flat] !== 0)) {
      // Check the cap before painting so exhausting the region exactly at the
      // cap is a clean finish, not a spurious early stop.
      if (filled >= cap) {
        hitCap = true
        break
      }
      drawBitmap[flat] = penValue
      filled++
      if (x < min[0]) min[0] = x
      if (y < min[1]) min[1] = y
      if (z < min[2]) min[2] = z
      if (x > max[0]) max[0] = x
      if (y > max[1]) max[1] = y
      if (z > max[2]) max[2] = z
    }
    if (x + 1 < dx) pushIfNew(x + 1, y, z)
    if (x - 1 >= 0) pushIfNew(x - 1, y, z)
    if (y + 1 < dy) pushIfNew(x, y + 1, z)
    if (y - 1 >= 0) pushIfNew(x, y - 1, z)
    if (z + 1 < dz) pushIfNew(x, y, z + 1)
    if (z - 1 >= 0) pushIfNew(x, y, z - 1)
  }
  return { filled, min, max, hitCap }
}

export interface MagicWand3DParams {
  seed: readonly [number, number, number]
  drawBitmap: Uint8Array
  dims: number[] // NIfTI-style [ndim, dimX, dimY, dimZ]
  penValue: number
  // Source intensity lookup (RAS voxel order), e.g. from getImageDataRAS.
  sample: (x: number, y: number, z: number) => number
  // Absolute intensity distance from the seed voxel's value; a voxel joins the
  // region when |sample(v) - sample(seed)| <= tolerance.
  tolerance: number
  fillOverwrites: boolean
  maxVoxels?: number
  // When set, confine the region to a single slice: the given axis (0=x, 1=y,
  // 2=z) is pinned to `index`, so the flood cannot leave that plane and the grow
  // is 2D-connected. Omit for a full 3D grow (the default).
  restrictToSlice?: { axis: number; index: number }
}

/**
 * Click-to-segment ("magic wand") for voxel volumes. Grows a 6-connected region
 * out from `seed` over voxels whose source intensity is within `tolerance` of the
 * seed voxel's value, painting them `penValue` in the drawing bitmap. Thin wrapper
 * over {@link floodFill3D} — the connectivity, overwrite, cap, and AABB semantics
 * are identical; only the membership test differs (seed-relative intensity band vs
 * a fixed threshold). With `restrictToSlice` the grow is confined to one plane
 * (2D); otherwise it grows through the whole connected structure (3D). Returns
 * `filled: 0` when the seed is out of bounds.
 */
export function magicWand3D(params: MagicWand3DParams): FloodFill3DResult {
  const dx = params.dims[1]
  const dy = params.dims[2]
  const dz = params.dims[3]
  const sx = Math.round(params.seed[0])
  const sy = Math.round(params.seed[1])
  const sz = Math.round(params.seed[2])
  if (sx < 0 || sy < 0 || sz < 0 || sx >= dx || sy >= dy || sz >= dz) {
    return { filled: 0, min: [sx, sy, sz], max: [sx, sy, sz], hitCap: false }
  }
  const seedValue = params.sample(sx, sy, sz)
  const tol = Math.max(0, params.tolerance)
  const slice = params.restrictToSlice
  // A pinned plane rejects any off-plane voxel; since the flood is 6-connected,
  // rejecting the two depth-axis neighbors keeps the whole grow on one slice.
  const onPlane = slice
    ? (x: number, y: number, z: number): boolean =>
        [x, y, z][slice.axis] === slice.index
    : (): boolean => true
  return floodFill3D({
    seed: [sx, sy, sz],
    drawBitmap: params.drawBitmap,
    dims: params.dims,
    penValue: params.penValue,
    fillOverwrites: params.fillOverwrites,
    maxVoxels: params.maxVoxels,
    keep: (x, y, z) =>
      onPlane(x, y, z) && Math.abs(params.sample(x, y, z) - seedValue) <= tol,
  })
}

export function drawPoint(params: DrawPointParams): void {
  const {
    x: inputX,
    y: inputY,
    z: inputZ,
    penValue,
    drawBitmap,
    dims,
    penSize,
    penShape = PEN_SHAPE.RECTANGLE,
    penAxCorSag,
    penOverwrites,
  } = params
  const skip = penOverwrites === false && penValue !== 0

  const dx = dims[1]
  const dy = dims[2]
  const dz = dims[3]

  const x = clampToDimension(inputX, dx)
  const y = clampToDimension(inputY, dy)
  const z = clampToDimension(inputZ, dz)

  if (penShape === PEN_SHAPE.SPHERE) {
    // Diameter: penSize voxels along the finest axis, so the ball is round in mm.
    const [, sx = 1, sy = 1, sz = 1] = params.pixDims ?? []
    const r = (penSize * Math.min(sx, sy, sz)) / 2
    drawSphere({
      x,
      y,
      z,
      radius: [r / sx, r / sy, r / sz],
      penValue,
      drawBitmap,
      dims,
      penOverwrites: penOverwrites !== false,
    })
    return
  }

  const idx = voxelIndex(x, y, z, dx, dy)
  if (!skip || drawBitmap[idx] === 0) {
    drawBitmap[idx] = penValue
  }

  if (penSize > 1) {
    const halfPenSize = Math.floor(penSize / 2)
    const isAx = penAxCorSag === PEN_SLICE_TYPE.AXIAL
    const isCor = penAxCorSag === PEN_SLICE_TYPE.CORONAL
    const isSag = penAxCorSag === PEN_SLICE_TYPE.SAGITTAL
    // Circle brush: keep voxels whose centre lies within penSize / 2 of the
    // pen centre. `>` (not `>=`) so even sizes keep their on-axis extremes.
    const radiusSq = (penSize / 2) ** 2
    const isCircle = penShape === PEN_SHAPE.CIRCLE

    for (let i = -halfPenSize; i <= halfPenSize; i++) {
      for (let j = -halfPenSize; j <= halfPenSize; j++) {
        if (isCircle && i * i + j * j > radiusSq) continue

        let nx: number, ny: number, nz: number

        if (isAx) {
          nx = clampToDimension(x + i, dx)
          ny = clampToDimension(y + j, dy)
          nz = z
        } else if (isCor) {
          nx = clampToDimension(x + i, dx)
          ny = y
          nz = clampToDimension(z + j, dz)
        } else if (isSag) {
          nx = x
          ny = clampToDimension(y + j, dy)
          nz = clampToDimension(z + i, dz)
        } else {
          continue
        }

        const vi = voxelIndex(nx, ny, nz, dx, dy)
        if (!skip || drawBitmap[vi] === 0) {
          drawBitmap[vi] = penValue
        }
      }
    }
  }
}

export function drawLine(params: DrawLineParams): void {
  const {
    ptA,
    ptB,
    penValue,
    drawBitmap,
    dims,
    penSize,
    penShape,
    penAxCorSag,
    penOverwrites,
    pixDims,
  } = params

  const dx = Math.abs(ptA[0] - ptB[0])
  const dy = Math.abs(ptA[1] - ptB[1])
  const dz = Math.abs(ptA[2] - ptB[2])

  const xs = ptB[0] > ptA[0] ? 1 : -1
  const ys = ptB[1] > ptA[1] ? 1 : -1
  const zs = ptB[2] > ptA[2] ? 1 : -1

  let x1 = ptA[0]
  let y1 = ptA[1]
  let z1 = ptA[2]

  const x2 = ptB[0]
  const y2 = ptB[1]
  const z2 = ptB[2]

  const pointParams: DrawPointParams = {
    x: 0,
    y: 0,
    z: 0,
    penValue,
    drawBitmap,
    dims,
    penSize,
    penShape,
    penAxCorSag,
    penOverwrites,
    pixDims,
  }

  if (dx >= dy && dx >= dz) {
    let p1 = 2 * dy - dx
    let p2 = 2 * dz - dx
    while (x1 !== x2) {
      x1 += xs
      if (p1 >= 0) {
        y1 += ys
        p1 -= 2 * dx
      }
      if (p2 >= 0) {
        z1 += zs
        p2 -= 2 * dx
      }
      p1 += 2 * dy
      p2 += 2 * dz
      pointParams.x = x1
      pointParams.y = y1
      pointParams.z = z1
      drawPoint(pointParams)
    }
  } else if (dy >= dx && dy >= dz) {
    let p1 = 2 * dx - dy
    let p2 = 2 * dz - dy
    while (y1 !== y2) {
      y1 += ys
      if (p1 >= 0) {
        x1 += xs
        p1 -= 2 * dy
      }
      if (p2 >= 0) {
        z1 += zs
        p2 -= 2 * dy
      }
      p1 += 2 * dx
      p2 += 2 * dz
      pointParams.x = x1
      pointParams.y = y1
      pointParams.z = z1
      drawPoint(pointParams)
    }
  } else {
    let p1 = 2 * dy - dz
    let p2 = 2 * dx - dz
    while (z1 !== z2) {
      z1 += zs
      if (p1 >= 0) {
        y1 += ys
        p1 -= 2 * dz
      }
      if (p2 >= 0) {
        x1 += xs
        p2 -= 2 * dz
      }
      p1 += 2 * dy
      p2 += 2 * dx
      pointParams.x = x1
      pointParams.y = y1
      pointParams.z = z1
      drawPoint(pointParams)
    }
  }
}

export function floodFillSection(params: FloodFillSectionParams): void {
  const { img2D, dims2D, minPt, maxPt } = params

  const w = dims2D[0]
  const [minX, minY] = minPt
  const [maxX, maxY] = maxPt

  const capacity = (maxX - minX + 1) * (maxY - minY + 1)
  const queue = new Int32Array(capacity * 2)
  let head = 0
  let tail = 0

  function enqueue(x: number, y: number): void {
    if (x < minX || x > maxX || y < minY || y > maxY) return
    const idx = x + y * w
    if (img2D[idx] !== 0) return
    img2D[idx] = 2
    queue[tail] = x
    queue[tail + 1] = y
    tail = (tail + 2) % queue.length
  }

  function dequeue(): [number, number] | null {
    if (head === tail) return null
    const x = queue[head]
    const y = queue[head + 1]
    head = (head + 2) % queue.length
    return [x, y]
  }

  for (let x = minX; x <= maxX; x++) {
    enqueue(x, minY)
    enqueue(x, maxY)
  }
  for (let y = minY + 1; y <= maxY - 1; y++) {
    enqueue(minX, y)
    enqueue(maxX, y)
  }

  let pt: [number, number] | null = dequeue()
  while (pt !== null) {
    const [x, y] = pt
    enqueue(x - 1, y)
    enqueue(x + 1, y)
    enqueue(x, y - 1)
    enqueue(x, y + 1)
    pt = dequeue()
  }
}

function drawLine2D(
  img2D: Uint8Array,
  dims2D: number[],
  ptA: number[],
  ptB: number[],
  pen: number,
): void {
  const dx = Math.abs(ptA[0] - ptB[0])
  const dy = Math.abs(ptA[1] - ptB[1])

  img2D[ptA[0] + ptA[1] * dims2D[0]] = pen
  img2D[ptB[0] + ptB[1] * dims2D[0]] = pen

  const xs = ptB[0] > ptA[0] ? 1 : -1
  const ys = ptB[1] > ptA[1] ? 1 : -1

  let x1 = ptA[0]
  let y1 = ptA[1]
  const x2 = ptB[0]
  const y2 = ptB[1]

  if (dx >= dy) {
    let p1 = 2 * dy - dx
    while (x1 !== x2) {
      x1 += xs
      if (p1 >= 0) {
        y1 += ys
        p1 -= 2 * dx
      }
      p1 += 2 * dy
      img2D[x1 + y1 * dims2D[0]] = pen
    }
  } else {
    let p1 = 2 * dx - dy
    while (y1 !== y2) {
      y1 += ys
      if (p1 >= 0) {
        x1 += xs
        p1 -= 2 * dy
      }
      p1 += 2 * dx
      img2D[x1 + y1 * dims2D[0]] = pen
    }
  }
}

function constrainXY(xy: number[], dims2D: number[]): number[] {
  const x = Math.min(Math.max(xy[0], 0), dims2D[0] - 1)
  const y = Math.min(Math.max(xy[1], 0), dims2D[1] - 1)
  return [x, y]
}

export function getSliceIndices(axCorSag: number): [number, number] {
  let h = 0
  let v = 1
  if (axCorSag === 1) {
    v = 2
  } else if (axCorSag === 2) {
    h = 1
    v = 2
  }
  return [h, v]
}

export function drawPenFilled(
  params: DrawPenFilledParams,
): DrawPenFilledResult {
  const {
    penFillPts,
    penAxCorSag,
    drawBitmap,
    dims,
    penValue,
    fillOverwrites,
    currentUndoBitmap,
  } = params

  const nPts = penFillPts.length
  if (nPts < 2) {
    return { drawBitmap, success: false }
  }

  const [h, v] = getSliceIndices(penAxCorSag)
  const dims2D = [dims[h + 1], dims[v + 1]]
  const img2D = new Uint8Array(dims2D[0] * dims2D[1])
  const pen = 1

  const startPt = constrainXY([penFillPts[0][h], penFillPts[0][v]], dims2D)
  let minPt = [...startPt]
  let maxPt = [...startPt]
  let prevPt = startPt

  for (let i = 1; i < nPts; i++) {
    let pt = [penFillPts[i][h], penFillPts[i][v]]
    pt = constrainXY(pt, dims2D)
    minPt = [Math.min(pt[0], minPt[0]), Math.min(pt[1], minPt[1])]
    maxPt = [Math.max(pt[0], maxPt[0]), Math.max(pt[1], maxPt[1])]
    drawLine2D(img2D, dims2D, prevPt, pt, pen)
    prevPt = pt
  }

  drawLine2D(img2D, dims2D, startPt, prevPt, pen)

  const pad = 1
  minPt[0] = Math.max(0, minPt[0] - pad)
  minPt[1] = Math.max(0, minPt[1] - pad)
  maxPt[0] = Math.min(dims2D[0] - 1, maxPt[0] + pad)
  maxPt[1] = Math.min(dims2D[1] - 1, maxPt[1] + pad)

  for (let y = 0; y < dims2D[1]; y++) {
    for (let x = 0; x < dims2D[0]; x++) {
      if (x >= minPt[0] && x <= maxPt[0] && y >= minPt[1] && y <= maxPt[1]) {
        continue
      }
      const pxl = x + y * dims2D[0]
      if (img2D[pxl] !== 0) continue
      img2D[pxl] = 2
    }
  }

  const startTime = Date.now()
  floodFillSection({ img2D, dims2D, minPt, maxPt })
  log.debug(`FloodFill ${Date.now() - startTime}`)

  const slice = penFillPts[0][3 - (h + v)]
  const newDrawBitmap = new Uint8Array(drawBitmap)

  if (penAxCorSag === 0) {
    const offset = slice * dims2D[0] * dims2D[1]
    for (let i = 0; i < dims2D[0] * dims2D[1]; i++) {
      if (img2D[i] !== 2) {
        newDrawBitmap[i + offset] = penValue
      }
    }
  } else {
    let xStride = 1
    const yStride = dims[1] * dims[2]
    let zOffset = slice * dims[1]

    if (penAxCorSag === 2) {
      xStride = dims[1]
      zOffset = slice
    }

    let i = 0
    for (let y = 0; y < dims2D[1]; y++) {
      for (let x = 0; x < dims2D[0]; x++) {
        if (img2D[i] !== 2) {
          newDrawBitmap[x * xStride + y * yStride + zOffset] = penValue
        }
        i++
      }
    }
  }

  if (!fillOverwrites && currentUndoBitmap && currentUndoBitmap.length > 0) {
    const nv = newDrawBitmap.length
    const bmp = decodeRLE(currentUndoBitmap, nv)
    for (let i = 0; i < nv; i++) {
      if (bmp[i] === 0) continue
      newDrawBitmap[i] = bmp[i]
    }
  }

  return { drawBitmap: newDrawBitmap, success: true }
}

export function isSamePoint(ptA: number[], ptB: number[]): boolean {
  return ptA[0] === ptB[0] && ptA[1] === ptB[1] && ptA[2] === ptB[2]
}
