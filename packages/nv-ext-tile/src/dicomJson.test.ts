import { describe, expect, test } from 'bun:test'
import { indexDicomWsi, type SlideIndexSlide, tileMap } from './dicomIndex'
import { type DicomJsonSlide, indexDicomWsiMetadata } from './dicomJson'

// Fixtures from fixtures/dicom-wsi/make_fixtures.py: each .json is its .dcm's
// PS3.18 DICOM JSON, binary values as BulkDataURIs (planes.json: InlineBinary).
const DIR = `${import.meta.dir}/../fixtures/dicom-wsi`

type Json = Record<string, unknown>
const json = async (name: string): Promise<Json> =>
  Bun.file(`${DIR}/${name}.json`).json()

async function local(names: string[]) {
  const files = await Promise.all(
    names.map(
      async (n) =>
        new File([await Bun.file(`${DIR}/${n}.dcm`).arrayBuffer()], `${n}.dcm`),
    ),
  )
  return indexDicomWsi(files)
}

/** Tile -> frame number per level, as a manifest lists them (0 for a hole). */
const tiles = (slide: SlideIndexSlide | DicomJsonSlide) =>
  slide.levels.map((l) =>
    Array.from(tileMap(l), (slot) => (slot < 0 ? 0 : l.frames.frame[slot])),
  )

/** What both readers must agree on: everything but byte spans and file identity. */
function comparable(
  slide: SlideIndexSlide | DicomJsonSlide,
  instances: { id: string }[],
) {
  const { iccProfile, levels, ...rest } = slide
  return {
    ...rest,
    // ImagedVolumeWidth is FL: float32 in the file, its decimal in JSON.
    pixelSpacingMM: rest.pixelSpacingMM?.map((v) => +v.toPrecision(6)),
    instances: instances.map((i) => i.id),
    colorSpace: iccProfile?.colorSpace,
    icc: iccProfile !== undefined,
    levels: levels.map(({ frames, ...l }) => ({
      ...l,
      instance: Array.from(frames.instance),
      frame: Array.from(frames.frame),
      tile: Array.from(frames.tile),
    })),
    tiles: tiles(slide),
  }
}

describe('indexDicomWsiMetadata', () => {
  test('indexes the same slides from DICOM JSON as from the files', async () => {
    const groups = [
      ['bot', 'bot-l1'],
      ['sparse'],
      ['dup'],
      ['paths'],
      ['concat-2', 'concat-1'],
      ['planes'],
      ['mono12'],
      ['noorg'],
    ]
    for (const names of groups) {
      const a = await local(names)
      const b = indexDicomWsiMetadata(await Promise.all(names.map(json)))
      expect(b.skipped).toEqual([])
      expect(a.slides.length).toBeGreaterThan(0)
      expect(b.slides.map((s) => comparable(s, s.instances))).toEqual(
        a.slides.map((s) => comparable(s, s.instances)),
      )
      // Instance fields other than file identity agree too.
      expect(
        b.slides.flatMap((s) => s.instances.map(({ input: _, ...i }) => i)),
      ).toEqual(
        a.slides.flatMap((s) =>
          s.instances.map(({ file: _f, size: _s, version: _v, ...i }) => i),
        ),
      )
    }
  })

  test('places frames: two focal planes, implicit order without an organization', async () => {
    const planes = indexDicomWsiMetadata([await json('planes')])
    // Plane 0 is the lower ZOffset, which frames 7-12 state.
    expect(planes.slides.map((s) => s.focalPlane)).toEqual([1, 0])
    expect(tiles(planes.slides[1] as DicomJsonSlide)).toEqual([
      [7, 8, 9, 10, 11, 12],
    ])
    const noorg = indexDicomWsiMetadata([await json('noorg')])
    expect(tiles(noorg.slides[0] as DicomJsonSlide)).toEqual([
      [1, 2, 3, 4, 5, 6],
    ])
  })

  test('reads ICC profiles, spacing fallbacks and pixel format', async () => {
    const [bot] = indexDicomWsiMetadata([await json('bot')]).slides
    expect(bot?.iccProfile).toEqual({
      bulkDataURI: 'bulk/1.2.3.10/00282000',
      colorSpace: 'SRGB',
    })
    expect(bot?.pixelSpacingMM).toEqual([0.00025, 0.0005])
    const [planes] = indexDicomWsiMetadata([await json('planes')]).slides
    const data = planes?.iccProfile?.data
    expect(new TextDecoder().decode(data?.subarray(36, 40))).toBe('acsp')
    const [mono] = indexDicomWsiMetadata([await json('mono12')]).slides
    expect(mono?.iccProfile).toBeUndefined()
    expect(mono?.pixelSpacingMM?.map((v) => +v.toFixed(6))).toEqual([
      0.0005, 0.0005,
    ])
    expect(mono?.instances[0]).toEqual({
      id: '1.2.3.91',
      transferSyntax: '1.2.840.10008.1.2.4.80',
      photometric: 'MONOCHROME2',
      bitsStored: 12,
      input: 0,
    })
  })

  test('keeps a [1,1] PixelSpacing when no ImagedVolumeWidth/Height replaces it', async () => {
    const meta = await json('bot')
    type Seq = { Value: Json[] }
    const shared = (meta['52009229'] as Seq).Value[0] as Json
    const measures = (shared['00289110'] as Seq).Value[0] as Json
    measures['00280030'] = { vr: 'DS', Value: [1, 1] }
    delete meta['00480001']
    delete meta['00480002']
    const [slide] = indexDicomWsiMetadata([meta]).slides
    expect(slide?.pixelSpacingMM).toEqual([1, 1])
  })

  test('takes AvailableTransferSyntaxUID, leaves an unstated one empty, skips native', async () => {
    const meta = await json('bot')
    delete meta['00020010']
    const ts = (v: Json) =>
      indexDicomWsiMetadata([v]).slides[0]?.instances[0]?.transferSyntax
    expect(ts(meta)).toBe('')
    const avail = {
      vr: 'UI',
      Value: ['1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.1'],
    }
    expect(ts({ ...meta, '00083002': avail })).toBe('1.2.840.10008.1.2.4.91')
    // A transcoding server listing explicit little endian first.
    avail.Value.reverse()
    expect(ts({ ...meta, '00083002': avail })).toBe('1.2.840.10008.1.2.4.91')
    // An undecodable compressed syntax listed before a decodable one.
    for (const [first, ok] of [
      ['1.2.840.10008.1.2.4.201', '1.2.840.10008.1.2.4.50'],
      ['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.80'],
    ]) {
      const v = { vr: 'UI', Value: [first, ok] }
      expect(ts({ ...meta, '00083002': v })).toBe(ok)
    }
    const native = (uid: string) =>
      indexDicomWsiMetadata([
        { ...meta, '00083002': { vr: 'UI', Value: [uid] } },
      ]).skipped.map((s) => [s.file, s.reason])
    expect(native('1.2.840.10008.1.2.1')).toEqual([
      ['1.2.3.10', 'uncompressed'],
    ])
    expect(native('1.2.840.10008.1.2')).toEqual([
      ['1.2.3.10', 'transfer-syntax'],
    ])
  })

  test('accepts dcmjs-naturalized instances (keywords, numeric strings, bare sequence items)', () => {
    const position = (x: number, y: number) => ({
      PlanePositionSlideSequence: {
        ColumnPositionInTotalImagePixelMatrix: String(x * 16 + 1),
        RowPositionInTotalImagePixelMatrix: [y * 16 + 1],
      },
      OpticalPathIdentificationSequence: [{ OpticalPathIdentifier: 'A' }],
    })
    const instance = {
      SOPInstanceUID: '9.1',
      StudyInstanceUID: '9.2',
      SeriesInstanceUID: '9.3',
      FrameOfReferenceUID: '9.4',
      ImageType: ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE'],
      AvailableTransferSyntaxUID: '1.2.840.10008.1.2.4.50',
      PhotometricInterpretation: 'YBR_FULL_422',
      DimensionOrganizationType: ['TILED_SPARSE'],
      Rows: 16,
      Columns: '16',
      NumberOfFrames: '2',
      TotalPixelMatrixColumns: 40,
      TotalPixelMatrixRows: 30,
      SharedFunctionalGroupsSequence: {
        PixelMeasuresSequence: { PixelSpacing: ['0.0005', '0.00025'] },
      },
      PerFrameFunctionalGroupsSequence: [position(2, 0), position(1, 1)],
      OpticalPathSequence: [
        {
          OpticalPathIdentifier: 'A',
          ICCProfile: { BulkDataURI: 'https://pacs/icc' },
          ColorSpace: 'SRGB',
        },
      ],
    }
    const { slides, skipped } = indexDicomWsiMetadata([instance])
    expect(skipped).toEqual([])
    const slide = slides[0] as DicomJsonSlide
    expect(slide.opticalPath).toBe('A')
    expect(slide.pixelSpacingMM).toEqual([0.00025, 0.0005])
    expect(slide.iccProfile).toEqual({
      bulkDataURI: 'https://pacs/icc',
      colorSpace: 'SRGB',
    })
    expect(tiles(slide)).toEqual([[0, 0, 1, 0, 2, 0]])
    expect(slide.levels[0]).toMatchObject({ holes: 4, sparse: true })
    // Per-frame groups left as bulk data are absent: implicit TILED_FULL order.
    const bulk = {
      ...instance,
      DimensionOrganizationType: undefined,
      NumberOfFrames: 6,
      PerFrameFunctionalGroupsSequence: { BulkDataURI: 'https://pacs/pf' },
    }
    expect(
      tiles(indexDicomWsiMetadata([bulk]).slides[0] as DicomJsonSlide),
    ).toEqual([[1, 2, 3, 4, 5, 6]])
    // Path B is not in OpticalPathSequence: it must not take the unnamed item's ICC.
    const unnamed = {
      ...bulk,
      SharedFunctionalGroupsSequence: {
        ...instance.SharedFunctionalGroupsSequence,
        OpticalPathIdentificationSequence: { OpticalPathIdentifier: 'B' },
      },
      OpticalPathSequence: [
        { OpticalPathIdentifier: 'A' },
        { ICCProfile: { BulkDataURI: 'https://pacs/other' } },
      ],
    }
    const [b] = indexDicomWsiMetadata([unnamed]).slides
    expect(b?.opticalPath).toBe('B')
    expect(b?.iccProfile).toBeUndefined()
  })

  test('bounds hostile metadata', () => {
    const base = {
      SOPInstanceUID: '9.1',
      ImageType: 'ORIGINAL\\PRIMARY\\VOLUME\\NONE',
      Rows: 16,
      Columns: 16,
      TotalPixelMatrixColumns: 32,
      TotalPixelMatrixRows: 32,
    }
    const reasons = (over: Json) =>
      indexDicomWsiMetadata([{ ...base, ...over }]).skipped.map((s) => [
        s.reason,
        s.message,
      ])
    const t0 = performance.now()
    expect(
      reasons({
        NumberOfFrames: 2 ** 30,
        TotalPixelMatrixFocalPlanes: 0xffff,
        NumberOfOpticalPaths: 0xffff,
      }),
    ).toEqual([
      [
        'malformed',
        'NumberOfFrames 1073741824 is past the 8388608 left of 8388608 for one call',
      ],
    ])
    expect(performance.now() - t0).toBeLessThan(100)
    expect(reasons({ TotalPixelMatrixColumns: 'abc' })[0]?.[0]).toBe(
      'malformed',
    )
    expect(reasons({ Rows: undefined })[0]?.[0]).toBe('not-tiled')
    expect(indexDicomWsiMetadata([null]).skipped.map((s) => s.file)).toEqual([
      'instances[0]',
    ])
  })

  test('skips one bad instance, not the call', async () => {
    const bot = await json('bot')
    const bad = structuredClone(bot)
    ;(bad['00480006'] as Json).Value = ['abc']
    ;(bad['00080018'] as Json).Value = ['bad']
    const { slides, skipped } = indexDicomWsiMetadata([bad, bot])
    expect(skipped.map((s) => [s.file, s.reason])).toEqual([
      ['bad', 'malformed'],
    ])
    expect(slides.map((s) => s.instances.map((i) => i.id))).toEqual([
      ['1.2.3.10'],
    ])
  })

  test('a bad ICC profile drops colour management, not the instance', async () => {
    const bot = await json('bot')
    const paths = bot['00480105'] as { Value: Json[] }
    ;(paths.Value[0] as Json)['00282000'] = { vr: 'OB', InlineBinary: '!' }
    const { slides, skipped } = indexDicomWsiMetadata([bot])
    expect(skipped).toEqual([])
    expect(slides[0]?.iccProfile).toBeUndefined()
  })

  test('bounds the frames of one call', () => {
    // Not VOLUME, so placed but never grouped: only the budget is exercised.
    const big = (sop: string) => ({
      SOPInstanceUID: sop,
      Rows: 1,
      Columns: 1,
      TotalPixelMatrixColumns: 2048,
      TotalPixelMatrixRows: 2048,
      NumberOfFrames: 3_000_000,
    })
    const { skipped } = indexDicomWsiMetadata([big('1'), big('2'), big('3')])
    expect(skipped.map((s) => [s.file, s.message])).toEqual([
      [
        '3',
        'NumberOfFrames 3000000 is past the 2388608 left of 8388608 for one call',
      ],
    ])
  })

  test('reads absent and empty values as a file states them', async () => {
    const bot = await json('bot')
    const opticalPath = (item: Json) => {
      const o = structuredClone(bot)
      ;(o['00480105'] as { Value: Json[] }).Value = [item]
      return indexDicomWsiMetadata([o]).slides[0]?.opticalPath
    }
    // No identifier: named by its index; an empty one: ''.
    expect(opticalPath({})).toBe('0')
    expect(opticalPath({ '00480106': { vr: 'SH' } })).toBe('')
    // An empty ZOffset (DS) is 0, as a file's zero-length DS reads Number('').
    const o = structuredClone(bot)
    const shared = (o['52009229'] as { Value: Json[] }).Value[0] as Json
    shared['0048021A'] = { vr: 'SQ', Value: [{ '0040074A': { vr: 'DS' } }] }
    const r = indexDicomWsiMetadata([o])
    expect(r.skipped).toEqual([])
    expect(r.slides.map((s) => s.focalPlane)).toEqual([0])
  })

  // OHIF's test slide gives each pyramid level its own FrameOfReferenceUID.
  test('joins levels apart only by frame of reference; a rescan stays apart', async () => {
    const tagged = (o: Json, sop: string, fr: string): Json => ({
      ...o,
      '00080018': { vr: 'UI', Value: [sop] },
      '00200052': { vr: 'UI', Value: [fr] },
    })
    const [bot, l1] = await Promise.all([json('bot'), json('bot-l1')])
    // The fixture's level 1 keeps level 0's spacing; a real one doubles it.
    const spaced = (o: Json, mm: number[]): Json => ({
      ...o,
      '52009229': {
        vr: 'SQ',
        Value: [
          {
            '00289110': {
              vr: 'SQ',
              Value: [{ '00280030': { vr: 'DS', Value: mm } }],
            },
          },
        ],
      },
    })
    const levels = indexDicomWsiMetadata([
      tagged(bot as Json, '9.1', '9.10'),
      tagged(spaced(l1 as Json, [0.001, 0.0005]), '9.2', '9.11'),
    ])
    expect(
      levels.slides.map((s) => [s.levels.length, s.frameOfReference]),
    ).toEqual([[2, '9.10']])
    // Another scan: no size in common, but half the width.
    const other = indexDicomWsiMetadata([
      tagged(bot as Json, '9.1', '9.10'),
      tagged(l1 as Json, '9.2', '9.11'),
    ])
    expect(other.slides.map((s) => s.levels.length)).toEqual([1, 1])
    const rescan = indexDicomWsiMetadata([
      tagged(bot as Json, '9.1', '9.10'),
      tagged(bot as Json, '9.3', '9.12'),
    ])
    expect(rescan.slides.map((s) => s.levels.length)).toEqual([1, 1])
  })
})
