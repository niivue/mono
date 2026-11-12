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
