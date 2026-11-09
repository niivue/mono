import { describe, expect, test } from 'bun:test'

import { VolumeHandle } from '../src/adapters/volumeHandle.ts'
import { downsampleVolume } from '../src/util/downsample.ts'

// Independent reference: box mean per channel over full factor^3 blocks.
function reference(
  data: Uint8Array,
  [sx, sy, sz]: number[],
  nc: number,
  f: number,
): Uint8Array {
  const [nx, ny, nz] = [sx, sy, sz].map((s) => Math.floor(s / f))
  const out = new Uint8Array(nx * ny * nz * nc)
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        for (let c = 0; c < nc; c++) {
          let sum = 0
          for (let k = 0; k < f; k++)
            for (let j = 0; j < f; j++)
              for (let i = 0; i < f; i++)
                sum +=
                  data[
                    (x * f + i + (y * f + j) * sx + (z * f + k) * sx * sy) *
                      nc +
                      c
                  ]
          out[(x + y * nx + z * nx * ny) * nc + c] = Math.round(sum / f ** 3)
        }
  return out
}

function colorVolume(
  shape: [number, number, number],
  nc: 3 | 4,
  fill?: number,
) {
  const data = new Uint8Array(shape[0] * shape[1] * shape[2] * nc)
  let s = 12345
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    data[i] = fill ?? s >>> 24
  }
  return new VolumeHandle({
    shape,
    spacing: [0.5, 1, 2],
    dtype: nc === 4 ? 'rgba32' : 'rgb24',
    data,
    units: 'mm',
    sclSlope: 2,
    sclInter: 3,
    metadata: { source: 'test' },
  })
}

describe('downsampleVolume color', () => {
  for (const nc of [3, 4] as const)
    for (const factor of [2, 3])
      test(`${nc === 4 ? 'RGBA' : 'RGB'} factor ${factor}, odd dims`, () => {
        const vol = colorVolume([7, 9, 5], nc)
        const down = downsampleVolume(vol, factor)
        const n = [7, 9, 5].map((s) => Math.floor(s / factor))
        expect(down.shape).toEqual(n as [number, number, number])
        expect(down.data).toBeInstanceOf(Uint8Array)
        expect(Array.from(down.data)).toEqual(
          Array.from(reference(vol.data as Uint8Array, [7, 9, 5], nc, factor)),
        )
        expect(down.dtype).toBe(vol.dtype)
        expect(down.spacing).toEqual([0.5 * factor, factor, 2 * factor])
        expect(down.units).toBe('mm')
        expect(down.sclSlope).toBe(2)
        expect(down.sclInter).toBe(3)
        expect(down.metadata).toEqual({ source: 'test', downsampled: factor })
      })

  test('channel extremes stay exact', () => {
    for (const fill of [0, 255])
      for (const nc of [3, 4] as const) {
        const down = downsampleVolume(colorVolume([4, 4, 4], nc, fill), 2)
        expect(down.data.every((v) => v === fill)).toBe(true)
      }
  })

  test('alpha averages independently of RGB', () => {
    const vol = colorVolume([2, 2, 2], 4, 0)
    const d = vol.data as Uint8Array
    for (let v = 0; v < 8; v++) d[v * 4 + 3] = v < 4 ? 255 : 0
    expect(Array.from(downsampleVolume(vol, 2).data)).toEqual([0, 0, 0, 128])
  })
})
