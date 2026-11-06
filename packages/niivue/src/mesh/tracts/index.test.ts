import { describe, expect, test } from 'bun:test'
import type { NVTractData, NVTractOptions } from '@/NVTypes'
import { defaultTractOptions, tessellate } from './index'

const SIDES = 3
const PTS = 3 // points per streamline

// Three streamlines along x, y and z; group A = [0], group B = [1, 2]
function makeTract(): NVTractData {
  return {
    vertices: new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 0,
      0, 2,
    ]),
    offsets: new Uint32Array([0, 3, 6, 9]),
    dpv: {},
    dps: { fa: new Float32Array([0, 0.5, 1]) },
    groups: { A: new Uint32Array([0]), B: new Uint32Array([1, 2]) },
    dpvMeta: {},
    dpsMeta: {},
  }
}

function run(opts: Partial<NVTractOptions>): Uint32Array {
  return tessellate(makeTract(), {
    ...defaultTractOptions,
    fiberSides: SIDES,
    ...opts,
  }).colors
}

/** Colours of streamline s within an unfiltered tessellation. */
function streamline(all: Uint32Array, s: number): number[] {
  const n = PTS * SIDES
  return Array.from(all.subarray(s * n, (s + 1) * n))
}

describe('tessellate visibleGroups', () => {
  test('subset keeps direction colours', () => {
    const all = run({})
    const sub = run({ visibleGroups: ['B'] })
    expect(Array.from(sub)).toEqual([
      ...streamline(all, 1),
      ...streamline(all, 2),
    ])
    expect(streamline(all, 1)).not.toEqual(streamline(all, 2))
  })

  test('subset keeps dps scalar colours', () => {
    const opts = { colorBy: 'dps:fa', calMin: 0, calMax: 1 }
    const all = run(opts)
    const sub = run({ ...opts, visibleGroups: ['A'] })
    expect(Array.from(sub)).toEqual(streamline(all, 0))
  })

  test('null, empty and unknown names', () => {
    const all = run({})
    expect(run({ visibleGroups: null })).toEqual(all)
    expect(run({ visibleGroups: [] })).toEqual(all)
    expect(run({ visibleGroups: ['B', 'nope'] })).toEqual(
      run({ visibleGroups: ['B'] }),
    )
  })

  test('with groupColors, a streamline must be in both', () => {
    const red = 0xff0000ff // packed ABGR of [255, 0, 0, 255]
    const sub = run({
      groupColors: { A: [255, 0, 0, 255], B: [255, 0, 0, 255] },
      visibleGroups: ['A'],
    })
    expect(sub.length).toBe(PTS * SIDES)
    expect(sub.every((c) => c === red)).toBe(true)
  })
})
