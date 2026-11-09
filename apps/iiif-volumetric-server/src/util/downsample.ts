import type { Shape3, Vec3, VoxelArray } from '../adapters/volumeHandle.ts'
import { VolumeHandle } from '../adapters/volumeHandle.ts'

export function downsampleVolume(
  volume: VolumeHandle,
  factor = 2,
): VolumeHandle {
  const [sx, sy, sz] = volume.shape
  const [dx, dy, dz] = volume.spacing
  const [nx, ny, nz] = [
    Math.floor(sx / factor),
    Math.floor(sy / factor),
    Math.floor(sz / factor),
  ]

  if (nx < 1 || ny < 1 || nz < 1) {
    throw new Error('Volume is too small to downsample further')
  }

  const colorBytes =
    volume.dtype === 'rgb24' ? 3 : volume.dtype === 'rgba32' ? 4 : 0
  const isColor = colorBytes > 0
  const TypedArrayCtor = volume.data.constructor as {
    new (length: number): VoxelArray
  }
  const out = new TypedArrayCtor(nx * ny * nz * (colorBytes || 1))

  const f3 = factor * factor * factor
  const isFloat =
    TypedArrayCtor === Float32Array || TypedArrayCtor === Float64Array

  if (!isColor) {
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          let sum = 0
          for (let bz = 0; z * factor + bz < sz && bz < factor; bz++) {
            for (let by = 0; y * factor + by < sy && by < factor; by++) {
              for (let bx = 0; x * factor + bx < sx && bx < factor; bx++) {
                const ix = x * factor + bx
                const iy = y * factor + by
                const iz = z * factor + bz
                sum += volume.data[ix + iy * sx + iz * sx * sy] as number
              }
            }
          }
          const val = sum / f3
          out[x + y * nx + z * nx * ny] = isFloat ? val : Math.round(val)
        }
      }
    }
  } else {
    // No edge checks: n = floor(s / factor) keeps every block inside.
    const data = volume.data
    const rgba = colorBytes === 4
    const sxy = sx * sy
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          let r = 0
          let g = 0
          let b = 0
          let a = 0
          for (let bz = 0; bz < factor; bz++) {
            for (let by = 0; by < factor; by++) {
              const row = (y * factor + by) * sx + (z * factor + bz) * sxy
              for (let bx = 0; bx < factor; bx++) {
                const off = (x * factor + bx + row) * colorBytes
                r += data[off] as number
                g += data[off + 1] as number
                b += data[off + 2] as number
                if (rgba) a += data[off + 3] as number
              }
            }
          }
          const dstOff = (x + y * nx + z * nx * ny) * colorBytes
          out[dstOff] = Math.round(r / f3)
          out[dstOff + 1] = Math.round(g / f3)
          out[dstOff + 2] = Math.round(b / f3)
          if (rgba) out[dstOff + 3] = Math.round(a / f3)
        }
      }
    }
  }

  const newShape: Shape3 = [nx, ny, nz]
  const newSpacing: Vec3 = [dx * factor, dy * factor, dz * factor]
  return new VolumeHandle({
    shape: newShape,
    spacing: newSpacing,
    dtype: volume.dtype,
    data: out,
    units: volume.units,
    sclSlope: volume.sclSlope,
    sclInter: volume.sclInter,
    metadata: {
      ...volume.metadata,
      downsampled: factor,
    },
  })
}
