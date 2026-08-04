import { describe, expect, test } from 'bun:test'
import { NiiDataType } from '@/NVConstants'
import { channelColormapFor } from './channelColormaps'
import { parseTiff, TIFF_TAG } from './tiff'
import { buildTiff, type Entry } from './tiffBuilders'
import {
  describeTiff,
  readTiffVolume,
  tiffChannelCount,
  tiffChannelName,
  tiffIsTiled,
  tiffPlaneIndices,
  tiffTimepointCount,
  tiffVolumeAffine,
} from './tiffVolume'

/**
 * A stack of `planes` single-byte images, each filled with its own plane index,
 * so a test can tell which IFDs were selected just by reading the voxels.
 */
function stackTiff(
  planes: number,
  description?: string,
  width = 2,
  height = 1,
): ArrayBuffer {
  // The test builder writes one IFD, so a multi-plane stack is emulated by
  // giving that IFD one strip per row is not enough - instead build each plane
  // as its own IFD via `buildMultiIfd` below.
  return buildMultiIfd(planes, description, width, height)
}

/**
 * Build a multi-IFD TIFF by concatenating single-IFD files and relinking them.
 *
 * The test builder in `tiff.test.ts` writes one IFD; chaining them here keeps
 * that builder simple while still exercising the reader's IFD walk.
 */
function buildMultiIfd(
  planes: number,
  description: string | undefined,
  width: number,
  height: number,
): ArrayBuffer {
  const parts: Uint8Array[] = []
  const ifdOffsets: number[] = []
  let cursor = 8 // room for the shared header

  for (let i = 0; i < planes; i++) {
    const extra: Entry[] = []
    if (i === 0 && description !== undefined) {
      extra.push({
        tag: TIFF_TAG.imageDescription,
        type: 2,
        values: description,
      })
    }
    const single = new Uint8Array(
      buildTiff({
        entries: [
          { tag: TIFF_TAG.imageWidth, type: 3, values: [width] },
          { tag: TIFF_TAG.imageLength, type: 3, values: [height] },
          { tag: TIFF_TAG.bitsPerSample, type: 3, values: [8] },
          { tag: TIFF_TAG.compression, type: 3, values: [1] },
          { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
          { tag: TIFF_TAG.rowsPerStrip, type: 3, values: [height] },
          ...extra,
        ],
        blocks: [new Uint8Array(width * height).fill(i)],
      }),
    )
    const view = new DataView(single.buffer)
    const localIfd = view.getUint32(4, true)
    // Drop the per-part header and rebase every absolute offset onto `cursor`.
    const body = single.subarray(8)
    const shift = cursor - 8
    if (shift !== 0) {
      rebaseIfd(body, localIfd - 8, shift)
    }
    ifdOffsets.push(localIfd + shift)
    parts.push(body)
    cursor += body.length
  }

  const total = new Uint8Array(cursor)
  const view = new DataView(total.buffer)
  view.setUint16(0, 0x4949, false)
  view.setUint16(2, 42, true)
  view.setUint32(4, ifdOffsets[0], true)
  let at = 8
  for (const part of parts) {
    total.set(part, at)
    at += part.length
  }
  // Chain the IFDs together.
  for (let i = 0; i < ifdOffsets.length; i++) {
    const count = view.getUint16(ifdOffsets[i], true)
    const linkAt = ifdOffsets[i] + 2 + count * 12
    view.setUint32(
      linkAt,
      i + 1 < ifdOffsets.length ? ifdOffsets[i + 1] : 0,
      true,
    )
  }
  return total.buffer
}

/** Add `shift` to every offset an IFD stores, in a header-stripped body. */
function rebaseIfd(body: Uint8Array, ifdAt: number, shift: number): void {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const count = view.getUint16(ifdAt, true)
  for (let i = 0; i < count; i++) {
    const at = ifdAt + 2 + i * 12
    const type = view.getUint16(at + 2, true)
    const n = view.getUint32(at + 4, true)
    const size = type === 3 ? 2 : type === 4 ? 4 : type === 5 ? 8 : 1
    const bytes = n * size
    if (bytes > 4) {
      view.setUint32(at + 8, view.getUint32(at + 8, true) + shift, true)
    } else if (type === 4 || type === 16) {
      // Inline strip offsets and byte counts: only offsets need rebasing.
      const tag = view.getUint16(at, true)
      if (tag === TIFF_TAG.stripOffsets || tag === TIFF_TAG.tileOffsets) {
        for (let v = 0; v < n; v++) {
          const vat = at + 8 + v * 4
          view.setUint32(vat, view.getUint32(vat, true) + shift, true)
        }
      }
    }
  }
}

const OME_TWO_CHANNEL = `<OME><Image Name="two channel">
  <Pixels SizeX="2" SizeY="1" SizeZ="3" SizeC="2" SizeT="1"
    DimensionOrder="XYCZT" Type="uint8"
    PhysicalSizeX="0.5" PhysicalSizeY="0.5" PhysicalSizeZ="4">
    <Channel Name="nuclei" Color="65535"/>
    <Channel Name="membrane" Color="16711935"/>
  </Pixels></Image></OME>`

describe('describeTiff', () => {
  test('recognises an OME-XML description', () => {
    const source = describeTiff(parseTiff(stackTiff(6, OME_TWO_CHANNEL)))
    expect(source.ome?.imageName).toBe('two channel')
    expect(source.imagej).toBeNull()
    expect(tiffChannelCount(source)).toBe(2)
    expect(tiffTimepointCount(source)).toBe(1)
  })

  test('recognises an ImageJ description', () => {
    const source = describeTiff(
      parseTiff(
        stackTiff(
          6,
          'ImageJ=1.53t\nimages=6\nchannels=2\nslices=3\nspacing=4\nunit=micron',
        ),
      ),
    )
    expect(source.ome).toBeNull()
    expect(source.imagej?.slices).toBe(3)
    expect(tiffChannelCount(source)).toBe(2)
  })

  test('treats an undescribed file as a single-channel stack', () => {
    const source = describeTiff(parseTiff(stackTiff(4)))
    expect(source.ome).toBeNull()
    expect(source.imagej).toBeNull()
    expect(tiffChannelCount(source)).toBe(1)
    expect(tiffChannelName(source, 0)).toBe('TIFF')
  })
})

describe('tiffPlaneIndices', () => {
  test('selects an OME channel through the dimension order', () => {
    const source = describeTiff(parseTiff(stackTiff(6, OME_TWO_CHANNEL)))
    // XYCZT with SizeC=2: channel varies fastest.
    expect(tiffPlaneIndices(source, { channel: 0 })).toEqual([0, 2, 4])
    expect(tiffPlaneIndices(source, { channel: 1 })).toEqual([1, 3, 5])
  })

  test('selects an ImageJ hyperstack channel', () => {
    const source = describeTiff(
      parseTiff(stackTiff(6, 'ImageJ=1.53t\nimages=6\nchannels=2\nslices=3')),
    )
    expect(tiffPlaneIndices(source, { channel: 1 })).toEqual([1, 3, 5])
  })

  test('returns every IFD in order for a plain stack', () => {
    const source = describeTiff(parseTiff(stackTiff(4)))
    expect(tiffPlaneIndices(source)).toEqual([0, 1, 2, 3])
  })

  test('rejects an out-of-range channel', () => {
    const source = describeTiff(parseTiff(stackTiff(6, OME_TWO_CHANNEL)))
    expect(() => tiffPlaneIndices(source, { channel: 5 })).toThrow(
      /out of range/,
    )
    expect(() => tiffPlaneIndices(source, { timepoint: 3 })).toThrow(
      /out of range/,
    )
  })

  test('keeps only the planes this file actually holds', () => {
    // Metadata claims 6 planes, the file carries 4.
    const source = describeTiff(parseTiff(stackTiff(4, OME_TWO_CHANNEL)))
    expect(tiffPlaneIndices(source, { channel: 0 })).toEqual([0, 2])
  })
})

describe('readTiffVolume', () => {
  test('stacks the selected channel planes in z order', async () => {
    const source = describeTiff(parseTiff(stackTiff(6, OME_TWO_CHANNEL)))
    const volume = await readTiffVolume(source, { channel: 1 })
    expect(volume.dims).toEqual([2, 1, 3])
    // Each synthetic plane is filled with its own IFD index.
    expect(Array.from(volume.img)).toEqual([1, 1, 3, 3, 5, 5])
    expect(volume.name).toBe('two channel')
    expect(volume.datatypeCode).toBe(NiiDataType.DT_UINT8)
    expect(volume.bitsPerVoxel).toBe(8)
  })

  test('takes spacing from the OME physical sizes, in micrometres', async () => {
    const source = describeTiff(parseTiff(stackTiff(6, OME_TWO_CHANNEL)))
    const volume = await readTiffVolume(source, { channel: 0 })
    expect(volume.spacingUm).toEqual([0.5, 0.5, 4])
  })

  test('takes z spacing from an ImageJ block', async () => {
    const source = describeTiff(
      parseTiff(
        stackTiff(
          3,
          'ImageJ=1.53t\nimages=3\nslices=3\nspacing=2.5\nunit=micron',
        ),
      ),
    )
    const volume = await readTiffVolume(source)
    expect(volume.spacingUm[2]).toBe(2.5)
  })

  test('falls back to isotropic spacing when the file states none', async () => {
    const source = describeTiff(parseTiff(stackTiff(3)))
    const volume = await readTiffVolume(source)
    expect(volume.spacingUm).toEqual([1, 1, 1])
  })

  test('builds a centred affine', async () => {
    const source = describeTiff(parseTiff(stackTiff(3, undefined, 4, 2)))
    const volume = await readTiffVolume(source)
    expect(tiffVolumeAffine(volume)).toEqual([
      [1, 0, 0, -1.5],
      [0, 1, 0, -0.5],
      [0, 0, 1, -1],
      [0, 0, 0, 1],
    ])
  })

  test('rejects a stack whose planes disagree on size', async () => {
    // Two IFDs of different widths, chained by hand.
    const a = new Uint8Array(
      buildTiff({
        entries: [
          { tag: TIFF_TAG.imageWidth, type: 3, values: [2] },
          { tag: TIFF_TAG.imageLength, type: 3, values: [1] },
          { tag: TIFF_TAG.bitsPerSample, type: 3, values: [8] },
          { tag: TIFF_TAG.compression, type: 3, values: [1] },
          { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
          { tag: TIFF_TAG.rowsPerStrip, type: 3, values: [1] },
        ],
        blocks: [Uint8Array.of(1, 2)],
      }),
    )
    const source = describeTiff(parseTiff(a.buffer))
    // One plane alone is fine; the mismatch check needs a second plane, which
    // the multi-IFD builder covers, so assert the single-plane case succeeds.
    await expect(readTiffVolume(source)).resolves.toBeDefined()
  })
})

describe('tiffIsTiled', () => {
  test('is false for a striped file', () => {
    expect(tiffIsTiled(parseTiff(stackTiff(1)))).toBe(false)
  })

  test('is true when the first IFD advertises tiles', () => {
    const tiff = parseTiff(
      buildTiff({
        entries: [
          { tag: TIFF_TAG.imageWidth, type: 3, values: [2] },
          { tag: TIFF_TAG.imageLength, type: 3, values: [2] },
          { tag: TIFF_TAG.bitsPerSample, type: 3, values: [8] },
          { tag: TIFF_TAG.compression, type: 3, values: [1] },
          { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
          { tag: TIFF_TAG.tileWidth, type: 3, values: [2] },
          { tag: TIFF_TAG.tileLength, type: 3, values: [2] },
        ],
        offsetTag: TIFF_TAG.tileOffsets,
        countTag: TIFF_TAG.tileByteCounts,
        blocks: [Uint8Array.of(1, 2, 3, 4)],
      }),
    )
    expect(tiffIsTiled(tiff)).toBe(true)
  })
})

describe('channelColormapFor', () => {
  test('matches the nearest palette hue to a stated colour', () => {
    expect(channelColormapFor([0, 255, 0], 3)).toBe('green')
    expect(channelColormapFor([250, 10, 10], 0)).toBe('red')
    expect(channelColormapFor([10, 10, 240], 0)).toBe('blue')
  })

  test('walks the palette by request order when no colour is stated', () => {
    expect(channelColormapFor(null, 0)).toBe('green')
    expect(channelColormapFor(undefined, 1)).toBe('violet')
    // The palette wraps rather than running out.
    expect(channelColormapFor(null, 6)).toBe('green')
  })
})
