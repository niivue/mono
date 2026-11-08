import { afterEach, describe, expect, it } from 'bun:test'
import dcmjs from 'dcmjs'
import {
  assemblePart10,
  type DcmjsDicomDictCtor,
  reconstructInstanceFiles,
  seriesMetadataUrl,
  sopFromInstanceUrl,
} from './reconstructP10'

const instanceUrl = 'https://host/dicomweb/studies/1.2/series/3.4/instances/5.6'

describe('instance URL helpers', () => {
  it('derives the series metadata URL and the sop uid', () => {
    expect(seriesMetadataUrl(instanceUrl)).toBe(
      'https://host/dicomweb/studies/1.2/series/3.4/metadata',
    )
    expect(sopFromInstanceUrl(instanceUrl)).toBe('5.6')
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
      [pixels],
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
      [pixels],
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
      [frame],
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

  describe('reconstructInstanceFiles', () => {
    const JPEG_LS = '1.2.840.10008.1.2.4.80'
    const otherUrl = instanceUrl.replace('5.6', '7.8')
    const enhanced = {
      ...metadata,
      '00080018': { vr: 'UI', Value: ['5.6'] },
      '00280008': { vr: 'IS', Value: ['3'] },
    }
    const other = { ...metadata, '00080018': { vr: 'UI', Value: ['7.8'] } }
    const frameBytes = (n: number) => new Uint8Array(8).fill(n)
    const realFetch = globalThis.fetch
    afterEach(() => {
      globalThis.fetch = realFetch
    })

    // Serves `/metadata`, per-frame JPEG-LS bulkdata, and `instance()` for
    // RetrieveInstance; returns the requested URLs.
    function serve(instance: () => Response): string[] {
      const urls: string[] = []
      globalThis.fetch = (async (url: string) => {
        urls.push(url)
        if (url.endsWith('/metadata')) return Response.json([enhanced, other])
        const frame = /\/frames\/(\d+)$/.exec(url)?.[1]
        if (!frame) return instance()
        return new Response(frameBytes(Number(frame)), {
          headers: { 'content-type': `image/jls; transfer-syntax=${JPEG_LS}` },
        })
      }) as unknown as typeof fetch
      return urls
    }
    const refused = () => new Response('', { status: 403 })

    it('reconstructs a 3-frame instance as one P10, one fragment per frame', async () => {
      const urls = serve(refused)
      const progress: Array<[number, number]> = []
      const [file, ...rest] = await reconstructInstanceFiles(
        [{ url: instanceUrl, frames: 3 }],
        { onProgress: (loaded, total) => progress.push([loaded, total]) },
      )
      if (!file) throw new Error('no file')
      expect(rest).toHaveLength(0)
      expect(file.name).toBe('5.6.dcm')
      expect(urls.filter((u) => u.includes('/frames/')).sort()).toEqual(
        [1, 2, 3].map((n) => `${instanceUrl}/frames/${n}`),
      )
      const readBack = DicomMessage.readFile(await file.arrayBuffer())
      const pd = readBack.dict['7FE00010'] as { Value: ArrayBuffer[] }
      // The Basic Offset Table splits the fragments back into frames 1..3.
      expect(pd.Value.map((v) => [...new Uint8Array(v)])).toEqual(
        [1, 2, 3].map((n) => [...frameBytes(n)]),
      )
      const ds = DicomMetaDictionary.naturalizeDataset(readBack.dict)
      expect(ds.NumberOfFrames).toBe(3)
      expect(progress.at(-1)).toEqual([3, 3])
    })

    it('probes RetrieveInstance once, then reconstructs a single-frame series', async () => {
      let cancelled = false
      const urls = serve(
        () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true
              },
            }),
            { status: 403 },
          ),
      )
      const files = await reconstructInstanceFiles([
        { url: instanceUrl, frames: 1 },
        { url: otherUrl, frames: 1 },
      ])
      expect(files.map((f) => f.name)).toEqual(['5.6.dcm', '7.8.dcm'])
      expect(urls).toEqual([
        instanceUrl,
        'https://host/dicomweb/studies/1.2/series/3.4/metadata',
        `${instanceUrl}/frames/1`,
        `${otherUrl}/frames/1`,
      ])
      expect(cancelled).toBe(true) // the refused body is not left downloading
    })

    it('uses RetrieveInstance when the server allows it', async () => {
      const p10 = assemblePart10(
        DicomDict as unknown as DcmjsDicomDictCtor,
        enhanced,
        [1, 2, 3].map(frameBytes),
        JPEG_LS,
      )
      const urls = serve(
        () =>
          new Response(p10, {
            headers: { 'content-type': 'application/dicom' },
          }),
      )
      const files = await reconstructInstanceFiles([
        { url: instanceUrl, frames: 3 },
        { url: otherUrl, frames: 1 },
      ])
      expect(urls).toEqual([instanceUrl, otherUrl])
      expect(files.map((f) => f.size)).toEqual([p10.byteLength, p10.byteLength])
    })

    it('reconstructs when RetrieveInstance answers 200 without a DICOM body', async () => {
      const urls = serve(() => new Response('<html>not found</html>'))
      const files = await reconstructInstanceFiles([
        { url: instanceUrl, frames: 3 },
      ])
      expect(files).toHaveLength(1)
      expect(urls.filter((u) => u.includes('/frames/'))).toHaveLength(3)
    })
  })
})
