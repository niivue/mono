import { describe, expect, test } from 'bun:test'
import type { NVSlideManifest, NVSlideTileManifest } from '@niivue/niivue'
import {
  indexDicomWsiOnThread,
  type SlideIndexLevel,
  tileMap,
} from './dicomIndex'
import { DicomWsiSource } from './dicomWsiSource'
import { manifestFromIndex } from './hostedManifest'

const DIR = `${import.meta.dir}/../fixtures/dicom-wsi`

async function open(...names: string[]) {
  const files = await Promise.all(
    names.map(
      async (n) =>
        new File([await Bun.file(`${DIR}/${n}`).arrayBuffer()], n, {
          lastModified: 1,
        }),
    ),
  )
  const slide = (await indexDicomWsiOnThread(files)).slides[0]
  if (!slide) throw new Error('no slide')
  const manifest = await manifestFromIndex(
    slide,
    files,
    (i) => `files/${i.file}`,
  )
  return { files, slide, manifest }
}

// A tile's bytes read the way ManifestRangeSource reads them: its ranges of its file.
async function hosted(
  manifest: NVSlideManifest,
  files: File[],
  level: number,
  tile: NVSlideTileManifest,
): Promise<Uint8Array> {
  const url = tile.fileUrl ?? manifest.levels[level]?.fileUrl ?? ''
  const file = files.find((f) => `files/${f.name}` === url)
  if (!file) throw new Error(`no file for ${url}`)
  const ranges = tile.fragments ?? [
    { offset: tile.offset as number, length: tile.length as number },
  ]
  const parts = await Promise.all(
    ranges.map(
      async (r) =>
        new Uint8Array(
          await file.slice(r.offset, r.offset + r.length).arrayBuffer(),
        ),
    ),
  )
  return new Uint8Array(parts.flatMap((p) => [...p]))
}

// Every listed tile must read the same bytes as DicomWsiSource gives for it.
async function expectSameBytes(names: string[]): Promise<NVSlideManifest> {
  const { files, slide, manifest } = await open(...names)
  const local = new DicomWsiSource(slide, files)
  for (const [li, level] of manifest.levels.entries()) {
    const localLevel = local.manifest.levels[li]
    for (const tile of level.tiles) {
      if (!tile || !localLevel) continue
      const twin = localLevel.tiles[tile.y * localLevel.columns + tile.x]
      if (!twin) throw new Error(`no local tile ${tile.x},${tile.y}`)
      const want = await local.fetchTileBytes(localLevel, twin, '')
      expect(await hosted(manifest, files, li, tile)).toEqual(want)
    }
  }
  return manifest
}

describe('manifestFromIndex', () => {
  test('a full level reads by range from the level file', async () => {
    const m = await expectSameBytes(['bot.dcm'])
    expect(m.format).toBe('dicom-wsi-range-v1')
    expect(m.displayYAxis).toBe('down')
    expect(m.levels[0]?.fileUrl).toBe('files/bot.dcm')
    expect(m.levels[0]?.tiles.every((t) => t && !t.fileUrl)).toBe(true)
  })

  test('a sparse level lists only its present tiles', async () => {
    const { slide, manifest } = await open('sparse.dcm')
    const level = manifest.levels[0]
    const present = [...tileMap(slide.levels[0] as SlideIndexLevel)].filter(
      (s) => s >= 0,
    )
    expect(level?.sparse).toBe(true)
    expect(level?.tiles.length).toBe(present.length)
    expect(present.length).toBeLessThan(
      (level?.columns ?? 0) * (level?.rows ?? 0),
    )
    await expectSameBytes(['sparse.dcm'])
  })

  test('a concatenation names each tile file', async () => {
    const m = await expectSameBytes(['concat-1.dcm', 'concat-2.dcm'])
    const urls = new Set(m.levels[0]?.tiles.map((t) => t?.fileUrl))
    expect(m.levels[0]?.fileUrl).toBeUndefined()
    expect(urls).toEqual(new Set(['files/concat-1.dcm', 'files/concat-2.dcm']))
  })

  test('a multi-fragment frame lists its fragments', async () => {
    const m = await expectSameBytes(['frag-bot.dcm'])
    expect(
      m.levels[0]?.tiles.some((t) => (t?.fragments?.length ?? 0) > 1),
    ).toBe(true)
  })
})
