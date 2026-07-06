import { log } from '@/logger'
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
  penAxCorSag: number
  penOverwrites?: boolean
}

export interface DrawLineParams {
  ptA: number[]
  ptB: number[]
  penValue: number
  drawBitmap: Uint8Array
  dims: number[]
  penSize: number
  penAxCorSag: number
  penOverwrites?: boolean
}

export interface FloodFillSectionParams {
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
  radius: number
  penValue: number
  drawBitmap: Uint8Array
  dims: number[] // NIfTI-style [ndim, dimX, dimY, dimZ]
  penOverwrites: boolean
}

/**
 * Paint a solid voxel ball of `radius` centred at (x,y,z). Unlike `drawPoint`
 * (a disk on a 2D slice plane), this is a true 3D brush — used when drawing
 * directly on a 3D render (e.g. exploded blocks), where there is no slice plane.
 * radius 0 paints a single voxel. Honors `penOverwrites` (skip non-zero voxels
 * when false and not erasing).
 */
export function drawSphere(params: DrawSphereParams): void {
  const dx = params.dims[1]
  const dy = params.dims[2]
  const dz = params.dims[3]
  const r = Math.max(0, Math.floor(params.radius))
  const skip = params.penOverwrites === false && params.penValue !== 0
  const r2 = r * r
  for (let kz = -r; kz <= r; kz++) {
    for (let ky = -r; ky <= r; ky++) {
      for (let kx = -r; kx <= r; kx++) {
        if (kx * kx + ky * ky + kz * kz > r2) continue
        const vx = params.x + kx
        const vy = params.y + ky
        const vz = params.z + kz
        if (vx < 0 || vy < 0 || vz < 0 || vx >= dx || vy >= dy || vz >= dz) {
          continue
        }
        const idx = voxelIndex(vx, vy, vz, dx, dy)
        if (skip && params.drawBitmap[idx] !== 0) continue
        params.drawBitmap[idx] = params.penValue
      }
    }
  }
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
  let filled = 0
  let hitCap = false
  while (stack.length > 0) {
    const z = stack.pop() as number
    const y = stack.pop() as number
    const x = stack.pop() as number
    const flat = voxelIndex(x, y, z, dx, dy)
    if (visited[flat]) continue
    visited[flat] = 1
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
    if (x + 1 < dx) stack.push(x + 1, y, z)
    if (x - 1 >= 0) stack.push(x - 1, y, z)
    if (y + 1 < dy) stack.push(x, y + 1, z)
    if (y - 1 >= 0) stack.push(x, y - 1, z)
    if (z + 1 < dz) stack.push(x, y, z + 1)
    if (z - 1 >= 0) stack.push(x, y, z - 1)
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

  const idx = voxelIndex(x, y, z, dx, dy)
  if (!skip || drawBitmap[idx] === 0) {
    drawBitmap[idx] = penValue
  }

  if (penSize > 1) {
    const halfPenSize = Math.floor(penSize / 2)
    const isAx = penAxCorSag === PEN_SLICE_TYPE.AXIAL
    const isCor = penAxCorSag === PEN_SLICE_TYPE.CORONAL
    const isSag = penAxCorSag === PEN_SLICE_TYPE.SAGITTAL

    for (let i = -halfPenSize; i <= halfPenSize; i++) {
      for (let j = -halfPenSize; j <= halfPenSize; j++) {
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
    penAxCorSag,
    penOverwrites,
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
    penAxCorSag,
    penOverwrites,
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

export function isPenLocationValid(penLocation: number[]): boolean {
  return !Number.isNaN(penLocation[0])
}

export function isSamePoint(ptA: number[], ptB: number[]): boolean {
  return ptA[0] === ptB[0] && ptA[1] === ptB[1] && ptA[2] === ptB[2]
}
