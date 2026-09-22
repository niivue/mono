import { describe, expect, test } from 'bun:test'

import { parseAllenAtlasInfo } from './allenAtlas'
import {
  allenAtlasChannelColormap,
  allenAtlasChannelFile,
  loadAllenAtlasVolumes,
} from './allenAtlasLoader'
import type { DecodedImage } from './imageDecode'

/** Two atlases of 2x2 tiles in a 2x2 grid, 4 channels, 3 Z slices. */
const SIDECAR = {
  width: 4,
  height: 4,
  channels: 4,
  channel_names: ['DNA', 'ACTB', 'FBL', 'LMNB1'],
  rows: 2,
  cols: 2,
  tiles: 3,
  tile_width: 2,
  tile_height: 2,
  atlas_width: 4,
  atlas_height: 4,
  pixel_size_x: 1,
  pixel_size_y: 1,
  pixel_size_z: 2.9,
  images: [
    { name: 'a_0.png', channels: [0, 1, 2] },
    { name: 'a_1.png', channels: [3] },
  ],
}

const BASE = 'https://example.org/data/atlas.json'

/** Every voxel of a given atlas/plane carries one recognizable value. */
function atlasFor(imageName: string): DecodedImage {
  const seed = imageName === 'a_0.png' ? 1 : 2
  const data = new Uint8ClampedArray(4 * 4 * 4)
  for (let p = 0; p < 16; p++) {
    data[p * 4 + 0] = 10 * seed
    data[p * 4 + 1] = 20 * seed
    data[p * 4 + 2] = 30 * seed
    data[p * 4 + 3] = 255
  }
  return { width: 4, height: 4, data }
}

/** Records every URL requested so tests can assert on fetch behaviour. */
function makeHarness(sidecar: unknown = SIDECAR) {
  const requested: string[] = []
  const decoded: string[] = []
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    requested.push(url)
    if (url.endsWith('.json')) {
      return new Response(JSON.stringify(sidecar), { status: 200 })
    }
    // The bytes are opaque here: the injected decoder keys off the URL instead.
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  }) as unknown as typeof fetch
  const decodeImage = async (): Promise<DecodedImage> => {
    const url = requested[requested.length - 1]
    const name = url.slice(url.lastIndexOf('/') + 1)
    decoded.push(name)
    return atlasFor(name)
  }
  return { requested, decoded, fetchImpl, decodeImage }
}

describe('loadAllenAtlasVolumes', () => {
  test('returns one volume per requested channel, in request order', async () => {
    const { fetchImpl, decodeImage } = makeHarness()
    const volumes = await loadAllenAtlasVolumes(BASE, {
      channels: [3, 0],
      fetchImpl,
      decodeImage,
    })
    expect(volumes.map((v) => v.name)).toEqual(['LMNB1', 'DNA'])
    expect(volumes.every((v) => v.url instanceof File)).toBe(true)
  })

  test('defaults to every channel', async () => {
    const { fetchImpl, decodeImage } = makeHarness()
    const volumes = await loadAllenAtlasVolumes(BASE, {
      fetchImpl,
      decodeImage,
    })
    expect(volumes.map((v) => v.name)).toEqual(['DNA', 'ACTB', 'FBL', 'LMNB1'])
  })

  test('fetches and decodes each shared atlas only once', async () => {
    const { requested, decoded, fetchImpl, decodeImage } = makeHarness()
    await loadAllenAtlasVolumes(BASE, {
      channels: [0, 1, 2],
      fetchImpl,
      decodeImage,
    })
    expect(requested.filter((u) => u.endsWith('a_0.png'))).toHaveLength(1)
    expect(decoded).toEqual(['a_0.png'])
  })

  test('skips atlases that carry no requested channel', async () => {
    const { requested, fetchImpl, decodeImage } = makeHarness()
    await loadAllenAtlasVolumes(BASE, { channels: [0], fetchImpl, decodeImage })
    expect(requested.some((u) => u.endsWith('a_1.png'))).toBe(false)
  })

  test('resolves atlas names against the sidecar URL', async () => {
    const { requested, fetchImpl, decodeImage } = makeHarness()
    await loadAllenAtlasVolumes(BASE, { channels: [0], fetchImpl, decodeImage })
    expect(requested).toContain('https://example.org/data/a_0.png')
  })

  test('accepts a relative sidecar URL', async () => {
    // Demo pages pass "data/atlas.json"; new URL(name, relative) alone throws.
    const { requested, fetchImpl, decodeImage } = makeHarness()
    const volumes = await loadAllenAtlasVolumes('data/atlas.json', {
      channels: [0],
      fetchImpl,
      decodeImage,
    })
    expect(volumes).toHaveLength(1)
    expect(requested[1].endsWith('data/a_0.png')).toBe(true)
  })

  test('rejects a channel index no atlas carries, before downloading', async () => {
    const { requested, fetchImpl, decodeImage } = makeHarness()
    await expect(
      loadAllenAtlasVolumes(BASE, { channels: [7], fetchImpl, decodeImage }),
    ).rejects.toThrow(/no image carries channel 7/)
    expect(requested.some((u) => u.endsWith('.png'))).toBe(false)
  })

  test('rejects an atlas whose real size contradicts the sidecar', async () => {
    const { fetchImpl } = makeHarness()
    const decodeImage = async (): Promise<DecodedImage> => ({
      width: 8,
      height: 4,
      data: new Uint8ClampedArray(8 * 4 * 4),
    })
    await expect(
      loadAllenAtlasVolumes(BASE, { channels: [0], fetchImpl, decodeImage }),
    ).rejects.toThrow(/is 8x4, sidecar says 4x4/)
  })

  test('surfaces a failed fetch with its status', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 404, statusText: 'Not Found' })) as never
    await expect(
      loadAllenAtlasVolumes(BASE, { channels: [0], fetchImpl }),
    ).rejects.toThrow(/returned 404/)
  })

  test('assigns a distinct colormap to each channel', async () => {
    const { fetchImpl, decodeImage } = makeHarness()
    const volumes = await loadAllenAtlasVolumes(BASE, {
      fetchImpl,
      decodeImage,
    })
    const colormaps = volumes.map((v) => v.colormap)
    expect(new Set(colormaps).size).toBe(colormaps.length)
  })
})

describe('allenAtlasChannelColormap', () => {
  const info = parseAllenAtlasInfo(SIDECAR)

  test('cycles the palette when the sidecar names no colours', () => {
    const first = allenAtlasChannelColormap(info, 0, 0)
    expect(allenAtlasChannelColormap(info, 1, 1)).not.toBe(first)
    // Wrapping is by position, so the 7th channel reuses the first colour.
    expect(allenAtlasChannelColormap(info, 3, 6)).toBe(first)
  })

  test('honours a sidecar colour by nearest hue', () => {
    const colored = parseAllenAtlasInfo({
      ...SIDECAR,
      channel_colors: [
        [250, 10, 10],
        [10, 10, 240],
      ],
    })
    expect(allenAtlasChannelColormap(colored, 0, 0)).toBe('red')
    expect(allenAtlasChannelColormap(colored, 1, 1)).toBe('blue')
  })
})

describe('allenAtlasChannelFile', () => {
  const info = parseAllenAtlasInfo(SIDECAR)

  test('writes a NIfTI large enough for the channel and names it .nii', () => {
    const img = new Uint8Array(2 * 2 * 3)
    const file = allenAtlasChannelFile(info, img, 'DNA')
    expect(file.name).toBe('DNA.nii')
    expect(file.size).toBe(352 + img.length)
  })
})
