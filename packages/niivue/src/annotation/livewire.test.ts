import { describe, expect, test } from 'bun:test'
import {
  buildScissorsCost,
  livewireBacktrack,
  livewireFieldScissors,
} from './livewire'

// A W x H image with a bright vertical stripe at column `stripeX`.
function stripeImage(w: number, h: number, stripeX: number): Float32Array {
  const img = new Float32Array(w * h)
  for (let y = 0; y < h; y++) img[y * w + stripeX] = 100
  return img
}

describe('livewire', () => {
  test('backtracked path is seed-first, 8-connected, ends at the target', () => {
    const w = 20
    const h = 20
    const sc = buildScissorsCost(stripeImage(w, h, 10), w, h, 0, 100)
    const prev = livewireFieldScissors(sc, w, h, 10, 2)
    const path = livewireBacktrack(prev, w, 10, 17)
    expect(path[0]).toEqual({ x: 10, y: 2 })
    expect(path[path.length - 1]).toEqual({ x: 10, y: 17 })
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x)
      const dy = Math.abs(path[i].y - path[i - 1].y)
      expect(dx).toBeLessThanOrEqual(1)
      expect(dy).toBeLessThanOrEqual(1)
      expect(dx + dy).toBeGreaterThan(0)
    }
  })

  // From seeds 3 columns off a step edge, the path still runs along the edge.
  test('the path runs along a step edge', () => {
    const w = 24
    const h = 24
    const img = new Float32Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 12; x < w; x++) img[y * w + x] = 100
    const sc = buildScissorsCost(img, w, h, 0, 100)
    const path = livewireBacktrack(
      livewireFieldScissors(sc, w, h, 9, 2),
      w,
      9,
      21,
    )
    const mid = path.filter((p) => p.y >= 6 && p.y <= 17)
    expect(mid.length).toBeGreaterThan(0)
    for (const p of mid) expect(Math.abs(p.x - 11.5)).toBeLessThanOrEqual(1.5)
  })
})
