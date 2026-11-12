import { expect, test } from 'bun:test'
import type {
  NVSlideManifest,
  NVSlideTileManifest,
  SlideTileSource,
} from '@niivue/niivue'
import { indexDicomWsiOnThread } from './dicomIndex'
import { DicomPlaneStack, focalStacks } from './dicomPlanes'
import { DicomWsiSource } from './dicomWsiSource'

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

async function stackOf(...names: string[]) {
  const fs = await files(...names)
  const idx = await indexDicomWsiOnThread(fs)
  const [stack] = focalStacks(idx.slides)
  if (!stack) throw new Error('no stack')
  return {
    stack,
    source: new DicomPlaneStack(
      stack.map((s) => new DicomWsiSource(s, fs)),
      { zPositionsUm: stack.map((s) => s.zOffsetUm ?? Number.NaN) },
    ),
  }
}

const firstTile = (m: NVSlideManifest) => {
  const level = m.levels[0]
  const tile = level?.tiles.find((t): t is NVSlideTileManifest => !!t)
  if (!level || !tile) throw new Error('no tile')
  return { level, tile }
}

test('focal planes of one path form a stack, ranked, with their ZOffsets', async () => {
  const { stack, source } = await stackOf('planes.dcm')
  expect(stack.map((s) => [s.focalPlane, s.zOffsetUm])).toEqual([
    [0, 0],
    [1, 2.5],
  ])
  expect(source.planes).toEqual({ z: 2, t: 1, zPositionsUm: [0, 2.5] })
  expect(source.manifest.levels.every((l) => l.plane?.z === 0)).toBe(true)
})

test('preparePlane returns a plane whose levels the source reads from', async () => {
  const { source } = await stackOf('planes.dcm')
  const m1 = await source.preparePlane({ z: 1, t: 0 })
  expect(m1.levels.every((l) => l.plane?.z === 1 && l.plane.t === 0)).toBe(true)
  // Frames 1-6 state ZOffset 2.5 (rank 1), frames 7-12 state 0 (rank 0).
  const p1 = firstTile(m1)
  expect(label(await source.fetchTileBytes(p1.level, p1.tile, ''))).toBe(
    'planes f1',
  )
  const p0 = firstTile(source.manifest)
  expect(label(await source.fetchTileBytes(p0.level, p0.tile, ''))).toBe(
    'planes f7',
  )
})

test('preparePlane rejects out of bounds (RangeError) and on abort', async () => {
  const { source } = await stackOf('planes.dcm')
  await expect(source.preparePlane({ z: 2, t: 0 })).rejects.toBeInstanceOf(
    RangeError,
  )
  await expect(source.preparePlane({ z: 0, t: 1 })).rejects.toBeInstanceOf(
    RangeError,
  )
  const ac = new AbortController()
  ac.abort()
  await expect(
    source.preparePlane({ z: 1, t: 0 }, ac.signal),
  ).rejects.toMatchObject({ name: 'AbortError' })
})

test('a plane with other spacing or sample semantics is refused (F14), the others still serve', async () => {
  const fs = await files('bot.dcm', 'mono12.dcm')
  const idx = await indexDicomWsiOnThread(fs)
  const bot = idx.slides.find((s) => s.container === 'bot')
  const mono = idx.slides.find((s) => s.container === 'mono12')
  if (!bot || !mono) throw new Error('fixtures')
  const source = new DicomPlaneStack([
    new DicomWsiSource(bot, fs),
    new DicomWsiSource(mono, fs),
  ])
  await expect(source.preparePlane({ z: 1, t: 0 })).rejects.toThrow(
    /plane z1 differs in pixel spacing/,
  )
  expect((await source.preparePlane({ z: 0, t: 0 })).width).toBe(40)
})

test('dispose disposes every plane source', async () => {
  const { source } = await stackOf('planes.dcm')
  const m1 = await source.preparePlane({ z: 1, t: 0 })
  source.dispose()
  const { level, tile } = firstTile(m1)
  await expect(source.fetchTileBytes(level, tile, '')).rejects.toMatchObject({
    name: 'AbortError',
  })
})

test("the ICC profile is the initial plane's", async () => {
  const plane = (i: number) =>
    ({
      manifest: { id: `p${i}`, width: 1, height: 1, levels: [] },
      bind() {},
      fetchTileBytes: async () => new Uint8Array(0),
      fetchIccProfile: async () => new Uint8Array([i]),
    }) as unknown as SlideTileSource
  const stack = new DicomPlaneStack([plane(0), plane(1)], { z: 1 })
  expect(Array.from((await stack.fetchIccProfile()) ?? [])).toEqual([1])
})
