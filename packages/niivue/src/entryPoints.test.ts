import { describe, expect, test } from 'bun:test'

// The three hand-maintained entry points drift silently: a symbol added to
// src/index.ts alone still typechecks, still builds, and still lands in
// dist/index.d.ts. It fails only downstream, for someone importing it from
// '@niivue/niivue/webgl2'. Four exports were missed across three PRs that way.
// The policy these tests encode is written up in AGENTS.md, "Entry points and
// public exports".

const ENTRY = {
  root: 'index.ts',
  webgl2: 'index.webgl2.ts',
  webgpu: 'index.webgpu.ts',
} as const

const read = async (file: string): Promise<string> =>
  await Bun.file(`${import.meta.dir}/${file}`).text()

// Exported names from every `export [type] { ... } from '...'` re-export,
// resolving `as` aliases to the public name.
function exportedNames(source: string): Set<string> {
  const names = new Set<string>()
  const block = /export[ \t]+(?:type[ \t]+)?\{([^}]*)\}[ \t]*from/g
  for (const match of source.matchAll(block)) {
    for (const spec of match[1].split(',')) {
      const name = spec
        .replace(/^\s*type\s+/, '')
        .split(' as ')
        .pop()
        ?.trim()
      if (name) names.add(name)
    }
  }
  return names
}

const sorted = (values: Iterable<string>): string[] => [...values].sort()

describe('entry points', () => {
  test('the backend entries differ only by their own slide renderer', async () => {
    const webgl2 = exportedNames(await read(ENTRY.webgl2))
    const webgpu = exportedNames(await read(ENTRY.webgpu))
    expect(sorted([...webgl2].filter((n) => !webgpu.has(n)))).toEqual([
      'SlideRenderer',
    ])
    expect(sorted([...webgpu].filter((n) => !webgl2.has(n)))).toEqual([
      'SlideRendererGPU',
    ])
  })

  test('the backend entries export nothing the universal entry lacks', async () => {
    const root = exportedNames(await read(ENTRY.root))
    for (const file of [ENTRY.webgl2, ENTRY.webgpu]) {
      const names = exportedNames(await read(file))
      // A symbol here but not in root means the universal build cannot reach
      // its own feature.
      expect(sorted([...names].filter((n) => !root.has(n)))).toEqual([])
    }
  })

  test('only *Detail types and the other backend are root-only', async () => {
    const root = exportedNames(await read(ENTRY.root))
    for (const [file, ownRenderer] of [
      [ENTRY.webgl2, 'SlideRendererGPU'],
      [ENTRY.webgpu, 'SlideRenderer'],
    ] as const) {
      const names = exportedNames(await read(file))
      const missing = sorted([...root].filter((n) => !names.has(n)))
      expect(missing.filter((n) => !n.endsWith('Detail'))).toEqual([
        ownRenderer,
      ])
    }
  })

  test('every event detail type NVEvents declares is exported', async () => {
    const events = await read('NVEvents.ts')
    const declared = sorted(
      [...events.matchAll(/export (?:interface|type) (\w*Detail)\b/g)].map(
        (m) => m[1],
      ),
    )
    expect(declared.length).toBeGreaterThan(0)
    const root = exportedNames(await read(ENTRY.root))
    // NVEventMap names these in its public signature, so a consumer that reads
    // an event's detail has to be able to name the type too.
    expect(declared.filter((n) => !root.has(n))).toEqual([])
  })
})
