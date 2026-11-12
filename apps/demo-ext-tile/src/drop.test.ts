import { expect, test } from 'bun:test'
import { droppedFiles } from './drop'

// A fake FileSystemEntry tree: readEntries hands out `batch` entries a call.
const file = (fullPath: string) => ({
  isFile: true,
  fullPath,
  file: (ok: (f: File) => void) =>
    ok(new File(['x'], fullPath.split('/').pop() as string)),
})
const dir = (fullPath: string, children: unknown[], batch = 2) => ({
  isFile: false,
  fullPath,
  createReader: () => {
    let at = 0
    return {
      readEntries: (ok: (e: unknown[]) => void) => {
        ok(children.slice(at, at + batch))
        at += batch
      },
    }
  },
})
const item = (entry: unknown, loose: File | null = null) => ({
  kind: 'file',
  webkitGetAsEntry: () => entry,
  getAsFile: () => loose,
})

test('walks folders in batches, keys their files by relative path', async () => {
  const tree = dir('/slide', [
    file('/slide/a.dcm'),
    file('/slide/b.dcm'),
    dir('/slide/sub', [file('/slide/sub/a.dcm')]),
  ])
  const loose = new File(['y'], 'one.svs')
  const dt = {
    items: [
      item(tree),
      item(file('/top.dcm')),
      item(null, loose),
      { kind: 'string' },
    ],
  } as unknown as DataTransfer
  const files = await droppedFiles(dt)
  expect(files.map((f) => f.webkitRelativePath || f.name)).toEqual([
    'slide/a.dcm',
    'slide/b.dcm',
    'slide/sub/a.dcm',
    'top.dcm',
    'one.svs',
  ])
  expect(files[4]).toBe(loose)
})

test('an unreadable file is skipped, not the whole drop', async () => {
  const gone = {
    isFile: true,
    fullPath: '/slide/gone.dcm',
    file: (_: unknown, fail: (e: Error) => void) => fail(new Error('NotFound')),
  }
  const tree = dir('/slide', [file('/slide/good.dcm'), gone])
  const dt = { items: [item(tree)] } as unknown as DataTransfer
  const files = await droppedFiles(dt)
  expect(files.map((f) => f.webkitRelativePath)).toEqual(['slide/good.dcm'])
})
