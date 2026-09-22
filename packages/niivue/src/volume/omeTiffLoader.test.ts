import { describe, expect, test } from 'bun:test'
import { omeTiffVolumesFrom } from './omeTiffLoader'
import { parseTiff } from './tiff'
import { buildMultiIfd } from './tiffBuilders'
import { describeTiff, type TiffSource } from './tiffVolume'

// XYCZT with SizeZ=1, so plane index === channel index and each synthetic
// plane is filled with its own channel number. Only `nuclei` states a colour
// (OME RGBA int 65535 = blue); the other two must fall back to the palette.
const OME_THREE_CHANNEL = `<OME><Image Name="three channel">
  <Pixels SizeX="2" SizeY="1" SizeZ="1" SizeC="3" SizeT="1"
    DimensionOrder="XYCZT" Type="uint8">
    <Channel Name="nuclei" Color="65535"/>
    <Channel Name="membrane"/>
    <Channel Name="mito"/>
  </Pixels></Image></OME>`

function threeChannelSource(): TiffSource {
  return describeTiff(parseTiff(buildMultiIfd(3, OME_THREE_CHANNEL, 2, 1)))
}

async function fileVoxels(file: File): Promise<Uint8Array> {
  const buffer = await file.arrayBuffer()
  return new Uint8Array(buffer.slice(352))
}

describe('omeTiffVolumesFrom', () => {
  test('defaults to every channel, in file order', async () => {
    const volumes = await omeTiffVolumesFrom(threeChannelSource())
    expect(volumes.map((v) => v.name)).toEqual(['nuclei', 'membrane', 'mito'])
    // The stated colour wins for channel 0; unstated channels take the
    // palette entry for their position.
    expect(volumes.map((v) => v.colormap)).toEqual([
      'blue',
      'violet',
      'blue2cyan',
    ])
  })

  test('colormap order follows the requested list, not the file', async () => {
    const volumes = await omeTiffVolumesFrom(threeChannelSource(), {
      channels: [2, 0],
    })
    expect(volumes.map((v) => v.name)).toEqual(['mito', 'nuclei'])
    // `mito` states no colour and is FIRST in the request, so it takes
    // palette entry 0; `nuclei` keeps its stated blue.
    expect(volumes.map((v) => v.colormap)).toEqual(['green', 'blue'])
    // Each volume decodes its own channel's planes.
    expect(Array.from(await fileVoxels(volumes[0].url as File))).toEqual([2, 2])
    expect(Array.from(await fileVoxels(volumes[1].url as File))).toEqual([0, 0])
    expect((volumes[0].url as File).name).toBe('mito.nii')
  })

  for (const channels of [[5], [-1], [1.5]]) {
    test(`rejects channel list ${JSON.stringify(channels)} before any decode`, async () => {
      await expect(
        omeTiffVolumesFrom(threeChannelSource(), { channels }),
      ).rejects.toThrow(/out of range/)
    })
  }
})
