// The single-backend entries exist so a consumer ships one renderer (#175):
// nothing NVControlWebGL2 reaches at runtime may import wgpu/, and vice versa.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir)

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/')
    ? join(SRC, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(from), spec)
      : null
  if (!base) return null
  for (const f of [base, `${base}.ts`, join(base, 'index.ts')])
    if (existsSync(f) && f.endsWith('.ts')) return f
  return null
}

/** Source files reachable through runtime (non-type) imports. */
function runtimeClosure(entry: string): Set<string> {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    const specs = [
      ...src.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gms),
      ...src.matchAll(/^import\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^export\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gms),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1])
    for (const spec of specs) {
      const f = resolveImport(file, spec)
      if (f) visit(f)
    }
  }
  visit(join(SRC, entry))
  return seen
}

const reached = (entry: string, dir: string): string[] =>
  [...runtimeClosure(entry)]
    .map((f) => f.slice(SRC.length + 1))
    .filter((f) => f.startsWith(`${dir}/`))

describe('single-backend controllers', () => {
  test('NVControlWebGL2 reaches no WebGPU module', () => {
    expect(reached('NVControlWebGL2.ts', 'wgpu')).toEqual([])
  })
  test('NVControlWebGPU reaches no WebGL2 module', () => {
    expect(reached('NVControlWebGPU.ts', 'gl')).toEqual([])
  })
  test('the walk follows imports (it reaches its own backend)', () => {
    expect(reached('NVControlWebGL2.ts', 'gl').length).toBeGreaterThan(0)
    expect(reached('NVControlWebGPU.ts', 'wgpu').length).toBeGreaterThan(0)
  })
})
