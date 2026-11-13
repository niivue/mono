import { expect, test } from 'bun:test'
import { associatedImages, readAssociatedImage } from './dicomAssociated'
import { indexDicomWsiOnThread } from './dicomIndex'

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
const NAMES = [
  'label.dcm',
  'bot.dcm',
  'overview.dcm',
  'thumbnail.dcm',
  'sparse.dcm',
]

test('label, overview and thumbnail images are associated, never slides', async () => {
  const fs = await files(...NAMES)
  const idx = await indexDicomWsiOnThread(fs)
  expect(idx.slides.map((s) => s.container)).toEqual(['bot', 'sparse'])
  expect(idx.skipped).toEqual([])
  const bot = idx.slides[0]
  const sparse = idx.slides[1]
  if (!bot || !sparse) throw new Error('slides')
  expect(
    associatedImages(idx, bot).map((a) => [
      a.kind,
      a.width,
      a.height,
      !!a.native,
    ]),
  ).toEqual([
    ['label', 16, 8, true],
    ['overview', 16, 16, false],
    ['thumbnail', 16, 16, false],
  ])
  expect(associatedImages(idx, sparse)).toEqual([])
})

test('reads a native label as RGBA and joins a fragmented frame', async () => {
  const fs = await files(...NAMES)
  const idx = await indexDicomWsiOnThread(fs)
  const [label, overview, thumb] = idx.associated ?? []
  if (!label || !overview || !thumb) throw new Error('associated')
  const l = await readAssociatedImage(label, fs)
  expect([l.codec, l.width, l.height, l.bytes.length]).toEqual([
    'raw-rgba',
    16,
    8,
    16 * 8 * 4,
  ])
  // Pixel (x 3, y 2): red 3 * 16, green 2 * 32, blue 7.
  const at = (2 * 16 + 3) * 4
  expect([...l.bytes.subarray(at, at + 4)]).toEqual([48, 64, 7, 255])
  const o = await readAssociatedImage(overview, fs)
  expect(o.codec).toBe('image/jpeg')
  expect([o.bytes[0], o.bytes[1], o.bytes.at(-1)]).toEqual([0xff, 0xd8, 0xd9])
  const t = await readAssociatedImage(thumb, fs)
  expect(new TextDecoder().decode(t.bytes.subarray(6, -2)).trim()).toBe(
    'bot thumb',
  )
})

test('reads an associated image whose file name repeats', async () => {
  // Same name, so the label's index key is `a.dcm (2)`.
  const fs = (await files('bot.dcm', 'label.dcm')).map(
    (f) => new File([f], 'a.dcm', { lastModified: 1 }),
  )
  const [label] = (await indexDicomWsiOnThread(fs)).associated ?? []
  if (!label) throw new Error('label')
  expect(label.instance.file).toBe('a.dcm (2)')
  expect((await readAssociatedImage(label, fs)).width).toBe(16)
})

test('refuses a changed file and an aborted read', async () => {
  const fs = await files('label.dcm')
  const [label] = (await indexDicomWsiOnThread(fs)).associated ?? []
  if (!label) throw new Error('label')
  const changed = await files('label.dcm')
  Object.defineProperty(changed[0], 'lastModified', { value: 2 })
  await expect(readAssociatedImage(label, changed)).rejects.toThrow(/changed/)
  const ac = new AbortController()
  ac.abort()
  await expect(readAssociatedImage(label, fs, ac.signal)).rejects.toMatchObject(
    {
      name: 'AbortError',
    },
  )
})
