// Static checks on the demos in examples/ (#586):
// - a literal /volumes/, /meshes/ or /signals/ URL names a file packages/dev-images
//   lacks (URLs built at runtime, `${...}`, are skipped);
// - a page script calls getElementById('x') for an id its page does not define.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { imagesDir } from '@niivue/dev-images'

const examplesDir = resolve(import.meta.dir, '../examples')
const read = (file: string) => readFileSync(resolve(examplesDir, file), 'utf8')
const assetUrl =
  /['"`]\.?(\/(?:volumes|meshes|signals)\/[^'"`$?#]+)[^'"`]*['"`]/g
// Page-relative scripts only (no URLs, no root-absolute paths).
const pageScript = /<script[^>]*\bsrc="(?!\/)([^":]+\.js)"/g
const elementId = /[\s<]id="([^"]+)"/g
const idLookup = /getElementById\(\s*['"]([^'"]+)['"]/g

const problems: string[] = []
for (const file of readdirSync(examplesDir, {
  recursive: true,
  encoding: 'utf8',
})) {
  if (!/\.(js|html)$/.test(file)) continue
  const text = read(file)
  for (const [, url] of text.matchAll(assetUrl)) {
    if (!url.endsWith('/') && !existsSync(imagesDir + url))
      problems.push(`${file}: missing asset ${url}`)
  }
  if (!file.endsWith('.html')) continue
  const ids = new Set([...text.matchAll(elementId)].map((m) => m[1]))
  for (const [, script] of text.matchAll(pageScript)) {
    for (const [, id] of read(join(dirname(file), script)).matchAll(idLookup)) {
      if (!ids.has(id)) problems.push(`${script}: no #${id} in ${file}`)
    }
  }
}

if (problems.length) {
  console.error(`Demo checks failed:\n${problems.join('\n')}`)
  process.exit(1)
}
