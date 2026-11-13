import { expect, test } from 'bun:test'
import type { NVSlideTileManifest } from '@niivue/niivue'
import { indexDicomWsiOnThread, tileMap } from './dicomIndex'
import { indexDicomWsiMetadata } from './dicomJson'
import { DicomWsiSource, manifestOf } from './dicomWsiSource'

const DIR = `${import.meta.dir}/../fixtures/dicom-wsi`
const files = (...names: string[]) =>
  Promise.all(
    names.map(
      async (n) =>
        new File([await Bun.file(`${DIR}/${n}`).arrayBuffer()], n, {
          lastModified: 1,
        }),
    ),
  )
const label = (b: Uint8Array) =>
  new TextDecoder().decode(b.subarray(6, -2)).trim()

async function sourceOf(name: string, options = {}) {
  const fs = await files(name)
  const slide = (await indexDicomWsiOnThread(fs)).slides[0]
  if (!slide) throw new Error(name)
  return new DicomWsiSource(slide, fs, options)
}
const first = (s: DicomWsiSource) => {
  const level = s.manifest.levels[0]
  const tile = level?.tiles.find((t): t is NVSlideTileManifest => !!t)
  if (!level || !tile) throw new Error('no tile')
  return { level, tile }
}

test('counts wire bytes with the item header', async () => {
  const s = await sourceOf('bot.dcm')
  let wire = 0
  s.bind({ addWireBytes: (n: number) => (wire += n) } as never)
  const { level, tile } = first(s)
  const bytes = await s.fetchTileBytes(level, tile, '')
  expect(wire).toBe(bytes.length + 8)
})

test('serves the ICC profile from the level-0 file, and null without one', async () => {
  const icc = await (await sourceOf('bot.dcm')).fetchIccProfile()
  expect(icc?.length).toBe(128)
  expect(new TextDecoder().decode(icc?.subarray(36, 40))).toBe('acsp')
  expect(await (await sourceOf('mono12.dcm')).fetchIccProfile()).toBeNull()
})

test('L4: dispose rejects reads in flight and later, AbortError; idempotent', async () => {
  const s = await sourceOf('bot.dcm')
  const { level, tile } = first(s)
  const reads = Promise.allSettled([
    s.fetchTileBytes(level, tile, ''),
    s.fetchIccProfile(),
  ])
  s.dispose()
  s.dispose()
  expect(
    (await reads).map((r) => r.status === 'rejected' && r.reason.name),
  ).toEqual(['AbortError', 'AbortError'])
  await expect(s.fetchTileBytes(level, tile, '')).rejects.toMatchObject({
    name: 'AbortError',
  })
})

test('an aborted signal rejects the read', async () => {
  const s = await sourceOf('bot.dcm')
  const { level, tile } = first(s)
  const ac = new AbortController()
  const read = s.fetchTileBytes(level, tile, '', ac.signal)
  ac.abort()
  await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  // The source itself stays usable.
  expect(label(await s.fetchTileBytes(level, tile, ''))).toBe('bot f1')
})

test('states a caller attribution as text, dropping a non-http url', async () => {
  const s = await sourceOf('bot.dcm', {
    attribution: { title: 'Bot', url: 'data:x' },
  })
  expect(s.manifest.attribution).toEqual({ title: 'Bot' })
})

test('S7: a signed MONOCHROME2 JPEG states i16 samples and its rescale as one grey channel', async () => {
  const m = (await sourceOf('monosigned.dcm')).manifest
  expect(m.levels.every((l) => l.sampleType === 'i16')).toBe(true)
  expect(m.channelInfo).toEqual([
    {
      name: 'gray',
      active: true,
      storedToValue: { scale: 2, offset: -10, quantized: false },
    },
  ])
  // Unsigned monochrome without a rescale: one plain grey channel.
  const mono = (await sourceOf('mono12.dcm')).manifest
  expect(mono.levels[0]?.sampleType).toBeUndefined()
  expect(mono.channelInfo).toEqual([{ name: 'gray', active: true }])
  // Colour states none: it stays an RGB slide.
  expect((await sourceOf('bot.dcm')).manifest.channelInfo).toBeUndefined()
  // DICOM JSON gives the same.
  const json = await Bun.file(`${DIR}/monosigned.json`).json()
  const slide = indexDicomWsiMetadata([json]).slides[0]
  if (!slide) throw new Error('json')
  const fromJson = manifestOf(slide, slide.levels.map(tileMap), {
    fileUrl: () => '',
  })
  expect(fromJson.channelInfo).toEqual(m.channelInfo)
  expect(fromJson.levels[0]?.sampleType).toBe('i16')
})
