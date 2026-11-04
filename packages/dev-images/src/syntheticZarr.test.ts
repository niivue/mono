import { expect, test } from 'bun:test'
import { syntheticZarrFile } from './syntheticZarr'

const SMALL = 'synthetic-v1.ome.zarr/'
const OCT = 'synthetic-oct-v1.ome.zarr/'
const meta = (path: string) =>
  JSON.parse(
    new TextDecoder().decode(syntheticZarrFile(path) ?? new Uint8Array()),
  )
const chunk = (path: string) => {
  const bytes = syntheticZarrFile(path)
  if (!bytes) throw new Error(`miss: ${path}`)
  return new Float32Array(bytes.buffer)
}

test('copies the DANDI store geometry and misses unknown keys', () => {
  expect(meta(`${SMALL}0/.zarray`).shape).toEqual([301, 301, 301])
  expect(meta(`${SMALL}3/.zarray`).shape).toEqual([38, 38, 38])
  expect(syntheticZarrFile(`${SMALL}4/.zarray`)).toBeNull()
  expect(meta(`${OCT}0/.zarray`).shape).toEqual([561, 1470, 1716])
  expect(meta(`${OCT}5/.zarray`).shape).toEqual([18, 46, 54])
  expect(
    meta(`${OCT}.zattrs`).multiscales[0].datasets[1]
      .coordinateTransformations[0].scale[0],
  ).toBeCloseTo(0.039929, 5)
  expect(syntheticZarrFile('nope.ome.zarr/.zattrs')).toBeNull()
  expect(syntheticZarrFile(`${SMALL}0/5/0/0`)).toBeNull()
  expect(chunk(`${OCT}0/8/22/26`).length).toBe(64 ** 3)
  // Past the 301-voxel edge the last chunk is zero-padded.
  expect(chunk(`${SMALL}0/4/2/2`)[63 * 64 * 64 + 32 * 64 + 32]).toBe(0)
})

test('the finest level carries detail the next one lacks', () => {
  // Mean |gradient| along x through the centre, in value per mm.
  const roughness = (path: string, spacing: number) => {
    const c = chunk(path)
    const row = 32 * 4096 + 32 * 64
    let sum = 0
    for (let x = 1; x < 64; x++) sum += Math.abs(c[row + x] - c[row + x - 1])
    return sum / 63 / spacing
  }
  expect(roughness(`${SMALL}0/2/2/2`, 0.02)).toBeGreaterThan(
    1.5 * roughness(`${SMALL}1/1/1/1`, 0.0399),
  )
})
