// Coarse occupancy grid: per macroblock, 0 if every voxel equals the
// background, 1 otherwise.

import type { VolumeHandle } from '../adapters/volumeHandle.ts'

export interface OccupancyGrid {
  data: Uint8Array
  dims: [number, number, number]
  blockSize: number
}

export function computeOccupancyGrid(
  volume: VolumeHandle,
  blockSize: number,
  background: number,
): OccupancyGrid {
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new Error(`blockSize must be a positive integer, got ${blockSize}`)
  }
  const [sx, sy, sz] = volume.shape
  const nx = Math.ceil(sx / blockSize)
  const ny = Math.ceil(sy / blockSize)
  const nz = Math.ceil(sz / blockSize)
  const out = new Uint8Array(nx * ny * nz)
  const data = volume.data
  const colorBytes =
    volume.dtype === 'rgb24' ? 3 : volume.dtype === 'rgba32' ? 4 : 0

  for (let bz = 0; bz < nz; bz++) {
    const z0 = bz * blockSize
    const z1 = Math.min(z0 + blockSize, sz)
    for (let by = 0; by < ny; by++) {
      const y0 = by * blockSize
      const y1 = Math.min(y0 + blockSize, sy)
      for (let bx = 0; bx < nx; bx++) {
        const x0 = bx * blockSize
        const x1 = Math.min(x0 + blockSize, sx)
        let occupied = 0
        outer: for (let z = z0; z < z1; z++) {
          for (let y = y0; y < y1; y++) {
            const rowBase = y * sx + z * sx * sy
            for (let x = x0; x < x1; x++) {
              if (colorBytes === 0) {
                if ((data[rowBase + x] as number) !== background) {
                  occupied = 1
                  break outer
                }
              } else {
                const off = (rowBase + x) * colorBytes
                for (let c = 0; c < colorBytes; c++) {
                  if ((data[off + c] as number) !== background) {
                    occupied = 1
                    break outer
                  }
                }
              }
            }
          }
        }
        out[bx + by * nx + bz * nx * ny] = occupied
      }
    }
  }

  return { data: out, dims: [nx, ny, nz], blockSize }
}
