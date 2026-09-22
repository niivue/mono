import { describe, expect, test } from 'bun:test'
import type {
  ChunkedVolumeFetch,
  ChunkedVolumeSource,
} from '@/volume/ChunkedVolumeSource'
import type {
  NVSlideLevelManifest,
  NVSlideRangeEvent,
  NVSlideRangeStatus,
  SlideSourceHost,
} from './NVSlide'
import { VolumeSliceSource } from './volumeSliceSource'

const DT_UINT8 = 2
const DT_UINT16 = 512

/** A pyramid whose voxel value encodes its own (x, y, z) at that level. */
function fakeVolume(
  shapes: Array<[number, number, number]>,
  options: {
    datatypeCode?: number
    value?: (x: number, y: number, z: number, level: number) => number
    calls?: ChunkedVolumeFetch[]
    fail?: boolean
  } = {},
): ChunkedVolumeSource {
  const datatypeCode = options.datatypeCode ?? DT_UINT8
  const value = options.value ?? ((x, y, z) => x + y * 10 + z * 100)
  return {
    levels: shapes.map((shape, level) => ({
      level,
      shape: [...shape],
      spacing: [1, 1, 1],
    })),
    datatypeCode,
    async fetchChunk(req: ChunkedVolumeFetch): Promise<Uint8Array> {
      options.calls?.push({
        ...req,
        texOrigin: [...req.texOrigin],
        texDims: [...req.texDims],
      })
      if (options.fail) throw new Error('boom')
      const [nx, ny, nz] = req.texDims
      const count = nx * ny * nz
      const bytes = new Uint8Array(count * req.bytesPerVoxel)
      const view =
        datatypeCode === DT_UINT16
          ? new Uint16Array(bytes.buffer)
          : new Uint8Array(bytes.buffer)
      let i = 0
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            view[i++] = value(
              req.texOrigin[0] + x,
              req.texOrigin[1] + y,
              req.texOrigin[2] + z,
              req.levelIndex,
            )
          }
        }
      }
      return bytes
    },
  }
}

function recordingHost(events: NVSlideRangeEvent[]): SlideSourceHost & {
  wireBytes: number
} {
  const host = {
    wireBytes: 0,
    resolveUrl: (url: string) => url,
    addWireBytes(bytes: number) {
      host.wireBytes += bytes
    },
    rangeHit() {},
    rangeFallback() {},
    pushRangeEvent(event: NVSlideRangeEvent) {
      events.push({ ...event })
    },
    updateRangeEvent(label: string, status: NVSlideRangeStatus) {
      events.push({ label, status })
    },
  }
  return host
}

function levelOf(
  source: VolumeSliceSource,
  index: number,
): NVSlideLevelManifest {
  const level = source.manifest.levels[index]
  if (!level) throw new Error(`no level ${index}`)
  return level
}

describe('VolumeSliceSource manifest', () => {
  test('mirrors the pyramid, finest first, and stops at one tile', () => {
    const source = new VolumeSliceSource(
      fakeVolume([
        [16, 16, 16],
        [8, 8, 8],
        [4, 4, 4],
        [2, 2, 2],
      ]),
      { tileSize: 8 },
    )
    const { manifest } = source
    expect(manifest.width).toBe(16)
    expect(manifest.height).toBe(16)
    expect(manifest.dtype).toBe('uint8')
    expect(manifest.channels).toBe('rgba')
    expect(manifest.displayYAxis).toBe('up')
    // 16 -> 2x2 tiles, 8 -> one tile and the walk stops there.
    expect(manifest.levels.length).toBe(2)
    expect(manifest.levels.map((l) => l.width)).toEqual([16, 8])
    expect(manifest.levels.map((l) => l.downsample)).toEqual([1, 2])
    expect(manifest.levels.map((l) => l.columns)).toEqual([2, 1])
    expect(manifest.levels[0].tiles.length).toBe(4)
    expect(manifest.levels[0].codec).toBe('raw-rgba')
  })

  test('clips the tiles that run past a ragged level', () => {
    const source = new VolumeSliceSource(fakeVolume([[10, 6, 4]]), {
      tileSize: 8,
    })
    const tiles = levelOf(source, 0).tiles
    expect(tiles.map((t) => [t.x, t.y, t.width, t.height])).toEqual([
      [0, 0, 8, 6],
      [1, 0, 2, 6],
    ])
  })

  test('transposes the in-plane axes for a coronal or sagittal plane', () => {
    const shape: Array<[number, number, number]> = [[10, 20, 30]]
    const axial = new VolumeSliceSource(fakeVolume(shape), { axis: 'z' })
    const coronal = new VolumeSliceSource(fakeVolume(shape), { axis: 'y' })
    const sagittal = new VolumeSliceSource(fakeVolume(shape), { axis: 'x' })
    expect([axial.manifest.width, axial.manifest.height]).toEqual([10, 20])
    expect([coronal.manifest.width, coronal.manifest.height]).toEqual([10, 30])
    expect([sagittal.manifest.width, sagittal.manifest.height]).toEqual([
      20, 30,
    ])
    expect(axial.planeCount).toBe(30)
    expect(coronal.planeCount).toBe(20)
    expect(sagittal.planeCount).toBe(10)
  })

  test('defaults the plane to the middle and rejects one out of range', () => {
    const source = new VolumeSliceSource(fakeVolume([[8, 8, 9]]))
    expect(source.index).toBe(4)
    expect(
      () => new VolumeSliceSource(fakeVolume([[8, 8, 9]]), { index: 9 }),
    ).toThrow(/out of range/)
    expect(
      () => new VolumeSliceSource(fakeVolume([[8, 8, 9]]), { index: -1 }),
    ).toThrow(/out of range/)
  })

  test('rejects a volume with no levels, a bad LUT and a bad tile size', () => {
    expect(() => new VolumeSliceSource(fakeVolume([]))).toThrow(/no levels/)
    expect(
      () =>
        new VolumeSliceSource(fakeVolume([[4, 4, 4]]), {
          lut: new Uint8Array(16),
        }),
    ).toThrow(/256 RGBA entries/)
    expect(
      () => new VolumeSliceSource(fakeVolume([[4, 4, 4]]), { tileSize: 0 }),
    ).toThrow(/positive integer/)
  })

  test('withIndex keeps the appearance and shares the volume source', () => {
    const volume = fakeVolume([[8, 8, 8]])
    const source = new VolumeSliceSource(volume, {
      axis: 'y',
      index: 1,
      window: [0, 40],
      tileSize: 4,
    })
    const moved = source.withIndex(6)
    expect(moved.index).toBe(6)
    expect(moved.axis).toBe('y')
    expect(moved.volume).toBe(volume)
    expect(moved.manifest.levels[0].tileWidth).toBe(4)
  })
})

describe('VolumeSliceSource tiles', () => {
  test('reads the requested plane and windows it to RGBA', async () => {
    const calls: ChunkedVolumeFetch[] = []
    const source = new VolumeSliceSource(
      fakeVolume(
        [
          [4, 4, 4],
          [2, 2, 2],
        ],
        { calls, value: (x, y) => x + y * 4 },
      ),
      { tileSize: 4, index: 2, window: [0, 15] },
    )
    const tile = levelOf(source, 0).tiles[0]
    const rgba = await source.fetchTileBytes(levelOf(source, 0), tile, 'a')

    expect(calls[0].texOrigin).toEqual([0, 0, 2])
    expect(calls[0].texDims).toEqual([4, 4, 1])
    expect(calls[0].bytesPerVoxel).toBe(1)
    expect(rgba.byteLength).toBe(4 * 4 * 4)
    // Value 0 is black, value 15 is white, and the ramp is grayscale.
    expect([...rgba.slice(0, 4)]).toEqual([0, 0, 0, 255])
    expect([...rgba.slice(60, 64)]).toEqual([255, 255, 255, 255])
    // Pixel (u=1, v=0) holds value 1 of 15.
    expect(rgba[4]).toBe(17)
  })

  test('maps in-plane axes the same way for a sagittal plane', async () => {
    const calls: ChunkedVolumeFetch[] = []
    const source = new VolumeSliceSource(fakeVolume([[4, 6, 8]], { calls }), {
      axis: 'x',
      index: 3,
      tileSize: 4,
    })
    const level = levelOf(source, 0)
    // The second tile column steps the FIRST in-plane axis, which is y here.
    const tile = level.tiles.find((t) => t.x === 1 && t.y === 1)
    if (!tile) throw new Error('expected a tile at (1, 1)')
    await source.fetchTileBytes(level, tile, 'a')
    expect(calls[0].texOrigin).toEqual([3, 4, 4])
    expect(calls[0].texDims).toEqual([1, 2, 4])
  })

  test('holds the plane position as the levels coarsen', async () => {
    const calls: ChunkedVolumeFetch[] = []
    const source = new VolumeSliceSource(
      fakeVolume(
        [
          [16, 16, 16],
          [8, 8, 8],
        ],
        { calls },
      ),
      { tileSize: 8, index: 15 },
    )
    await source.fetchTileBytes(
      levelOf(source, 1),
      levelOf(source, 1).tiles[0],
      'a',
    )
    expect(calls[0].levelIndex).toBe(1)
    // The last plane of 16 stays the last plane of 8, not plane 15.
    expect(calls[0].texOrigin[2]).toBe(7)
  })

  test('clamps the window and honours a colormap LUT', async () => {
    const lut = new Uint8Array(1024)
    for (let i = 0; i < 256; i++) {
      lut[i * 4] = 255 - i
      lut[i * 4 + 1] = i
      lut[i * 4 + 2] = 7
      lut[i * 4 + 3] = 128
    }
    const source = new VolumeSliceSource(
      fakeVolume([[2, 2, 1]], {
        datatypeCode: DT_UINT16,
        value: (x, y) => [0, 1000, 4000, 60000][x + y * 2],
      }),
      { tileSize: 2, window: [1000, 4000], lut },
    )
    const rgba = await source.fetchTileBytes(
      levelOf(source, 0),
      levelOf(source, 0).tiles[0],
      'a',
    )
    // Below the window and at its floor both land on LUT entry 0.
    expect([...rgba.slice(0, 4)]).toEqual([255, 0, 7, 128])
    expect([...rgba.slice(4, 8)]).toEqual([255, 0, 7, 128])
    // At and above the ceiling both saturate to entry 255.
    expect([...rgba.slice(8, 12)]).toEqual([0, 255, 7, 128])
    expect([...rgba.slice(12, 16)]).toEqual([0, 255, 7, 128])
  })

  test('reads 16-bit voxels at the right stride', async () => {
    const source = new VolumeSliceSource(
      fakeVolume([[2, 1, 1]], {
        datatypeCode: DT_UINT16,
        value: (x) => (x === 0 ? 300 : 600),
      }),
      { tileSize: 2, window: [300, 600] },
    )
    const rgba = await source.fetchTileBytes(
      levelOf(source, 0),
      levelOf(source, 0).tiles[0],
      'a',
    )
    expect(rgba[0]).toBe(0)
    expect(rgba[4]).toBe(255)
  })

  test('reports a tile to the host as pending then hit', async () => {
    const events: NVSlideRangeEvent[] = []
    const host = recordingHost(events)
    const source = new VolumeSliceSource(fakeVolume([[4, 4, 4]]), {
      tileSize: 4,
    })
    source.bind(host)
    await source.fetchTileBytes(
      levelOf(source, 0),
      levelOf(source, 0).tiles[0],
      'tile-a',
    )
    expect(events).toEqual([
      { label: 'tile-a', status: 'pending' },
      { label: 'tile-a', status: 'hit' },
    ])
    expect(host.wireBytes).toBe(16)
  })

  test('reports a failed read and rethrows', async () => {
    const events: NVSlideRangeEvent[] = []
    const host = recordingHost(events)
    const source = new VolumeSliceSource(
      fakeVolume([[4, 4, 4]], { fail: true }),
      { tileSize: 4 },
    )
    source.bind(host)
    await expect(
      source.fetchTileBytes(
        levelOf(source, 0),
        levelOf(source, 0).tiles[0],
        'tile-a',
      ),
    ).rejects.toThrow('boom')
    expect(events.map((e) => e.status)).toEqual(['pending', 'failed'])
  })
})
