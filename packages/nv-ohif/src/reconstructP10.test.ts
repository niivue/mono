import { describe, expect, it } from 'bun:test'
import dcmjs from 'dcmjs'
import {
  assemblePart10,
  type DcmjsDicomDictCtor,
  framesUrlFromImageId,
  seriesMetadataUrlFromFramesUrl,
  sopFromFramesUrl,
} from './reconstructP10'

const framesUrl =
  'https://host/dicomweb/studies/1.2/series/3.4/instances/5.6/frames/1'

describe('frames URL helpers', () => {
  it('extracts the absolute frames URL from a wadors imageId', () => {
    expect(framesUrlFromImageId(`wadors:${framesUrl}`)).toBe(framesUrl)
    expect(framesUrlFromImageId(framesUrl)).toBe(framesUrl)
  })

  it('rejects non-frame ids', () => {
    expect(
      framesUrlFromImageId('wadors:https://host/dicomweb/studies/1.2'),
    ).toBeNull()
    expect(framesUrlFromImageId('dicomfile:/a.dcm')).toBeNull()
  })

  it('derives the series metadata URL and the sop uid', () => {
    expect(seriesMetadataUrlFromFramesUrl(framesUrl)).toBe(
      'https://host/dicomweb/studies/1.2/series/3.4/metadata',
    )
    expect(sopFromFramesUrl(framesUrl)).toBe('5.6')
  })
})

describe('assemblePart10', () => {
  const { DicomDict, DicomMessage, DicomMetaDictionary } = (
    dcmjs as unknown as {
      data: {
        DicomDict: new (
          meta: Record<string, unknown>,
        ) => {
          meta: Record<string, unknown>
          dict: Record<string, unknown>
          write(): ArrayBuffer
        }
        DicomMessage: {
          readFile: (buf: ArrayBuffer) => {
            dict: Record<string, unknown>
            meta: Record<string, unknown>
          }
        }
        DicomMetaDictionary: {
          naturalizeDataset: (
            d: Record<string, unknown>,
          ) => Record<string, unknown>
        }
      }
    }
  ).data

  // Minimal CT-ish instance metadata (dicom+json), 4x4 16-bit.
  const metadata = {
    '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.2'] },
    '00080018': { vr: 'UI', Value: ['1.2.3.4.5'] },
    '00200013': { vr: 'IS', Value: ['7'] },
    '00280002': { vr: 'US', Value: [1] },
    '00280004': { vr: 'CS', Value: ['MONOCHROME2'] },
    '00280010': { vr: 'US', Value: [4] },
    '00280011': { vr: 'US', Value: [4] },
    '00280100': { vr: 'US', Value: [16] },
    '00280101': { vr: 'US', Value: [16] },
    '00280103': { vr: 'US', Value: [0] },
    // BulkDataURI-only pixel element; assemblePart10 must replace it with real bytes.
    '7FE00010': { vr: 'OW', BulkDataURI: 'instances/1.2.3.4.5/frames' },
  }

  it('produces a P10 dcmjs can read back with tags + pixels intact', () => {
    const pixels = new Uint8Array(4 * 4 * 2)
    for (let i = 0; i < pixels.length; i++) pixels[i] = i & 0xff

    const buffer = assemblePart10(
      DicomDict as unknown as DcmjsDicomDictCtor,
      metadata,
      pixels,
    )
    // A valid P10 has the 128-byte preamble + "DICM" magic.
    expect(new TextDecoder().decode(new Uint8Array(buffer, 128, 4))).toBe(
      'DICM',
    )

    const readBack = DicomMessage.readFile(buffer)
    const ds = DicomMetaDictionary.naturalizeDataset(readBack.dict) as {
      SOPInstanceUID: string
      Rows: number
      Columns: number
      PixelData: ArrayBuffer[] | ArrayBuffer
    }
    expect(ds.SOPInstanceUID).toBe('1.2.3.4.5')
    expect(ds.Rows).toBe(4)
    expect(ds.Columns).toBe(4)
    const pd = Array.isArray(ds.PixelData) ? ds.PixelData[0] : ds.PixelData
    expect((pd as ArrayBuffer).byteLength).toBe(32)

    // File-meta group must not leak into the dataset.
    expect(readBack.dict['00020010']).toBeUndefined()
    const meta = DicomMetaDictionary.naturalizeDataset(readBack.meta) as {
      TransferSyntaxUID: string
    }
    expect(meta.TransferSyntaxUID).toBe('1.2.840.10008.1.2.1')
  })

  it('drops InlineBinary/BulkDataURI elements (top-level and nested) so write succeeds', () => {
    const withBinaries = {
      ...metadata,
      // Top-level OB with InlineBinary but no Value (dcmjs would otherwise throw).
      '00189306': { vr: 'OB', InlineBinary: 'AAAA' },
      // Element missing its `vr` (some servers omit it) -> dcmjs treats as UN and
      // throws; must be dropped.
      '00083002': { Value: ['1.2.840.10008.1.2.4.80'] },
      // A sequence carrying a nested unmaterialized binary + a real value.
      '00082112': {
        vr: 'SQ',
        Value: [
          {
            '00189308': { vr: 'OB', InlineBinary: 'BBBB' },
            '0008103E': { vr: 'LO', Value: ['ref'] },
          },
        ],
      },
    }
    const pixels = new Uint8Array(4 * 4 * 2)
    // Must not throw despite the unmaterialized binaries.
    const buffer = assemblePart10(
      DicomDict as unknown as DcmjsDicomDictCtor,
      withBinaries,
      pixels,
    )
    const readBack = DicomMessage.readFile(buffer)
    expect(readBack.dict['00189306']).toBeUndefined()
    expect(readBack.dict['00083002']).toBeUndefined()
    expect(readBack.dict['00082112']).toBeDefined()
  })

  it('writes compressed pixels encapsulated under the given transfer syntax', () => {
    const JPEG_LS = '1.2.840.10008.1.2.4.80'
    const frame = new Uint8Array(64)
    for (let i = 0; i < frame.length; i++) frame[i] = (i * 7) & 0xff

    const buffer = assemblePart10(
      DicomDict as unknown as DcmjsDicomDictCtor,
      metadata,
      frame,
      JPEG_LS,
    )
    const readBack = DicomMessage.readFile(buffer)
    const meta = DicomMetaDictionary.naturalizeDataset(readBack.meta) as {
      TransferSyntaxUID: string
    }
    expect(meta.TransferSyntaxUID).toBe(JPEG_LS)
    // Encapsulated PixelData is OB; the fragment bytes survive the round-trip.
    const pd = readBack.dict['7FE00010'] as { vr: string; Value: ArrayBuffer[] }
    expect(pd.vr).toBe('OB')
    const bytes = new Uint8Array(pd.Value[pd.Value.length - 1] as ArrayBuffer)
    expect(bytes.length).toBe(64)
  })
})
