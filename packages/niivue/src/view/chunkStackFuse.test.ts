import { expect, test } from 'bun:test'
import {
  ChunkStackFuse,
  chunkRegions,
  stackGeneration,
  stackInputs,
} from './chunkStackFuse'

function setup() {
  const gone: string[] = []
  const changed: number[] = []
  const fuse = new ChunkStackFuse<string>(
    (t) => gone.push(t),
    (i) => changed.push(i),
  )
  return { fuse, gone, changed }
}

const M = '0/3'

test('a chunk keeps its old fused texture until the complete re-fuse lands', () => {
  const { fuse, gone } = setup()
  const regions = ['r0', 'r1', 'r2']
  const inputs: (string[] | null)[] = [['a', 'b'], ['c'], null]
  const of = (i: number) => inputs[i]
  expect(fuse.stale(regions, 'g', M, of, 1)).toEqual([0])
  expect(fuse.stale(regions, 'g', M, of, 8)).toEqual([0, 1])
  fuse.set(0, 'r0', 'g', M, ['a', 'b'], 'f0')
  fuse.set(1, 'r1', 'g', M, ['c'], 'f1')
  expect(fuse.stale(regions, 'g', M, of, 8)).toEqual([])
  // A brick re-baked: still drawn, and due for a re-fuse.
  inputs[0] = ['a', 'b2']
  expect(fuse.get(0, 'r0', 'g')).toBe('f0')
  expect(fuse.stale(regions, 'g', M, of, 8)).toEqual([0])
  // A drawn channel's brick still loading: deferred, the old one kept.
  inputs[1] = null
  expect(fuse.stale(regions, 'g', M, of, 8)).toEqual([0])
  expect(fuse.get(1, 'r1', 'g')).toBe('f1')
  fuse.set(0, 'r0', 'g', M, ['a', 'b2'], 'f0b')
  expect(gone).toEqual(['f0'])
  fuse.clear()
  expect(gone).toEqual(['f0', 'f0b', 'f1'])
})

test('a new source generation (a frame switch) never draws the old fused chunks', () => {
  const { fuse, gone } = setup()
  fuse.set(0, 'r0', 'frame0', M, ['a'], 'old')
  // Same region, the new frame's loaders: not drawn, then dropped.
  expect(fuse.get(0, 'r0', 'frame1')).toBeNull()
  expect(fuse.stale(['r0'], 'frame1', M, () => ['a1'], 8)).toEqual([0])
  expect(gone).toEqual(['old'])
})

test('a blend mode change re-fuses every chunk', () => {
  const { fuse } = setup()
  fuse.set(0, 'r0', 'g', '0/3', ['a'], 'f')
  expect(fuse.stale(['r0'], 'g', '0/3', () => ['a'], 8)).toEqual([])
  expect(fuse.stale(['r0'], 'g', '2/2', () => ['a'], 8)).toEqual([0])
})

test('a plan swap moves fused chunks with their regions, never to another', () => {
  const { fuse, gone, changed } = setup()
  fuse.set(0, 'ra', 'g', M, ['a'], 'fa')
  fuse.set(1, 'rb', 'g', M, ['b'], 'fb')
  changed.length = 0
  // Re-keyed: rb is now chunk 0, ra left the plan, rc is new at 2.
  const regions = ['rb', 'rx', 'rc']
  expect(fuse.get(0, 'rb', 'g')).toBeNull()
  const inputs = [['b'], null, ['c']]
  expect(fuse.stale(regions, 'g', M, (i) => inputs[i], 8)).toEqual([2])
  expect(fuse.get(0, 'rb', 'g')).toBe('fb')
  expect(gone).toEqual(['fa'])
  expect(changed.sort()).toEqual([0, 0])
})

test('pump fuses to the deadline, counts, and drops a result once not alive', async () => {
  const { fuse, gone } = setup()
  const regions = ['r0', 'r1']
  const of = () => ['a']
  let alive = true
  expect(
    await fuse.pump(
      regions,
      'g',
      M,
      of,
      (_, i) => `f${i}`,
      0,
      8,
      () => alive,
    ),
  ).toBe(true)
  // Deadline passed: the first chunk only.
  expect([fuse.get(0, 'r0', 'g'), fuse.get(1, 'r1', 'g')]).toEqual(['f0', null])
  expect(fuse.stats.chunks).toBe(1)
  alive = false
  expect(
    await fuse.pump(
      regions,
      'g',
      M,
      of,
      async () => 'late',
      Number.POSITIVE_INFINITY,
      8,
      () => alive,
    ),
  ).toBe(false)
  expect(gone).toEqual(['late'])
  expect(fuse.get(1, 'r1', 'g')).toBeNull()
})

test('stack inputs wait for every drawn channel; the generation follows the loaders', () => {
  const entry = (tex: string | null, visible = true, sourceKey = 's') => ({
    volume: { visible },
    sourceKey,
    manager: { getChunk: () => (tex ? { volumeTexture: tex } : null) },
  })
  expect(stackInputs([entry('a'), entry('b')], 0)).toEqual(['a', 'b'])
  expect(stackInputs([entry('a'), entry(null)], 0)).toBeNull()
  expect(stackInputs([entry('a'), entry(null, false)], 0)).toEqual(['a'])
  expect(
    stackGeneration([entry('a', true, 's1'), entry('b', true, 's2')]),
  ).toBe('s1;s2')
})

test('chunkRegions is memoized per plan', () => {
  const plan = {
    chunks: [{ sourceLevel: 1, texOrigin: [0, 8, 0], texDims: [8, 8, 8] }],
  }
  expect(chunkRegions(plan)).toEqual(['1|0,8,0|8,8,8'])
  expect(chunkRegions(plan)).toBe(chunkRegions(plan))
})
