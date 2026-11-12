/**
 * Downloads the pinned benchmark stores into $TILE_BENCH_DATA (default
 * ~/.cache/niivue-tile-bench), checks them against bench/SHA256SUMS and
 * writes SHA256SUMS there. Files already present at the expected size are
 * kept. About 870 MB.
 *
 *   node bench/fetch.mjs
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DATA =
  process.env.TILE_BENCH_DATA ?? join(homedir(), '.cache/niivue-tile-bench')

const HF = 'https://huggingface.co/datasets/neurodeskorg/webapps'
const HF_SLIDES = 'cfff0272e4e7cdbc324863f15f55edd8a848acfb'
const HF_ZARR = 'f7cb7ad92d8ceacb1f922ecb17b0a60fd9710c71'
const LFS = '6ad85c2d3b408bb0c3ab23e052f52cb74d8f831b' // niivue-demo-images-lfs
const DICOM = 'streaming/dicom-wsi/3dhistech-1'

async function hfStore(name, local) {
  const r = await fetch(
    `https://huggingface.co/api/datasets/neurodeskorg/webapps/tree/${HF_ZARR}/omezarr2d/${name}?recursive=true`,
  )
  const prefix = `omezarr2d/${name}/`
  return (await r.json())
    .filter((e) => e.type === 'file')
    .map((e) => ({
      path: `${local}/${e.path.slice(prefix.length)}`,
      url: `${HF}/resolve/${HF_ZARR}/${e.path}`,
      size: e.size,
    }))
}

async function dicomFiles() {
  const url = `https://raw.githubusercontent.com/niivue/niivue-demo-images-lfs/${LFS}/${DICOM}/manifest.json`
  const manifest = await (await fetch(url)).json()
  const media = `https://media.githubusercontent.com/media/niivue/niivue-demo-images-lfs/${LFS}/${DICOM}`
  return [
    { path: '3dhistech-1/manifest.json', url },
    ...manifest.levels.map((l) => ({
      path: `3dhistech-1/${l.fileUrl}`,
      url: `${media}/${l.fileUrl}`,
      size: l.fileSize,
    })),
  ]
}

const sizeOf = (p) =>
  stat(p).then(
    (s) => s.size,
    () => -1,
  )

const expected = new Map(
  (await readFile(new URL('SHA256SUMS', import.meta.url), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => line.split('  ').reverse()),
)

const files = [
  {
    path: 'cmu-1.svs',
    url: `${HF}/resolve/${HF_SLIDES}/openslide/Aperio/CMU-1.svs`,
    size: 177552579,
  },
  ...(await hfStore('idr0054-tonsil-imc.ome.zarr', 'imc.ome.zarr')),
  ...(await hfStore(
    'sentinel2-richat-structure.ome.zarr',
    'sentinel2.ome.zarr',
  )),
  ...(await dicomFiles()),
]
if (files.length !== expected.size)
  throw new Error(
    `${files.length} files listed, SHA256SUMS has ${expected.size}`,
  )
const sums = []
for (const f of files) {
  const dest = join(DATA, f.path)
  if (f.size === undefined || (await sizeOf(dest)) !== f.size) {
    await mkdir(dirname(dest), { recursive: true })
    const r = await fetch(f.url)
    if (!r.ok) throw new Error(`${f.url}: HTTP ${r.status}`)
    await pipeline(Readable.fromWeb(r.body), createWriteStream(dest))
    console.log(`fetched ${f.path}`)
  }
  const hash = createHash('sha256')
    .update(await readFile(dest))
    .digest('hex')
  if (hash !== expected.get(f.path))
    throw new Error(
      `${f.path}: sha256 ${hash}, expected ${expected.get(f.path)}`,
    )
  sums.push(`${hash}  ${f.path}`)
}
await writeFile(join(DATA, 'SHA256SUMS'), `${sums.join('\n')}\n`)
console.log(`${files.length} files in ${DATA}`)
