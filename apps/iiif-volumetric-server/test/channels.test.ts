// Multi-channel sources: one registry entry per channel, and each entry
// reading the RIGHT channel. These use synthetic fixtures written to a temp
// dir so the suite stays hermetic (the real Allen / IDR data is fetched on
// demand and not committed).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'

import { allenAtlasAdapter } from '../src/adapters/allenAtlas.ts'
import { omezarrAdapter } from '../src/adapters/omezarr.ts'

let tmpDir = ''

// Zarr v2, uint8, one chunk covering the whole array, no compressor — small
// enough to hand-write, which keeps the test free of a writer dependency.
async function writeZarr(
  dir: string,
  axes: Array<{ name: string; type: string; unit?: string }>,
  shape: number[],
  data: Uint8Array,
  omero?: unknown,
): Promise<void> {
  await fs.mkdir(path.join(dir, '0'), { recursive: true })
  await fs.writeFile(
    path.join(dir, '.zgroup'),
    JSON.stringify({ zarr_format: 2 }),
  )
  await fs.writeFile(
    path.join(dir, '.zattrs'),
    JSON.stringify({
      multiscales: [
        {
          version: '0.4',
          axes,
          datasets: [
            {
              path: '0',
              coordinateTransformations: [
                { type: 'scale', scale: shape.map(() => 1) },
              ],
            },
          ],
        },
      ],
      ...(omero === undefined ? {} : { omero }),
    }),
  )
  await fs.writeFile(
    path.join(dir, '0', '.zarray'),
    JSON.stringify({
      zarr_format: 2,
      shape,
      chunks: shape,
      dtype: '|u1',
      compressor: null,
      fill_value: 0,
      order: 'C',
      filters: null,
    }),
  )
  await fs.writeFile(path.join(dir, '0', shape.map(() => '0').join('.')), data)
}

// (C, Z, Y, X) = (3, 2, 3, 4); every voxel encodes its own channel so a
// mis-indexed read is unmistakable.
const C = 3
const Z = 2
const Y = 3
const X = 4

function channelVoxel(c: number, z: number, y: number, x: number): number {
  return c * 50 + z * 10 + y * 3 + x
}

function multiChannelData(): Uint8Array {
  const data = new Uint8Array(C * Z * Y * X)
  for (let c = 0; c < C; c++) {
    for (let z = 0; z < Z; z++) {
      for (let y = 0; y < Y; y++) {
        for (let x = 0; x < X; x++) {
          data[((c * Z + z) * Y + y) * X + x] = channelVoxel(c, z, y, x)
        }
      }
    }
  }
  return data
}

// Allen atlas: 2 Z slices in a 1x2 tile grid, 4 channels packed into one
// PNG's R/G/B/A planes.
const TILE = 2
const TILES = 2

function atlasPng(): Buffer {
  const png = new PNG({ width: TILE * TILES, height: TILE })
  for (let t = 0; t < TILES; t++) {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const idx = ((y * TILE * TILES + t * TILE + x) << 2) >>> 0
        for (let plane = 0; plane < 4; plane++) {
          png.data[idx + plane] = plane * 40 + t * 10 + y * 2 + x
        }
      }
    }
  }
  return PNG.sync.write(png)
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-channels-'))

  await writeZarr(
    path.join(tmpDir, 'multi.ome.zarr'),
    [
      { name: 'c', type: 'channel' },
      { name: 'z', type: 'space', unit: 'micrometer' },
      { name: 'y', type: 'space', unit: 'micrometer' },
      { name: 'x', type: 'space', unit: 'micrometer' },
    ],
    [C, Z, Y, X],
    multiChannelData(),
    { channels: [{ label: 'DAPI' }, { label: 'GFP' }] },
  )

  // A 2D store whose `c` axis falls INSIDE the trailing three dims: the
  // spatial mapping reads it as a spatial axis, so it must not be offered
  // for per-channel selection.
  await writeZarr(
    path.join(tmpDir, 'flat.ome.zarr'),
    [
      { name: 'c', type: 'channel' },
      { name: 'y', type: 'space', unit: 'micrometer' },
      { name: 'x', type: 'space', unit: 'micrometer' },
    ],
    [2, Y, X],
    new Uint8Array(2 * Y * X).fill(9),
    { channels: [{ label: 'DAPI' }, { label: 'GFP' }] },
  )

  await writeZarr(
    path.join(tmpDir, 'plain.ome.zarr'),
    [
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ],
    [Z, Y, X],
    new Uint8Array(Z * Y * X).fill(7),
  )

  const allenDir = path.join(tmpDir, 'allen')
  await fs.mkdir(allenDir, { recursive: true })
  await fs.writeFile(path.join(allenDir, 'tiny_atlas.png'), atlasPng())
  await fs.writeFile(
    path.join(allenDir, 'tiny_atlas.json'),
    JSON.stringify({
      width: TILE,
      height: TILE,
      tiles: TILES,
      channels: 4,
      channel_names: ['DNA', 'Membrane', 'Nucleoli', 'Mito'],
      rows: 1,
      cols: TILES,
      tile_width: TILE,
      tile_height: TILE,
      atlas_width: TILE * TILES,
      atlas_height: TILE,
      pixel_size_x: 0.5,
      pixel_size_y: 0.5,
      pixel_size_z: 2,
      pixel_size_unit: 'um',
      images: [{ name: 'tiny_atlas.png', channels: [0, 1, 2, 3] }],
    }),
  )
})

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('OME-Zarr channels', () => {
  test('probeChannels names the c axis, omero labels first', async () => {
    const dir = path.join(tmpDir, 'multi.ome.zarr')
    const channels = await omezarrAdapter.probeChannels?.(dir)
    // Only two omero labels for three channels: the unlabelled one still
    // needs a name or it cannot get an id.
    expect(channels).toEqual([
      { index: 0, name: 'DAPI' },
      { index: 1, name: 'GFP' },
      { index: 2, name: 'c2' },
    ])
  })

  test('a store with no channel axis reports no channels', async () => {
    const channels = await omezarrAdapter.probeChannels?.(
      path.join(tmpDir, 'plain.ome.zarr'),
    )
    expect(channels).toEqual([])
  })

  test('a channel axis inside the trailing spatial dims reports no channels', async () => {
    // A (c, y, x) 2D store: `c` is one of the trailing three dims, so it is
    // consumed as a spatial axis and cannot be selected per channel —
    // reporting channels here would mint N identical volumes.
    const channels = await omezarrAdapter.probeChannels?.(
      path.join(tmpDir, 'flat.ome.zarr'),
    )
    expect(channels).toEqual([])
  })

  test('load reads the requested channel, not always the first', async () => {
    const dir = path.join(tmpDir, 'multi.ome.zarr')
    for (let c = 0; c < C; c++) {
      const vol = await omezarrAdapter.load(dir, c)
      expect(vol.shape).toEqual([X, Y, Z])
      // Spot-check the corners of the 3D read against the source formula.
      expect(vol.data[0]).toBe(channelVoxel(c, 0, 0, 0))
      expect(vol.data[X * Y * Z - 1]).toBe(channelVoxel(c, Z - 1, Y - 1, X - 1))
      expect(vol.data[X + 1]).toBe(channelVoxel(c, 0, 1, 1))
    }
  })

  test('an out-of-range channel is rejected', async () => {
    const dir = path.join(tmpDir, 'multi.ome.zarr')
    expect(omezarrAdapter.load(dir, C)).rejects.toThrow(/out of range/)
  })

  test('loadSubvolume honours the channel too', async () => {
    const dir = path.join(tmpDir, 'multi.ome.zarr')
    const vol = await omezarrAdapter.loadSubvolume?.(
      dir,
      0,
      { x0: 1, y0: 0, z0: 0, x1: 3, y1: 2, z1: 1 },
      2,
    )
    expect(vol?.shape).toEqual([2, 2, 1])
    expect(vol?.data[0]).toBe(channelVoxel(2, 0, 0, 1))
  })
})

describe('Allen atlas channels', () => {
  const sidecar = () => path.join(tmpDir, 'allen', 'tiny_atlas.json')

  test('probeChannels lists every channel an image carries', async () => {
    expect(await allenAtlasAdapter.probeChannels?.(sidecar())).toEqual([
      { index: 0, name: 'DNA' },
      { index: 1, name: 'Membrane' },
      { index: 2, name: 'Nucleoli' },
      { index: 3, name: 'Mito' },
    ])
  })

  test('each channel deinterleaves its own colour plane', async () => {
    for (let plane = 0; plane < 4; plane++) {
      const vol = await allenAtlasAdapter.load(sidecar(), plane)
      expect(vol.shape).toEqual([TILE, TILE, TILES])
      // Voxel (x, y, z) came from tile z, pixel (x, y), colour plane `plane`.
      for (let z = 0; z < TILES; z++) {
        for (let y = 0; y < TILE; y++) {
          for (let x = 0; x < TILE; x++) {
            expect(vol.data[(z * TILE + y) * TILE + x]).toBe(
              plane * 40 + z * 10 + y * 2 + x,
            )
          }
        }
      }
    }
  })

  test('probe reports stored dims and rescaled spacing', async () => {
    const meta = await allenAtlasAdapter.probe(sidecar())
    expect(meta.shape).toEqual([TILE, TILE, TILES])
    expect(meta.dtype).toBe('uint8')
    // tile_width === width here, so spacing is the sidecar's pixel size.
    expect(meta.spacing).toEqual([0.5, 0.5, 2])
  })
})
