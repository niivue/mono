// Index a local DICOM-WSI folder and write a hosted `dicom-wsi-range-v1` manifest.
// Usage: bun scripts/build-manifest.ts <slide-dir> <id>
// <slide-dir>/files/*.dcm are the slide's files; <slide-dir>/manifest.json is written,
// with tiles read by HTTP Range from `files/<name>`.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { indexDicomWsiOnThread } from '../src/dicomIndex'
import { manifestFromIndex } from '../src/hostedManifest'

const [dir, id] = process.argv.slice(2)
if (!dir || !id) {
  console.error('usage: bun scripts/build-manifest.ts <slide-dir> <id>')
  process.exit(2)
}
const filesDir = path.join(dir, 'files')
// Bun files stand in for browser Files: the index reads them with slice().
const files = readdirSync(filesDir)
  .filter((n) => !n.startsWith('.'))
  .sort()
  .map((name) => {
    const f = Bun.file(path.join(filesDir, name))
    const { size, lastModified } = f
    const slice = (a?: number, b?: number) => f.slice(a, b)
    return {
      name,
      webkitRelativePath: '',
      size,
      lastModified,
      slice,
    } as unknown as File
  })
const index = await indexDicomWsiOnThread(files)
for (const s of index.skipped) console.log(`skipped ${s.file}: ${s.message}`)
const slide = index.slides[0]
if (!slide) throw new Error(`no tiled slide in ${filesDir}`)
if (index.slides.length > 1)
  console.warn(`${index.slides.length} slides found; writing the first`)
const manifest = await manifestFromIndex(
  slide,
  files,
  (i) => `files/${encodeURIComponent(i.file)}`,
)
manifest.id = id
manifest.name = `${id} DICOM-WSI`
await Bun.write(
  path.join(dir, 'manifest.json'),
  `${JSON.stringify(manifest)}\n`,
)
for (const l of manifest.levels)
  console.log(
    `${id} L${l.index}: ${l.width}x${l.height}, ${l.columns}x${l.rows} tiles, ${l.tiles.length} listed${l.sparse ? ' (sparse)' : ''}, ${l.codec}`,
  )
