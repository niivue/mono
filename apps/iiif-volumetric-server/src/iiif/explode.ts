// Exploded-view composition.

import type {
  Shape3,
  Vec3,
  VolumeHandle,
  VoxelArray,
} from '../adapters/volumeHandle.ts'
import { HttpError } from '../util/http.ts'

const MAX_VOXELS = 200_000_000

export type Bbox6 = [number, number, number, number, number, number]

export interface ExplodeParams {
  nx?: number | string
  ny?: number | string
  nz?: number | string
  explode?: number | string
  ex?: number | string
  ey?: number | string
  ez?: number | string
}

export interface NormalizedExplodeParams {
  nx: number
  ny: number
  nz: number
  ex: number
  ey: number
  ez: number
}

export interface ExplodeCell {
  i: number
  j: number
  k: number
  sourceBbox: Bbox6
  compositeOrigin: [number, number, number]
  sceneCenter: [number, number, number]
}

export interface ExplodeLayout {
  cellShape: [number, number, number]
  compositeShape: [number, number, number]
  compositeSpacing: Vec3
  cells: ExplodeCell[]
  params: NormalizedExplodeParams
}

export function planExplodedView(
  volume: VolumeHandle,
  params: ExplodeParams,
): ExplodeLayout {
  const { nx, ny, nz, ex, ey, ez } = normalizeParams(params)
  const [sx, sy, sz] = volume.shape
  const cx = Math.floor(sx / nx)
  const cy = Math.floor(sy / ny)
  const cz = Math.floor(sz / nz)
  if (cx < 1 || cy < 1 || cz < 1) {
    throw new HttpError(
      400,
      `Grid ${nx}×${ny}×${nz} is finer than source shape ${sx}×${sy}×${sz}; cell would be empty.`,
    )
  }

  interface Placement {
    i: number
    j: number
    k: number
    sourceBbox: Bbox6
    explodedOrigin: [number, number, number]
  }
  const placements: Placement[] = []
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const naturalCenter: [number, number, number] = [
          (i + 0.5) * cx,
          (j + 0.5) * cy,
          (k + 0.5) * cz,
        ]
        const gridCenter: [number, number, number] = [
          (nx * cx) / 2,
          (ny * cy) / 2,
          (nz * cz) / 2,
        ]
        const explodedCenter: [number, number, number] = [
          gridCenter[0] + ex * (naturalCenter[0] - gridCenter[0]),
          gridCenter[1] + ey * (naturalCenter[1] - gridCenter[1]),
          gridCenter[2] + ez * (naturalCenter[2] - gridCenter[2]),
        ]
        const explodedOrigin: [number, number, number] = [
          Math.round(explodedCenter[0] - cx / 2),
          Math.round(explodedCenter[1] - cy / 2),
          Math.round(explodedCenter[2] - cz / 2),
        ]
        const sourceBbox: Bbox6 = [
          i * cx,
          j * cy,
          k * cz,
          i * cx + cx,
          j * cy + cy,
          k * cz + cz,
        ]
        placements.push({ i, j, k, sourceBbox, explodedOrigin })
      }
    }
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  for (const p of placements) {
    if (p.explodedOrigin[0] < minX) minX = p.explodedOrigin[0]
    if (p.explodedOrigin[1] < minY) minY = p.explodedOrigin[1]
    if (p.explodedOrigin[2] < minZ) minZ = p.explodedOrigin[2]
  }

  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  const cells: ExplodeCell[] = placements.map((p) => {
    const o: [number, number, number] = [
      p.explodedOrigin[0] - minX,
      p.explodedOrigin[1] - minY,
      p.explodedOrigin[2] - minZ,
    ]
    if (o[0] + cx > maxX) maxX = o[0] + cx
    if (o[1] + cy > maxY) maxY = o[1] + cy
    if (o[2] + cz > maxZ) maxZ = o[2] + cz
    const sceneCenter: [number, number, number] = [
      (o[0] + cx / 2) * (volume.spacing[0] || 1),
      (o[1] + cy / 2) * (volume.spacing[1] || 1),
      (o[2] + cz / 2) * (volume.spacing[2] || 1),
    ]
    return {
      i: p.i,
      j: p.j,
      k: p.k,
      sourceBbox: p.sourceBbox,
      compositeOrigin: o,
      sceneCenter,
    }
  })

  const compositeShape: [number, number, number] = [maxX, maxY, maxZ]
  const totalVoxels = compositeShape[0] * compositeShape[1] * compositeShape[2]
  if (totalVoxels > MAX_VOXELS) {
    throw new HttpError(
      413,
      `Exploded composite would be ${compositeShape.join(
        '×',
      )} = ${totalVoxels.toLocaleString()} voxels (max ${MAX_VOXELS.toLocaleString()}). Reduce nx/ny/nz or explode.`,
    )
  }

  return {
    cellShape: [cx, cy, cz],
    compositeShape,
    compositeSpacing: volume.spacing,
    cells,
    params: { nx, ny, nz, ex, ey, ez },
  }
}

export function composeExplodedBuffer(
  volume: VolumeHandle,
  layout: ExplodeLayout,
): VoxelArray {
  const [sx, sy] = volume.shape
  const [Cx, Cy, Cz] = layout.compositeShape
  const [_cx, cy, cz] = layout.cellShape

  const colorBytes =
    volume.dtype === 'rgb24' ? 3 : volume.dtype === 'rgba32' ? 4 : 0
  const elemsPerVoxel = colorBytes || 1
  const TypedArrayCtor = volume.data.constructor as {
    new (length: number): VoxelArray
  }
  const out = new TypedArrayCtor(Cx * Cy * Cz * elemsPerVoxel)

  if (colorBytes === 0) {
    const { min } = volume.intensityRange()
    ;(out as { fill: (v: number) => void }).fill(min)
  }

  for (const cell of layout.cells) {
    const [x0, y0, z0, _x1, _y1, _z1] = cell.sourceBbox
    const cw = cell.sourceBbox[3] - cell.sourceBbox[0]
    const [ox, oy, oz] = cell.compositeOrigin
    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        const srcVox = x0 + (y0 + y) * sx + (z0 + z) * sx * sy
        const dstVox = ox + (oy + y) * Cx + (oz + z) * Cx * Cy
        const srcStart = srcVox * elemsPerVoxel
        const dstStart = dstVox * elemsPerVoxel
        const len = cw * elemsPerVoxel
        ;(out as { set: (src: VoxelArray, off: number) => void }).set(
          volume.data.subarray(srcStart, srcStart + len) as VoxelArray,
          dstStart,
        )
      }
    }
  }
  return out
}

function normalizeParams(p: ExplodeParams): NormalizedExplodeParams {
  const nx = clampInt(p.nx, 1, 10, 'nx')
  const ny = clampInt(p.ny, 1, 10, 'ny')
  const nz = clampInt(p.nz, 1, 10, 'nz')
  if (nx * ny * nz > 125) {
    throw new HttpError(
      400,
      `Grid ${nx}×${ny}×${nz} = ${nx * ny * nz} cells exceeds the POC cap of 125`,
    )
  }
  let baseExplode = Number(p.explode)
  if (!Number.isFinite(baseExplode)) baseExplode = 1.5

  const ex = clampExplode(p.ex ?? baseExplode)
  const ey = clampExplode(p.ey ?? baseExplode)
  const ez = clampExplode(p.ez ?? baseExplode)

  return { nx, ny, nz, ex, ey, ez }
}

function clampExplode(v: number | string): number {
  let n = Number(v)
  if (!Number.isFinite(n)) n = 1.5
  if (n < 1) n = 1
  if (n > 5) n = 5
  return n
}

function clampInt(
  v: number | string | undefined,
  lo: number,
  hi: number,
  name: string,
): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < lo || n > hi) {
    throw new HttpError(400, `${name} must be an integer in [${lo}, ${hi}]`)
  }
  return n
}

export type Shape3Mutable = [number, number, number]
export type { Shape3, Vec3 }
