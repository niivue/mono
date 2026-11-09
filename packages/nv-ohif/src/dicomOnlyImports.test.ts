import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// nv-ohif imports only @niivue/nv-ext-tile/dicom: its built graph, static and
// lazy imports alike, must not reach GeoTIFF (/tiff) or zarrita (/zarr).
test('nv-ext-tile/dicom pulls no GeoTIFF or zarrita', () => {
  const seen = new Set<string>()
  const bare: string[] = []
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    for (const [, spec = ''] of src.matchAll(
      /(?:from|import\(?)\s*['"]([^'"]+)['"]/g,
    )) {
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec))
      else bare.push(spec)
    }
  }
  walk(Bun.resolveSync('@niivue/nv-ext-tile/dicom', import.meta.dir))
  // Bundled dependencies are inlined, so the externals are the whole surface.
  expect([...new Set(bare)].sort()).toEqual([
    '@niivue/dcm2niix',
    '@niivue/niivue',
  ])
})
