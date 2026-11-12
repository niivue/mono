import { expect, test } from 'bun:test'
import { indexDicomWsiOnThread } from './dicomIndex'
import { indexDicomWsi } from './indexDicomWsi'

test('indexDicomWsi indexes on this thread without a window', async () => {
  const dir = `${import.meta.dir}/../fixtures/dicom-wsi`
  const files = await Promise.all(
    ['bot.dcm', 'sparse.dcm', 'not-dicom.dcm'].map(
      async (n) => new File([await Bun.file(`${dir}/${n}`).arrayBuffer()], n),
    ),
  )
  const index = await indexDicomWsi(files)
  expect(index.slides.length).toBe(2)
  expect(index).toEqual(await indexDicomWsiOnThread(files))
})

test('indexDicomWsi reports progress per file and stops on abort', async () => {
  const dir = `${import.meta.dir}/../fixtures/dicom-wsi`
  const files = await Promise.all(
    ['bot.dcm', 'sparse.dcm', 'not-dicom.dcm'].map(
      async (n) => new File([await Bun.file(`${dir}/${n}`).arrayBuffer()], n),
    ),
  )
  const seen: number[][] = []
  await indexDicomWsi(files, { onProgress: (d, t) => seen.push([d, t]) })
  expect(seen).toEqual([
    [1, 3],
    [2, 3],
    [3, 3],
  ])
  const ac = new AbortController()
  const done: number[] = []
  const indexing = indexDicomWsi(files, {
    signal: ac.signal,
    onProgress: (d) => {
      done.push(d)
      if (d === 1) ac.abort()
    },
  })
  await expect(indexing).rejects.toMatchObject({ name: 'AbortError' })
  expect(done).toEqual([1])
  ac.abort()
  await expect(
    indexDicomWsi(files, { signal: ac.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' })
})
