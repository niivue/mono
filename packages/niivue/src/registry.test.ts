import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { lutModules } from '@/cmap/luts/_registry'
import { lookupColorMap } from '@/cmap/NVCmaps'
import { connectomeReaderModules } from '@/mesh/connectome/readers/_registry'
import { layerReaderModules } from '@/mesh/layers/readers/_registry'
import { meshReaderModules } from '@/mesh/readers/_registry'
import { tractReaderModules } from '@/mesh/tracts/readers/_registry'
import { meshWriterModules } from '@/mesh/writers/_registry'
import { signalReaderModules } from '@/signal/readers/_registry'
import { volumeReaderModules } from '@/volume/readers/_registry'
import { transformModules } from '@/volume/transforms/_registry'
import { volumeWriterModules } from '@/volume/writers/_registry'

// Each format directory lists its modules in a hand-maintained `_registry.ts`.
// These tests fail when a file is added to a directory but not to its registry
// (or the reverse), which would otherwise leave the new format silently
// unreachable.

type Registry = {
  dir: string
  modules: Record<string, unknown>
  ext: '.ts' | '.json'
  // The export every module must provide.
  entry: 'read' | 'write' | 'apply' | 'lut'
}

const registries: Registry[] = [
  {
    dir: 'volume/readers',
    modules: volumeReaderModules,
    ext: '.ts',
    entry: 'read',
  },
  {
    dir: 'mesh/readers',
    modules: meshReaderModules,
    ext: '.ts',
    entry: 'read',
  },
  {
    dir: 'mesh/layers/readers',
    modules: layerReaderModules,
    ext: '.ts',
    entry: 'read',
  },
  {
    dir: 'mesh/tracts/readers',
    modules: tractReaderModules,
    ext: '.ts',
    entry: 'read',
  },
  {
    dir: 'mesh/connectome/readers',
    modules: connectomeReaderModules,
    ext: '.ts',
    entry: 'read',
  },
  {
    dir: 'signal/readers',
    modules: signalReaderModules,
    ext: '.ts',
    entry: 'read',
  },
  {
    dir: 'volume/writers',
    modules: volumeWriterModules,
    ext: '.ts',
    entry: 'write',
  },
  {
    dir: 'mesh/writers',
    modules: meshWriterModules,
    ext: '.ts',
    entry: 'write',
  },
  {
    dir: 'volume/transforms',
    modules: transformModules,
    ext: '.ts',
    entry: 'apply',
  },
  { dir: 'cmap/luts', modules: lutModules, ext: '.json', entry: 'lut' },
]

function moduleFiles(dir: string, ext: string): string[] {
  return readdirSync(new URL(`./${dir}/`, import.meta.url))
    .filter(
      (f) =>
        f.endsWith(ext) &&
        !f.endsWith(`.test${ext}`) &&
        f !== `index${ext}` &&
        f !== '_registry.ts',
    )
    .map((f) => `./${f}`)
    .sort()
}

describe('module registries', () => {
  for (const r of registries) {
    describe(r.dir, () => {
      test('listsEveryModuleInItsDirectory', () => {
        expect(Object.keys(r.modules).sort()).toEqual(moduleFiles(r.dir, r.ext))
      })

      test('everyModuleExportsItsEntryPoint', () => {
        for (const [path, mod] of Object.entries(r.modules)) {
          const m = mod as Record<string, unknown>
          if (r.entry === 'lut') {
            expect(Array.isArray(m.R), path).toBe(true)
            continue
          }
          expect(typeof m[r.entry], path).toBe('function')
          if (r.entry === 'apply') {
            // The registry and the worker both key transforms by name.
            expect(typeof m.name, path).toBe('string')
          } else {
            expect(Array.isArray(m.extensions), path).toBe(true)
          }
        }
      })

      test('noTwoModulesClaimTheSameExtension', () => {
        // Catches a key bound to the wrong module ('./mha.ts': mgh), which
        // the filename comparison above cannot see.
        const owner = new Map<string, string>()
        for (const [path, mod] of Object.entries(r.modules)) {
          const exts = (mod as { extensions?: unknown }).extensions
          if (!Array.isArray(exts)) continue
          for (const e of exts) {
            const ext = String(e).toUpperCase()
            expect(owner.get(ext), `${ext} in ${path}`).toBeUndefined()
            owner.set(ext, path)
          }
        }
      })
    })
  }

  test('bundledColormapsLoadUnderBun', () => {
    // Before the static registry, Bun saw only the gray fallback here.
    expect(lookupColorMap('viridis')).not.toBeNull()
    expect(lookupColorMap('ct_bones')).toMatchObject({ min: 180, max: 600 })
  })
})
