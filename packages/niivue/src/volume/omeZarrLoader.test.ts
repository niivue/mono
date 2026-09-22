import { describe, expect, test } from 'bun:test'
import {
  defaultOmeZarrLevel,
  omeZarrBlockToDisplay,
  omeZarrChannelColormap,
  omeZarrChannelName,
  omeZarrVolumesFrom,
  openOmeZarr,
} from './omeZarrLoader'

/**
 * In-memory Zarr v2 stores: raw (uncompressed) little-endian arrays in one
 * chunk per level, which is all zarrita needs to exercise the whole read
 * path without a network or a codec.
 */

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function zarray(shape: number[], dtype: string): Uint8Array {
  return jsonBytes({
    zarr_format: 2,
    shape,
    chunks: shape,
    dtype,
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
  })
}

/**
 * A 5D tczyx store: t=2, c=2, z=2, y=3, x=4 uint16, plus a coarse level.
 * Every voxel encodes its own coordinates, so a load proves exactly which
 * hyperslab was read and in which order it was laid out.
 */
function makeTczyxStore(): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>()
  store.set('/.zgroup', jsonBytes({ zarr_format: 2 }))
  store.set(
    '/.zattrs',
    jsonBytes({
      multiscales: [
        {
          version: '0.4',
          axes: [
            { name: 't', type: 'time' },
            { name: 'c', type: 'channel' },
            { name: 'z', type: 'space', unit: 'micrometer' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [
            {
              path: '0',
              coordinateTransformations: [
                { type: 'scale', scale: [1, 1, 2, 0.5, 0.5] },
              ],
            },
            {
              path: '1',
              coordinateTransformations: [
                { type: 'scale', scale: [1, 1, 2, 1, 1] },
              ],
            },
          ],
        },
      ],
      omero: {
        channels: [
          {
            label: 'nuclei',
            color: '00FF00',
            window: { start: 0, end: 1500, min: 0, max: 65535 },
          },
          {
            label: 'membrane',
            color: 'FF0000',
            window: { start: 100, end: 3000, min: 0, max: 65535 },
          },
        ],
      },
    }),
  )

  const fine = new Uint16Array(2 * 2 * 2 * 3 * 4)
  let i = 0
  for (let t = 0; t < 2; t++) {
    for (let c = 0; c < 2; c++) {
      for (let z = 0; z < 2; z++) {
        for (let y = 0; y < 3; y++) {
          for (let x = 0; x < 4; x++) {
            fine[i] = t * 10000 + c * 1000 + z * 100 + y * 10 + x
            i += 1
          }
        }
      }
    }
  }
  store.set('/0/.zarray', zarray([2, 2, 2, 3, 4], '<u2'))
  store.set('/0/0.0.0.0.0', new Uint8Array(fine.buffer))

  const coarse = new Uint16Array(2 * 2 * 1 * 2 * 2)
  store.set('/1/.zarray', zarray([2, 2, 1, 2, 2], '<u2'))
  store.set('/1/0.0.0.0.0', new Uint8Array(coarse.buffer))
  return store
}

/** A 3D store whose axes are declared x, y, z, the Human Organ Atlas way. */
function makeXyzStore(): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>()
  store.set('/.zgroup', jsonBytes({ zarr_format: 2 }))
  store.set(
    '/.zattrs',
    jsonBytes({
      multiscales: [
        {
          version: '0.4',
          axes: [
            { name: 'x', type: 'space', unit: 'micrometer' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'z', type: 'space', unit: 'micrometer' },
          ],
          datasets: [
            {
              path: '0',
              coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }],
            },
          ],
        },
      ],
    }),
  )
  // C order over declared (x, y, z): z varies fastest in storage.
  const data = new Uint16Array(2 * 3 * 4)
  let i = 0
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 4; z++) {
        data[i] = x * 100 + y * 10 + z
        i += 1
      }
    }
  }
  store.set('/0/.zarray', zarray([2, 3, 4], '<u2'))
  store.set('/0/0.0.0', new Uint8Array(data.buffer))
  return store
}

/** The voxel payload of a produced NIfTI `File` (352-byte header assumed). */
async function fileVoxels(file: File): Promise<Uint16Array> {
  const buffer = await file.arrayBuffer()
  return new Uint16Array(buffer.slice(352))
}

describe('openOmeZarr', () => {
  test('describes the pyramid in display terms', async () => {
    const source = await openOmeZarr(makeTczyxStore())
    expect(source.levels).toHaveLength(2)
    expect(source.channelCount).toBe(2)
    expect(source.timepointCount).toBe(2)
    expect(source.levels[0].dtype).toBe('uint16')
    expect(source.levels[0].dims).toEqual([4, 3, 2])
    expect(source.levels[0].spacingUm).toEqual([0.5, 0.5, 2])
    expect(source.levels[0].channelBytes).toBe(4 * 3 * 2 * 2)
    expect(source.levels[1].dims).toEqual([2, 2, 1])
    expect(omeZarrChannelName(source, 0)).toBe('nuclei')
    expect(omeZarrChannelName(source, 1)).toBe('membrane')
    expect(omeZarrChannelColormap(source.info, 0, 0)).toBe('green')
    expect(omeZarrChannelColormap(source.info, 1, 1)).toBe('red')
  })

  test('rejects a store whose root is an array', async () => {
    const store = new Map<string, Uint8Array>()
    store.set('/.zarray', zarray([2, 2], '<u2'))
    store.set('/0.0', new Uint8Array(8))
    await expect(openOmeZarr(store)).rejects.toThrow('not a group')
  })
})

describe('openOmeZarr level selection', () => {
  test('opens only the requested dataset indices, keeping their labels', async () => {
    const source = await openOmeZarr(makeTczyxStore(), { levels: [1] })
    expect(source.levels).toHaveLength(1)
    expect(source.levels[0].datasetIndex).toBe(1)
    expect(source.levels[0].dims).toEqual([2, 2, 1])
    expect(() => source.levels[0]).not.toThrow()
    await expect(
      openOmeZarr(makeTczyxStore(), { levels: [7] }),
    ).rejects.toThrow('level 7 is out of range')
  })

  test('a missing level throws unless ignoreMissingLevels is set', async () => {
    const store = makeTczyxStore()
    store.delete('/1/.zarray')
    await expect(openOmeZarr(store)).rejects.toThrow()
    const source = await openOmeZarr(store, { ignoreMissingLevels: true })
    expect(source.levels.map((l) => l.datasetIndex)).toEqual([0])
    store.delete('/0/.zarray')
    await expect(
      openOmeZarr(store, { ignoreMissingLevels: true }),
    ).rejects.toThrow('none of the requested levels are present')
  })

  test('a v2 store is opened version-pinned, with no v3 probes per level', async () => {
    const backing = makeTczyxStore()
    const reads: string[] = []
    const counting = {
      get(key: `/${string}`): Uint8Array | undefined {
        reads.push(key)
        return backing.get(key)
      },
    }
    await openOmeZarr(counting)
    // The root pays one v3 probe; the level arrays must not.
    expect(reads.filter((k) => k.endsWith('zarr.json'))).toEqual(['/zarr.json'])
  })
})

describe('omeZarrVolumesFrom', () => {
  test('loads every channel with its label, colormap and window', async () => {
    const source = await openOmeZarr(makeTczyxStore())
    const volumes = await omeZarrVolumesFrom(source)
    expect(volumes).toHaveLength(2)
    expect(volumes[0].name).toBe('nuclei')
    expect(volumes[0].colormap).toBe('green')
    expect(volumes[0].calMin).toBe(0)
    expect(volumes[0].calMax).toBe(1500)
    expect(volumes[1].name).toBe('membrane')
    expect(volumes[1].calMin).toBe(100)

    const file = volumes[0].url as File
    expect(file.name).toBe('nuclei.nii')
    const voxels = await fileVoxels(file)
    expect(voxels).toHaveLength(4 * 3 * 2)
    // x-fastest layout of channel 0, timepoint 0.
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 4; x++) {
          expect(voxels[x + y * 4 + z * 12]).toBe(z * 100 + y * 10 + x)
        }
      }
    }
  })

  test('pins the requested channel and timepoint', async () => {
    const source = await openOmeZarr(makeTczyxStore())
    const volumes = await omeZarrVolumesFrom(source, {
      channels: [1],
      timepoint: 1,
    })
    expect(volumes).toHaveLength(1)
    // Requested channel 1 is first in the list, so it takes palette entry 0.
    expect(volumes[0].colormap).toBe('red')
    const voxels = await fileVoxels(volumes[0].url as File)
    expect(voxels[0]).toBe(11000)
    expect(voxels[4 * 3 * 2 - 1]).toBe(11000 + 100 + 20 + 3)
  })

  test('honours an explicit level and the budget default', async () => {
    const source = await openOmeZarr(makeTczyxStore())
    expect(defaultOmeZarrLevel(source)).toBe(0)
    expect(defaultOmeZarrLevel(source, source.levels[0].channelBytes - 1)).toBe(
      1,
    )
    const volumes = await omeZarrVolumesFrom(source, { level: 1 })
    const voxels = await fileVoxels(volumes[0].url as File)
    expect(voxels).toHaveLength(2 * 2)
  })

  test('falls back to the coarsest level when nothing fits the budget', async () => {
    const source = await openOmeZarr(makeTczyxStore())
    expect(defaultOmeZarrLevel(source, 0)).toBe(1)
  })

  test('skips levels with an unknown decoded size', async () => {
    const source = await openOmeZarr(makeTczyxStore())
    // A level whose channelBytes could not be computed must not be chosen
    // just because 0 fits any budget.
    const patched = {
      ...source,
      levels: source.levels.map((level, i) =>
        i === 0 ? { ...level, channelBytes: 0 } : level,
      ),
    }
    expect(defaultOmeZarrLevel(patched, Number.MAX_SAFE_INTEGER)).toBe(1)
  })

  test('validates channel, timepoint and level before any read', async () => {
    const source = await openOmeZarr(makeTczyxStore())
    await expect(omeZarrVolumesFrom(source, { channels: [2] })).rejects.toThrow(
      'channel 2 is out of range',
    )
    await expect(omeZarrVolumesFrom(source, { timepoint: 2 })).rejects.toThrow(
      'timepoint 2 is out of range',
    )
    await expect(omeZarrVolumesFrom(source, { level: 5 })).rejects.toThrow(
      'level 5 is out of range',
    )
  })

  test('transposes an x y z-ordered store to x-fastest layout', async () => {
    const source = await openOmeZarr(makeXyzStore())
    expect(source.channelCount).toBe(1)
    expect(source.levels[0].dims).toEqual([2, 3, 4])
    const volumes = await omeZarrVolumesFrom(source)
    expect(volumes[0].name).toBe('Channel 1')
    const voxels = await fileVoxels(volumes[0].url as File)
    for (let z = 0; z < 4; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 2; x++) {
          expect(voxels[x + y * 2 + z * 6]).toBe(x * 100 + y * 10 + z)
        }
      }
    }
  })

  test('a sparse store reads absent chunks as the fill value', async () => {
    const store = new Map<string, Uint8Array>()
    store.set('/.zgroup', jsonBytes({ zarr_format: 2 }))
    store.set(
      '/.zattrs',
      jsonBytes({
        multiscales: [
          {
            version: '0.4',
            axes: [
              { name: 'z', type: 'space' },
              { name: 'y', type: 'space' },
              { name: 'x', type: 'space' },
            ],
            datasets: [
              {
                path: '0',
                coordinateTransformations: [
                  { type: 'scale', scale: [1, 1, 1] },
                ],
              },
            ],
          },
        ],
      }),
    )
    // 4x2x2 in 2x2x2 chunks: two chunks along z, only the first stored.
    // Sparse stores lean on zarr's absent-chunk-means-fill-value convention
    // (the stag beetle's finest level omits 121 of 256 chunks), and the fill
    // value is deliberately nonzero so a zero-filled default cannot pass.
    store.set(
      '/0/.zarray',
      jsonBytes({
        zarr_format: 2,
        shape: [4, 2, 2],
        chunks: [2, 2, 2],
        dtype: '<u2',
        compressor: null,
        fill_value: 7,
        order: 'C',
        filters: null,
      }),
    )
    store.set(
      '/0/0.0.0',
      new Uint8Array(new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer),
    )
    const volumes = await omeZarrVolumesFrom(await openOmeZarr(store))
    const voxels = await fileVoxels(volumes[0].url as File)
    expect([...voxels.slice(0, 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...voxels.slice(8)]).toEqual([7, 7, 7, 7, 7, 7, 7, 7])
  })

  test('rejects an unsupported dtype', async () => {
    const store = makeXyzStore()
    store.set('/0/.zarray', zarray([2, 3, 4], '<i8'))
    const source = await openOmeZarr(store)
    await expect(omeZarrVolumesFrom(source)).rejects.toThrow(
      "dtype 'int64' is not supported",
    )
  })
})

describe('omeZarrBlockToDisplay', () => {
  test('passes a z y x block through without copying', () => {
    const data = new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7])
    const { img, dims } = omeZarrBlockToDisplay(data, [2, 2, 2], [4, 2, 1], {
      x: 2,
      y: 1,
      z: 0,
    })
    expect(img).toBe(data)
    expect(dims).toEqual([2, 2, 2])
  })

  test('flattens a 2D block into a single-slice volume', () => {
    const data = new Uint16Array([0, 1, 2, 3, 4, 5])
    const { img, dims } = omeZarrBlockToDisplay(data, [2, 3], [3, 1], {
      x: 1,
      y: 0,
      z: -1,
    })
    expect(img).toBe(data)
    expect(dims).toEqual([3, 2, 1])
  })
})
