import { describe, expect, test } from 'bun:test'
import {
  MAX_CHANGED_LINES,
  measure,
  type PullFile,
  renderComment,
} from './pr-size'

const file = (
  filename: string,
  additions: number,
  deletions = 0,
  status: PullFile['status'] = 'modified',
): PullFile => ({ filename, status, additions, deletions })

describe('measure', () => {
  test('sums additions and deletions of existing TS/JS files', () => {
    const report = measure([
      file('packages/niivue/src/a.ts', 100, 20),
      file('packages/nv-react/src/b.tsx', 30, 5),
      file('apps/demo/c.js', 10),
    ])
    expect(report.total).toBe(165)
    expect(report.files.map((f) => f.file)).toEqual([
      'packages/niivue/src/a.ts',
      'packages/nv-react/src/b.tsx',
      'apps/demo/c.js',
    ])
    expect(report.tooLarge).toBe(false)
  })

  test('skips newly added files', () => {
    const report = measure([
      file('packages/niivue/src/big.test.ts', 900, 0, 'added'),
      file('packages/niivue/src/small.ts', 3),
    ])
    expect(report.total).toBe(3)
    expect(report.files).toHaveLength(1)
  })

  test('skips files outside the counted extensions', () => {
    const report = measure([
      file('README.md', 500),
      file('packages/niivue/src/shader.wgsl', 400),
      file('packages/ipyniivue/src/thing.py', 300),
      file('biome.json', 200),
    ])
    expect(report.total).toBe(0)
    expect(report.files).toHaveLength(0)
  })

  test('skips the generated asset indexes', () => {
    const report = measure([
      file('packages/niivue/src/assets/fonts/index.ts', 5000),
      file('packages/niivue/src/assets/matcaps/index.ts', 5000),
    ])
    expect(report.total).toBe(0)
  })

  test('counts removed and renamed files', () => {
    const report = measure([
      file('packages/niivue/src/old.ts', 0, 200, 'removed'),
      file('packages/niivue/src/moved.ts', 40, 40, 'renamed'),
    ])
    expect(report.total).toBe(280)
  })

  test('flags strictly over the limit', () => {
    expect(measure([file('a.ts', MAX_CHANGED_LINES)]).tooLarge).toBe(false)
    expect(measure([file('a.ts', MAX_CHANGED_LINES + 1)]).tooLarge).toBe(true)
  })
})

describe('renderComment', () => {
  test('lists at most ten files and mentions the remainder', () => {
    const files = Array.from({ length: 13 }, (_, i) =>
      file(`packages/niivue/src/f${i}.ts`, 30),
    )
    const body = renderComment(measure(files))
    expect(body).toContain('<!-- pr-size-check -->')
    expect(body).toContain('**390** lines across 13 existing')
    expect(body.match(/^\| `packages/gm)).toHaveLength(10)
    expect(body).toContain('| and 3 more | |')
  })
})
