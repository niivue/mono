/**
 * Convert a classic-NiiVue JSON document (`@niivue/niivue` `.nvd`/JSON) into this
 * package's NVD format. Volumes/meshes are LINKED by their URL (their embedded
 * base64 NIfTI blobs are not decoded — that needs the GPU-volume reader), so the
 * source URLs must be reachable when the converted document is opened. Settings
 * are mapped for the well-known fields; unmapped fields are reported.
 *
 * Usage:
 *   bun run scripts/convert-legacy-nvd.ts <legacy.nvd|.json> <out.nvd|out.json>
 *
 * The output encoding follows the extension: `.json` -> portable JSON, otherwise
 * CBOR. Both load via `nv.loadDocument`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { encode } from 'cbor-x'
import { encodeDocumentJSON } from '../src/documentJson'
import {
  convertLegacyDocument,
  type LegacyDocument,
} from '../src/documentLegacy'

const [, , inPath, outPath] = process.argv
if (!inPath || !outPath) {
  console.error(
    'usage: bun run scripts/convert-legacy-nvd.ts <legacy.json> <out.nvd|out.json>',
  )
  process.exit(2)
}

let legacy: LegacyDocument
try {
  legacy = JSON.parse(readFileSync(inPath, 'utf8')) as LegacyDocument
} catch (err) {
  console.error(`Failed to read/parse ${inPath} as JSON:`, err)
  process.exit(1)
}

const { doc, warnings } = convertLegacyDocument(
  legacy,
  new Date().toISOString(),
)
const asJson = outPath.toLowerCase().endsWith('.json')
const bytes = asJson
  ? new TextEncoder().encode(encodeDocumentJSON(doc))
  : encode(doc)
writeFileSync(outPath, bytes)

console.log(
  `Converted ${inPath} -> ${outPath} (${asJson ? 'JSON' : 'CBOR'}, ` +
    `${doc.volumes.length} volume(s), ${doc.meshes.length} mesh(es))`,
)
if (warnings.length > 0) {
  console.warn(`${warnings.length} warning(s):`)
  for (const w of warnings) console.warn('  -', w)
}
