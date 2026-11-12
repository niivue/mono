import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { MAX_SLIDE_GRID, type NVSlideTileManifest } from '@niivue/niivue'
import {
  blockReader,
  indexDicomWsiOnThread,
  MAX_SLIDE_TILES,
  type SlideIndex,
  type SlideIndexLevel,
  type SlideIndexSlide,
  tileMap,
} from './dicomIndex'
import { DicomWsiSource } from './dicomWsiSource'

// Fixtures from fixtures/dicom-wsi/make_fixtures.py: each frame's payload is
// FF D8 FF FE <len> <label> FF D9, so a tile's bytes name the tile.
const DIR = `${import.meta.dir}/../fixtures/dicom-wsi`

async function file(name: string, lastModified = 1): Promise<File> {
  return new File([await Bun.file(`${DIR}/${name}`).arrayBuffer()], name, {
    lastModified,
  })
}

async function index(
  ...names: string[]
): Promise<{ idx: SlideIndex; files: File[] }> {
  const files = await Promise.all(names.map((n) => file(n)))
  return { idx: await indexDicomWsiOnThread(files), files }
}

const label = (bytes: Uint8Array): string => {
  expect([bytes[0], bytes[1], bytes.at(-2), bytes.at(-1)]).toEqual([
    0xff, 0xd8, 0xff, 0xd9,
  ])
  return new TextDecoder().decode(bytes.subarray(6, -2)).trim()
}

/** Every present tile's label, row-major, '' for a hole, read through DicomWsiSource. */
async function labels(
  slide: SlideIndexSlide,
  files: File[],
  level = 0,
): Promise<string[]> {
  const source = new DicomWsiSource(slide, files)
  const lvl = source.manifest.levels[level]
  if (!lvl) throw new Error(`no level ${level}`)
  return Promise.all(
    lvl.tiles.map(async (t) =>
      t ? label(await source.fetchTileBytes(lvl, t, '')) : '',
    ),
  )
}

const only = (idx: SlideIndex): SlideIndexSlide => {
  expect(idx.slides).toHaveLength(1)
  return idx.slides[0] as SlideIndexSlide
}

describe('indexDicomWsiOnThread', () => {
  test('groups a series into levels, finest first, with frame spans that hold each tile', async () => {
    const { idx, files } = await index('bot-l1.dcm', 'bot.dcm')
    const slide = only(idx)
    expect(
      slide.levels.map((l) => [l.width, l.height, l.columns, l.rows]),
    ).toEqual([
      [40, 30, 3, 2],
      [20, 15, 2, 1],
    ])
    expect(slide.pixelSpacingMM).toEqual([0.00025, 0.0005])
    expect(slide.levels[0]?.sparse).toBe(false)
    expect(await labels(slide, files)).toEqual([
      'bot f1',
      'bot f2',
      'bot f3',
      'bot f4',
      'bot f5',
      'bot f6',
    ])
    // The ICC profile range in the level-0 file holds a profile.
    const icc = slide.iccProfile
    if (!icc) throw new Error('expected an ICC profile')
    const bytes = new Uint8Array(
      await (files[1] as File)
        .slice(icc.offset, icc.offset + icc.length)
        .arrayBuffer(),
    )
    expect(new TextDecoder().decode(bytes.subarray(36, 40))).toBe('acsp')
    expect(icc.colorSpace).toBe('SRGB')
  })

  test('the Basic Offset Table, the Extended Offset Table and an item walk agree', async () => {
    for (const name of ['nobot', 'eot']) {
      const { idx, files } = await index(`${name}.dcm`)
      const expected = [1, 2, 3, 4, 5, 6].map((f) => `${name} f${f}`)
      expect(await labels(only(idx), files)).toEqual(expected)
    }
  })

  test('joins a frame split across fragments, with or without a BOT', async () => {
    for (const name of ['frag-bot', 'frag-walk']) {
      const { idx, files } = await index(`${name}.dcm`)
      expect((await labels(only(idx), files))[4]).toBe(`${name} f5`)
    }
  })

  test('places TILED_SPARSE frames by position, leaving holes', async () => {
    const { idx, files } = await index('sparse.dcm')
    const slide = only(idx)
    const l0 = slide.levels[0] as SlideIndexLevel
    expect(Array.from(tileMap(l0))).toEqual([0, -1, 1, -1, 2, 3])
    expect([l0.holes, l0.duplicates]).toEqual([2, 0])
    expect(await labels(slide, files)).toEqual([
      'sparse x0y0',
      '',
      'sparse x2y0',
      '',
      'sparse x1y1',
      'sparse x2y1',
    ])
    const level = new DicomWsiSource(slide, files).manifest.levels[0]
    expect(level).toMatchObject({
      sparse: true,
      opticalPaths: 1,
      focalPlanes: 1,
      frames: 4,
    })
  })

  test('reports a duplicated tile position, keeping the first', async () => {
    const { idx } = await index('dup.dcm')
    expect(only(idx).levels[0]?.duplicates).toBe(1)
  })

  test('makes one slide per optical path', async () => {
    const { idx, files } = await index('paths.dcm')
    expect(idx.slides.map((s) => s.opticalPath)).toEqual(['1', '2'])
    expect((await labels(idx.slides[1] as SlideIndexSlide, files))[0]).toBe(
      'paths f7',
    )
  })

  test('joins a concatenation into one level', async () => {
    const { idx, files } = await index('concat-2.dcm', 'concat-1.dcm')
    const slide = only(idx)
    expect(slide.instances.map((i) => i.file)).toEqual([
      'concat-1.dcm',
      'concat-2.dcm',
    ])
    expect(await labels(slide, files)).toEqual(
      [1, 2, 3, 4, 5, 6].map((f) => `concat f${f}`),
    )
  })

  test('takes pixel spacing from ImagedVolumeWidth/Height over a [1,1] PixelSpacing placeholder', async () => {
    const slide = only((await index('mono12.dcm')).idx)
    // FL in the file: 0.02 mm over 40 columns, 0.015 mm over 30 rows.
    expect(slide.pixelSpacingMM?.[0]).toBeCloseTo(0.0005, 9)
    expect(slide.pixelSpacingMM?.[1]).toBeCloseTo(0.0005, 9)
  })

  test('places frames by focal plane, and in implicit order without an organization', async () => {
    const planes = await index('planes.dcm')
    // Plane 0 is the lower ZOffset, which frames 7-12 state.
    expect(planes.idx.slides.map((s) => s.focalPlane)).toEqual([1, 0])
    expect(
      await labels(planes.idx.slides[1] as SlideIndexSlide, planes.files),
    ).toEqual([7, 8, 9, 10, 11, 12].map((f) => `planes f${f}`))
    // Spacing per frame (planes) and at the top level (noorg).
    expect(planes.idx.slides[0]?.pixelSpacingMM).toEqual([0.00025, 0.0005])
    const noorg = await index('noorg.dcm')
    expect(await labels(only(noorg.idx), noorg.files)).toEqual(
      [1, 2, 3, 4, 5, 6].map((f) => `noorg f${f}`),
    )
    expect(only(noorg.idx).pixelSpacingMM).toEqual([0.00025, 0.0005])
  })

  test('skips what it cannot index, with a typed reason', async () => {
    const { idx } = await index(
      'implicit.dcm',
      'bigendian.dcm',
      'deflated.dcm',
      'not-dicom.dcm',
    )
    expect(idx.slides).toHaveLength(0)
    expect(idx.skipped.map((s) => [s.file, s.reason])).toEqual([
      ['implicit.dcm', 'transfer-syntax'],
      ['bigendian.dcm', 'transfer-syntax'],
      ['deflated.dcm', 'transfer-syntax'],
      ['not-dicom.dcm', 'not-dicom'],
    ])
  })
})

test('an abort during a file read rejects the index, not a skipped file', async () => {
  const stop = new AbortController()
  const read = async (): Promise<Uint8Array> => {
    stop.abort()
    throw stop.signal.reason
  }
  const one = new File([new Uint8Array(256)], 'one.dcm')
  const indexed = indexDicomWsiOnThread([one], ['one.dcm'], read, {
    signal: stop.signal,
  })
  await expect(indexed).rejects.toMatchObject({ name: 'AbortError' })
})

describe('DicomWsiSource', () => {
  test('describes the slide for NVSlide', async () => {
    const { idx, files } = await index('bot.dcm', 'bot-l1.dcm')
    const m = new DicomWsiSource(only(idx), files).manifest
    expect(m).toMatchObject({
      format: 'dicom-wsi-index-v1',
      width: 40,
      height: 30,
      pixelSpacingMM: [0.00025, 0.0005],
    })
    expect(m.iccProfile).toMatchObject({ url: 'bot.dcm', colorSpace: 'SRGB' })
    expect(m.levels[0]).toMatchObject({
      codec: 'image/jpeg',
      photometric: 'YBR_FULL_422',
      bitsStored: 8,
      frames: 6,
      opticalPaths: 1,
      focalPlanes: 1,
      downsample: 1,
    })
    expect(m.levels[0]?.sparse).toBeUndefined()
    // Edge tiles are clipped to the image.
    expect((m.levels[0]?.tiles[5] as NVSlideTileManifest).width).toBe(8)
    expect(m.levels[1]?.downsample).toBe(2)
  })

  test('refuses a frame that is not where the index says', async () => {
    const { idx, files } = await index('bot.dcm')
    const slide = only(idx)
    const source = new DicomWsiSource(slide, files)
    const frames = slide.levels[0]?.frames
    if (!frames) throw new Error('no frames')
    frames.offset[0] = (frames.offset[0] as number) + 2
    const level = source.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('no tile')
    await expect(source.fetchTileBytes(level, tile, '')).rejects.toThrow(
      /not where the index says/,
    )
  })

  test('refuses files that changed since they were indexed', async () => {
    const { idx } = await index('bot.dcm')
    expect(() => new DicomWsiSource(only(idx), [])).toThrow(
      /not among the files/,
    )
    const touched = [await file('bot.dcm', 2)]
    expect(() => new DicomWsiSource(only(idx), touched)).toThrow(
      /changed since/,
    )
  })
})

test('the slide tile cap follows the grid NVSlide accepts', () => {
  expect(MAX_SLIDE_TILES).toBe(2 * MAX_SLIDE_GRID)
})

test('the worker block reader indexes every fixture as File.slice does', async () => {
  const names = readdirSync(DIR).filter((n) => n.endsWith('.dcm'))
  const files = await Promise.all(names.map((n) => file(n)))
  const bytes = new Map(
    await Promise.all(
      files.map(
        async (f) => [f, new Uint8Array(await f.arrayBuffer())] as const,
      ),
    ),
  )
  const readSync = (f: File, offset: number, length: number): Uint8Array =>
    bytes.get(f)?.slice(offset, offset + length) ?? new Uint8Array(0)
  const keys = names.map((n) => `dir/${n}`)
  const want = await indexDicomWsiOnThread(files, keys)
  expect(want.slides.length).toBeGreaterThan(0)
  expect(want.slides[0]?.instances[0]?.file).toStartWith('dir/')
  // 64-byte blocks: many refills and pass-through header reads.
  for (const blockBytes of [64, 1 << 20]) {
    expect(
      await indexDicomWsiOnThread(
        files,
        keys,
        blockReader(readSync, blockBytes),
      ),
    ).toEqual(want)
  }
})
