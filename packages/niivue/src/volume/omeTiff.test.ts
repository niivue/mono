import { describe, expect, test } from 'bun:test'
import {
  omeChannelName,
  omeEffectiveSizeC,
  omeLengthToMicrons,
  omePlaneCount,
  omePlaneIndex,
  parseImageJDescription,
  parseOmeColor,
  parseOmeXml,
} from './omeTiff'

/** A two-channel, three-slice OME-XML document in the shape Bio-Formats writes. */
function omeXml(attrs = '', channels = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
  <Image ID="Image:0" Name="specimen.ome.tif">
    <Pixels ID="Pixels:0" DimensionOrder="XYCZT" Type="uint16"
      SizeX="512" SizeY="256" SizeZ="3" SizeC="2" SizeT="1"
      PhysicalSizeX="0.65" PhysicalSizeXUnit="&#181;m"
      PhysicalSizeY="0.65" PhysicalSizeYUnit="&#181;m"
      PhysicalSizeZ="2" PhysicalSizeZUnit="&#181;m"${attrs}>
      ${
        channels ||
        `<Channel ID="Channel:0:0" Name="DAPI" Color="65535" SamplesPerPixel="1"/>
      <Channel ID="Channel:0:1" Name="GFP" Color="16711935" SamplesPerPixel="1"/>`
      }
    </Pixels>
  </Image>
</OME>`
}

describe('parseOmeXml', () => {
  test('reads the image name, sizes and dimension order', () => {
    const info = parseOmeXml(omeXml())
    expect(info).not.toBeNull()
    expect(info?.imageName).toBe('specimen.ome.tif')
    expect(info?.sizeX).toBe(512)
    expect(info?.sizeY).toBe(256)
    expect(info?.sizeZ).toBe(3)
    expect(info?.sizeC).toBe(2)
    expect(info?.sizeT).toBe(1)
    expect(info?.dimensionOrder).toBe('XYCZT')
    expect(info?.pixelType).toBe('uint16')
  })

  test('reads channel names and colours', () => {
    const info = parseOmeXml(omeXml())
    expect(info?.channels.map((c) => c.name)).toEqual(['DAPI', 'GFP'])
    expect(info?.channels[0].color).toEqual([0, 0, 255])
    expect(info?.channels[1].color).toEqual([0, 255, 0])
  })

  test('converts physical sizes to micrometres', () => {
    const info = parseOmeXml(omeXml())
    expect(info?.spacingUm).toEqual([0.65, 0.65, 2])
  })

  test('converts a non-default unit', () => {
    const xml = omeXml().replace(
      /PhysicalSizeZ="2" PhysicalSizeZUnit="&#181;m"/,
      'PhysicalSizeZ="0.5" PhysicalSizeZUnit="mm"',
    )
    expect(parseOmeXml(xml)?.spacingUm[2]).toBe(500)
  })

  test('reports zero for an axis the file does not state', () => {
    const xml = omeXml().replace(
      /PhysicalSizeZ="2" PhysicalSizeZUnit="&#181;m"/,
      '',
    )
    expect(parseOmeXml(xml)?.spacingUm[2]).toBe(0)
  })

  test('tolerates a namespace prefix on every element', () => {
    const xml = `<ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06">
      <ome:Image Name="prefixed">
        <ome:Pixels SizeX="4" SizeY="4" SizeZ="2" SizeC="1" SizeT="1"
          DimensionOrder="XYZCT" Type="uint8">
          <ome:Channel Name="only"/>
        </ome:Pixels>
      </ome:Image>
    </ome:OME>`
    const info = parseOmeXml(xml)
    expect(info?.imageName).toBe('prefixed')
    expect(info?.sizeZ).toBe(2)
    expect(info?.channels).toHaveLength(1)
  })

  test('falls back to XYZCT when the stated order is not a permutation', () => {
    const xml = omeXml().replace(
      'DimensionOrder="XYCZT"',
      'DimensionOrder="ZZZZZ"',
    )
    expect(parseOmeXml(xml)?.dimensionOrder).toBe('XYZCT')
  })

  test('decodes XML entities in attribute values', () => {
    const xml = omeXml(
      '',
      '<Channel Name="Alexa &amp; Cy5 &lt;far red&gt;" Color="-1"/>',
    )
    expect(parseOmeXml(xml)?.channels[0].name).toBe('Alexa & Cy5 <far red>')
  })

  test('returns null for text that is not OME-XML', () => {
    expect(parseOmeXml(undefined)).toBeNull()
    expect(parseOmeXml('')).toBeNull()
    expect(parseOmeXml('ImageJ=1.53t\nimages=10')).toBeNull()
    expect(parseOmeXml('<svg><rect/></svg>')).toBeNull()
  })

  test('returns null when the pixel dimensions are missing', () => {
    expect(
      parseOmeXml('<OME><Image><Pixels SizeZ="4"/></Image></OME>'),
    ).toBeNull()
  })

  test('describes only the first image of a multi-scene file', () => {
    const xml = `<OME>
      <Image Name="scene one"><Pixels SizeX="8" SizeY="8" SizeZ="1" SizeC="1" SizeT="1"/></Image>
      <Image Name="scene two"><Pixels SizeX="64" SizeY="64" SizeZ="9" SizeC="4" SizeT="1"/></Image>
    </OME>`
    const info = parseOmeXml(xml)
    expect(info?.imageName).toBe('scene one')
    expect(info?.sizeX).toBe(8)
    expect(info?.channels).toHaveLength(0)
  })

  test('infers the channel count from the channel elements when SizeC is absent', () => {
    const xml = `<OME><Image Name="n"><Pixels SizeX="4" SizeY="4">
      <Channel Name="a"/><Channel Name="b"/><Channel Name="c"/>
    </Pixels></Image></OME>`
    expect(parseOmeXml(xml)?.sizeC).toBe(3)
  })
})

describe('parseOmeColor', () => {
  test('decodes the signed RGBA integers OME writes', () => {
    expect(parseOmeColor('16711935')).toEqual([0, 255, 0]) // green
    expect(parseOmeColor('-16776961')).toEqual([255, 0, 0]) // red
    expect(parseOmeColor('65535')).toEqual([0, 0, 255]) // blue
    expect(parseOmeColor('-1')).toEqual([255, 255, 255]) // white
  })

  test('returns null when the attribute is absent or empty', () => {
    expect(parseOmeColor(undefined)).toBeNull()
    expect(parseOmeColor('   ')).toBeNull()
    expect(parseOmeColor('not a number')).toBeNull()
  })
})

describe('omePlaneIndex', () => {
  const info = (order: string, sizeZ = 2, sizeC = 3, sizeT = 4) => ({
    imageName: '',
    sizeX: 1,
    sizeY: 1,
    sizeZ,
    sizeC,
    sizeT,
    dimensionOrder: order,
    pixelType: 'uint8',
    spacingUm: [0, 0, 0] as [number, number, number],
    channels: [],
  })

  test('varies the third letter fastest', () => {
    expect(omePlaneIndex(info('XYZCT'), 1, 0, 0)).toBe(1)
    expect(omePlaneIndex(info('XYCZT'), 1, 0, 0)).toBe(3)
    expect(omePlaneIndex(info('XYTCZ'), 1, 0, 0)).toBe(12)
  })

  test('is a bijection onto [0, planeCount) for every dimension order', () => {
    for (const order of [
      'XYZCT',
      'XYZTC',
      'XYCZT',
      'XYCTZ',
      'XYTCZ',
      'XYTZC',
    ]) {
      const meta = info(order)
      const seen = new Set<number>()
      for (let t = 0; t < meta.sizeT; t++) {
        for (let c = 0; c < meta.sizeC; c++) {
          for (let z = 0; z < meta.sizeZ; z++) {
            const index = omePlaneIndex(meta, z, c, t)
            expect(index).toBeGreaterThanOrEqual(0)
            expect(index).toBeLessThan(omePlaneCount(meta))
            seen.add(index)
          }
        }
      }
      expect(seen.size).toBe(omePlaneCount(meta))
    }
  })

  test('walks consecutive planes for the first channel of an XYZCT stack', () => {
    const meta = info('XYZCT', 5, 2, 1)
    expect([0, 1, 2, 3, 4].map((z) => omePlaneIndex(meta, z, 0, 0))).toEqual([
      0, 1, 2, 3, 4,
    ])
    expect([0, 1, 2, 3, 4].map((z) => omePlaneIndex(meta, z, 1, 0))).toEqual([
      5, 6, 7, 8, 9,
    ])
  })

  test('strides by the channel count for an XYCZT stack', () => {
    const meta = info('XYCZT', 5, 2, 1)
    expect([0, 1, 2].map((z) => omePlaneIndex(meta, z, 1, 0))).toEqual([
      1, 3, 5,
    ])
  })
})

describe('omeEffectiveSizeC', () => {
  const rgbInfo = parseOmeXml(
    omeXml(
      '',
      '<Channel ID="Channel:0:0" Name="brightfield" SamplesPerPixel="3"/>',
    ),
  )

  test('one interleaved-RGB channel occupies one plane slot', () => {
    // Bio-Formats RGB convention: SizeC counts samples (3), but a single
    // <Channel SamplesPerPixel="3"> stores them interleaved in ONE plane.
    const info = parseOmeXml(
      omeXml(
        '',
        '<Channel ID="Channel:0:0" Name="brightfield" SamplesPerPixel="3"/>',
      ).replace('SizeC="2"', 'SizeC="3"'),
    )
    expect(info && omeEffectiveSizeC(info)).toBe(1)
    // The plane grid strides C by the EFFECTIVE count: with XYCZT and
    // SizeZ=3 the file has 3 IFDs, one per z.
    expect(info && omePlaneCount(info)).toBe(3)
    expect(info && omePlaneIndex(info, 2, 0, 0)).toBe(2)
  })

  test('falls back to SizeC when the channel list does not add up', () => {
    // SizeC=2 but a single 3-sample channel: malformed, keep SizeC.
    expect(rgbInfo && omeEffectiveSizeC(rgbInfo)).toBe(2)
  })

  test('is SizeC for ordinary one-sample channels', () => {
    const info = parseOmeXml(omeXml())
    expect(info && omeEffectiveSizeC(info)).toBe(2)
  })
})

describe('omeChannelName', () => {
  test('uses the stated name', () => {
    const info = parseOmeXml(omeXml())
    expect(info && omeChannelName(info, 1)).toBe('GFP')
  })

  test('falls back to a positional label for an unnamed or missing channel', () => {
    const info = parseOmeXml(
      omeXml('', '<Channel ID="Channel:0:0" Name="  "/>'),
    )
    expect(info && omeChannelName(info, 0)).toBe('Channel 0')
    expect(info && omeChannelName(info, 7)).toBe('Channel 7')
  })
})

describe('omeLengthToMicrons', () => {
  test('passes micrometres through unchanged', () => {
    expect(omeLengthToMicrons(0.65, 'µm')).toBe(0.65)
    expect(omeLengthToMicrons(0.65, undefined)).toBe(0.65)
    expect(omeLengthToMicrons(0.65, 'um')).toBe(0.65)
    expect(omeLengthToMicrons(0.65, 'micron')).toBe(0.65)
  })

  test('accepts a Greek mu in place of the micro sign', () => {
    // U+03BC (GREEK SMALL LETTER MU) instead of U+00B5 (MICRO SIGN): the two
    // are visually identical and writers use both.
    expect(omeLengthToMicrons(0.65, 'μm')).toBe(0.65)
    expect(omeLengthToMicrons(0.65, 'µm')).toBe(0.65)
  })

  test('scales other length units', () => {
    expect(omeLengthToMicrons(1, 'mm')).toBe(1000)
    expect(omeLengthToMicrons(1, 'cm')).toBe(10000)
    expect(omeLengthToMicrons(500, 'nm')).toBe(0.5)
    expect(omeLengthToMicrons(1, 'in')).toBe(25400)
  })

  test('accepts the spelled-out UDUNITS names OME-NGFF axes use', () => {
    // A zarr axis saying {"unit": "millimeter"} silently mis-sized volumes
    // by 1000x when only the SI symbols were recognised.
    expect(omeLengthToMicrons(0.02, 'millimeter')).toBe(20)
    expect(omeLengthToMicrons(0.02, 'millimetre')).toBe(20)
    expect(omeLengthToMicrons(1, 'meter')).toBe(1e6)
    expect(omeLengthToMicrons(1, 'centimeter')).toBe(1e4)
    expect(omeLengthToMicrons(1, 'nanometer')).toBe(1e-3)
    expect(omeLengthToMicrons(1, 'picometer')).toBe(1e-6)
    expect(omeLengthToMicrons(1, 'angstrom')).toBe(1e-4)
    expect(omeLengthToMicrons(1, 'foot')).toBe(304800)
    expect(omeLengthToMicrons(1, 'Micrometer')).toBe(1)
  })

  test('reports 0 rather than guessing for an unusable value or unit', () => {
    expect(omeLengthToMicrons(Number.NaN, 'µm')).toBe(0)
    expect(omeLengthToMicrons(0, 'µm')).toBe(0)
    expect(omeLengthToMicrons(-1, 'µm')).toBe(0)
    expect(omeLengthToMicrons(1, 'furlong')).toBe(0)
  })
})

describe('parseImageJDescription', () => {
  const description =
    'ImageJ=1.53t\nimages=60\nchannels=2\nslices=30\nframes=1\nhyperstack=true\nspacing=1.5\nunit=micron\nloop=false'

  test('reads the stack shape', () => {
    const info = parseImageJDescription(description)
    expect(info).toEqual({
      images: 60,
      channels: 2,
      slices: 30,
      frames: 1,
      spacingUm: 1.5,
    })
  })

  test('converts the spacing unit and takes the magnitude', () => {
    expect(
      parseImageJDescription('ImageJ=1.53\nspacing=-0.002\nunit=mm')?.spacingUm,
    ).toBeCloseTo(2, 9)
  })

  test('reports zero spacing for a unit it cannot interpret', () => {
    expect(
      parseImageJDescription('ImageJ=1.53\nspacing=3\nunit=pixel')?.spacingUm,
    ).toBe(0)
  })

  test('defaults a single-channel single-frame stack', () => {
    const info = parseImageJDescription('ImageJ=1.53t\nimages=12\nslices=12')
    expect(info?.channels).toBe(1)
    expect(info?.frames).toBe(1)
    expect(info?.slices).toBe(12)
  })

  test('returns null for anything that is not an ImageJ block', () => {
    expect(parseImageJDescription(undefined)).toBeNull()
    expect(parseImageJDescription('')).toBeNull()
    expect(parseImageJDescription(omeXml())).toBeNull()
  })
})
