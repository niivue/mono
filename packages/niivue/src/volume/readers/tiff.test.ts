import { describe, expect, test } from 'bun:test'
import { NiiDataType } from '@/NVConstants'
import { TIFF_TAG } from '../tiff'
import { buildTiff } from '../tiffBuilders'
import { extensions, read, type } from './tiff'

/** A 3x2 16-bit image with an OME description claiming two channels. */
function twoChannelTiff(): ArrayBuffer {
  const values = [10, 20, 30, 40, 50, 60]
  const bytes = new Uint8Array(values.length * 2)
  const view = new DataView(bytes.buffer)
  values.forEach((value, i) => {
    view.setUint16(i * 2, value, true)
  })
  return buildTiff({
    entries: [
      { tag: TIFF_TAG.imageWidth, type: 3, values: [3] },
      { tag: TIFF_TAG.imageLength, type: 3, values: [2] },
      { tag: TIFF_TAG.bitsPerSample, type: 3, values: [16] },
      { tag: TIFF_TAG.compression, type: 3, values: [1] },
      { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
      { tag: TIFF_TAG.rowsPerStrip, type: 3, values: [2] },
      {
        tag: TIFF_TAG.imageDescription,
        type: 2,
        values:
          '<OME><Image Name="two channel"><Pixels SizeX="3" SizeY="2" SizeZ="1"' +
          ' SizeC="2" SizeT="1" DimensionOrder="XYCZT" Type="uint16"' +
          ' PhysicalSizeX="0.25" PhysicalSizeY="0.25" PhysicalSizeZ="1.5"/>' +
          '</Image></OME>',
      },
    ],
    blocks: [bytes],
  })
}

describe('the .tif volume reader', () => {
  test('claims both TIFF extensions and produces a NIfTI', () => {
    expect(extensions).toEqual(['tif', 'tiff'])
    expect(type).toBe('nii')
  })

  test('reads a plain 8-bit image into a single-slice volume', async () => {
    const buffer = buildTiff({
      entries: [
        { tag: TIFF_TAG.imageWidth, type: 3, values: [4] },
        { tag: TIFF_TAG.imageLength, type: 3, values: [2] },
        { tag: TIFF_TAG.bitsPerSample, type: 3, values: [8] },
        { tag: TIFF_TAG.compression, type: 3, values: [1] },
        { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
        { tag: TIFF_TAG.rowsPerStrip, type: 3, values: [2] },
      ],
      blocks: [Uint8Array.from({ length: 8 }, (_unused, i) => i)],
    })
    const { hdr, img } = await read(buffer)
    expect(hdr.dims.slice(0, 4)).toEqual([3, 4, 2, 1])
    expect(hdr.datatypeCode).toBe(NiiDataType.DT_UINT8)
    expect(hdr.numBitsPerVoxel).toBe(8)
    expect(Array.from(img as Uint8Array)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test('carries the OME spacing into pixDims, in micrometres', async () => {
    const { hdr } = await read(twoChannelTiff())
    expect(hdr.pixDims.slice(1, 4)).toEqual([0.25, 0.25, 1.5])
    expect(hdr.datatypeCode).toBe(NiiDataType.DT_UINT16)
    expect(hdr.description).toBe('two channel')
  })

  test('centres the affine on the origin', async () => {
    const { hdr } = await read(twoChannelTiff())
    expect(hdr.affine).toEqual([
      [0.25, 0, 0, -0.25],
      [0, 0.25, 0, -0.125],
      [0, 0, 1.5, -0],
      [0, 0, 0, 1],
    ])
  })

  test('loads only the first channel of a multi-channel file', async () => {
    // Two channels but one IFD, so only channel 0 has a plane to load.
    const { hdr, img } = await read(twoChannelTiff())
    expect(hdr.dims[3]).toBe(1)
    expect(Array.from(img as Uint16Array)).toEqual([10, 20, 30, 40, 50, 60])
  })

  test('surfaces a decode failure rather than returning empty pixels', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]).buffer
    expect(read(png)).rejects.toThrow(/not a TIFF/)
  })
})
