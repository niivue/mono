import { describe, expect, it } from 'bun:test'
import { TileTextureCache } from './tileTextureCache'

function makeCache(maxBytes: number) {
  const destroyed: string[] = []
  const cache = new TileTextureCache<string>(maxBytes, (v) => destroyed.push(v))
  return { cache, destroyed }
}

describe('TileTextureCache', () => {
  it('stores and retrieves entries, tracking bytes', () => {
    const { cache } = makeCache(100)
    cache.set('a', 'texA', 40)
    cache.set('b', 'texB', 40)
    expect(cache.get('a')).toBe('texA')
    expect(cache.bytes).toBe(80)
    expect(cache.size).toBe(2)
  })

  it('destroys the previous value when a key is replaced', () => {
    const { cache, destroyed } = makeCache(100)
    cache.set('a', 'old', 10)
    cache.set('a', 'new', 20)
    expect(destroyed).toEqual(['old'])
    expect(cache.bytes).toBe(20)
    expect(cache.get('a')).toBe('new')
  })

  it('evicts least-recently-used entries down to the budget', () => {
    const { cache, destroyed } = makeCache(100)
    cache.set('a', 'texA', 40)
    cache.set('b', 'texB', 40)
    cache.set('c', 'texC', 40) // 120 bytes total
    cache.beginFrame() // age all three entries out of the protected frame
    cache.evictToBudget()
    expect(destroyed).toEqual(['texA'])
    expect(cache.bytes).toBe(80)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('texB')
  })

  it('a get() refreshes recency so the touched entry survives eviction', () => {
    const { cache, destroyed } = makeCache(100)
    cache.set('a', 'texA', 40)
    cache.set('b', 'texB', 40)
    cache.set('c', 'texC', 40)
    cache.beginFrame()
    cache.get('a') // now most recent AND current-frame protected
    cache.beginFrame()
    cache.evictToBudget()
    expect(destroyed).toEqual(['texB'])
    expect(cache.get('a')).toBe('texA')
    expect(cache.get('c')).toBe('texC')
  })

  it('never evicts entries touched in the current frame, even over budget', () => {
    const { cache, destroyed } = makeCache(50)
    cache.beginFrame()
    cache.set('a', 'texA', 40)
    cache.set('b', 'texB', 40)
    cache.evictToBudget() // both touched this frame: nothing may be destroyed
    expect(destroyed).toEqual([])
    expect(cache.bytes).toBe(80)
    cache.beginFrame()
    cache.get('b')
    cache.evictToBudget()
    expect(destroyed).toEqual(['texA'])
    expect(cache.bytes).toBe(40)
  })

  it('delete removes and destroys a single entry', () => {
    const { cache, destroyed } = makeCache(100)
    cache.set('a', 'texA', 30)
    cache.delete('a')
    cache.delete('a') // idempotent
    expect(destroyed).toEqual(['texA'])
    expect(cache.bytes).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })

  it('clear destroys everything', () => {
    const { cache, destroyed } = makeCache(100)
    cache.set('a', 'texA', 30)
    cache.set('b', 'texB', 30)
    cache.clear()
    expect(destroyed.sort()).toEqual(['texA', 'texB'])
    expect(cache.bytes).toBe(0)
    expect(cache.size).toBe(0)
  })
})
