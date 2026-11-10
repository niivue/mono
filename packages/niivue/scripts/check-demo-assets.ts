// Fails when a demo in examples/ names a /volumes/, /meshes/ or /signals/ file
// that packages/dev-images lacks. URLs built at runtime (`${...}`) are skipped.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { imagesDir } from '@niivue/dev-images'

const examplesDir = resolve(import.meta.dir, '../examples')
const assetUrl =
  /['"`]\.?(\/(?:volumes|meshes|signals)\/[^'"`$?#]+)[^'"`]*['"`]/g

const missing: string[] = []
for (const file of readdirSync(examplesDir, {
  recursive: true,
  encoding: 'utf8',
})) {
  if (!/\.(js|html)$/.test(file)) continue
  const text = readFileSync(resolve(examplesDir, file), 'utf8')
  for (const [, url] of text.matchAll(assetUrl)) {
    if (!url.endsWith('/') && !existsSync(imagesDir + url))
      missing.push(`${file}: ${url}`)
  }
}

if (missing.length) {
  console.error(
    `Demo assets missing from packages/dev-images:\n${missing.join('\n')}`,
  )
  process.exit(1)
}
