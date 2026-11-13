import { describe, expect, it } from 'bun:test'
import type { NVSlideLevelManifest, NVSlideTileManifest } from './NVSlide'
import { type TileLoad, TileLoadQueue } from './slideLoadQueue'

const level = {} as NVSlideLevelManifest
const tile = {} as NVSlideTileManifest

function load(key: string, rank: number, dist: number, viewOnly = true) {
  const l: TileLoad = {
    key,
    level,
    tile,
    owners: new Set(),
    rank,
    dist,
    seq: 0,
    viewOnly,
    qi: -1,
  }
  return l
}

const drain = (q: TileLoadQueue) => {
  const keys: string[] = []
  for (let l = q.next(); l; l = q.next()) keys.push(l.key)
  return keys
}

describe('TileLoadQueue', () => {
  it('dequeues by rank, then focus distance, then age; no focus last', () => {
    const q = new TileLoadQueue()
    q.push(load('far', 1, 9))
    q.push(load('unfocused', 1, Number.POSITIVE_INFINITY))
    q.push(load('near-old', 1, 1))
    q.push(load('near-new', 1, 1))
    q.push(load('readout', 0, 99))
    // 3 dequeues: the 4th would be a fairness turn.
    expect([q.next(), q.next(), q.next()].map((l) => l?.key)).toEqual([
      'readout',
      'near-old',
      'near-new',
    ])
    expect(q.length).toBe(2)
  })

  it('every 4th dequeue takes the oldest load a non-view owner wants', () => {
    const q = new TileLoadQueue()
    for (let i = 0; i < 8; i++) q.push(load(`v${i}`, 1, i))
    q.push(load('thumb', 2, 0, false))
    q.push(load('prefetch', 3, 0, false))
    expect(drain(q)).toEqual([
      'v0',
      'v1',
      'v2',
      'thumb', // 4th
      'v3',
      'v4',
      'v5',
      'prefetch', // 8th
      'v6',
      'v7',
    ])
  })

  it('a fairness turn with no non-view load serves the best one', () => {
    const q = new TileLoadQueue()
    for (let i = 0; i < 5; i++) q.push(load(`v${i}`, 1, 4 - i))
    expect(drain(q)).toEqual(['v4', 'v3', 'v2', 'v1', 'v0'])
  })

  it('removes a queued load in O(1), keeping the rest dequeueable', () => {
    const q = new TileLoadQueue()
    const a = load('a', 1, 0)
    const b = load('b', 1, 1)
    const c = load('c', 1, 2)
    for (const l of [a, b, c]) q.push(l)
    q.remove(a)
    q.remove(a) // not queued any more: a no-op
    expect(a.qi).toBe(-1)
    expect(drain(q)).toEqual(['b', 'c'])
    q.push(a)
    q.clear()
    expect([q.length, a.qi, q.next()]).toEqual([0, -1, undefined])
  })
})
