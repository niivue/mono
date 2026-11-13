import { expect, test } from 'bun:test'
import { indexDicomWsiOnThread } from './dicomIndex'
import { indexDicomWsi } from './indexDicomWsi'

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

test('indexDicomWsi indexes on this thread, reports progress per file, stops on abort', async () => {
  const fs = await files('bot.dcm', 'sparse.dcm', 'not-dicom.dcm')
  const seen: number[][] = []
  const index = await indexDicomWsi(fs, {
    onProgress: (d, t) => seen.push([d, t]),
  })
  expect(index.slides.length).toBe(2)
  expect(index).toEqual(await indexDicomWsiOnThread(fs))
  expect(seen).toEqual([
    [1, 3],
    [2, 3],
    [3, 3],
  ])
  const ac = new AbortController()
  const done: number[] = []
  const indexing = indexDicomWsi(fs, {
    signal: ac.signal,
    onProgress: (d) => {
      done.push(d)
      if (d === 1) ac.abort()
    },
  })
  await expect(indexing).rejects.toMatchObject({ name: 'AbortError' })
  expect(done).toEqual([1])
  await expect(indexDicomWsi(fs, { signal: ac.signal })).rejects.toMatchObject({
    name: 'AbortError',
  })
})
