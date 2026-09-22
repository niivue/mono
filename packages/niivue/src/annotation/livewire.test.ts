import { describe, expect, test } from 'bun:test'
import { buildLivewireCost, livewireBacktrack, livewireField } from './livewire'

// A W x H image with a bright vertical stripe at column `stripeX`.
function stripeImage(w: number, h: number, stripeX: number): Float32Array {
  const img = new Float32Array(w * h)
  for (let y = 0; y < h; y++) img[y * w + stripeX] = 100
  return img
}

describe('livewire', () => {
  test('cost is lower on a strong edge than in a flat region', () => {
    const w = 20
    const h = 20
    const cost = buildLivewireCost(stripeImage(w, h, 10), w, h)
    // Beside the stripe (x=9/11) the gradient is strong -> low cost.
    const edge = cost[10 * w + 9]
    // A flat interior region far from the stripe -> high cost.
    const flat = cost[10 * w + 3]
    expect(edge).toBeLessThan(flat)
  })

  test('backtracked path is seed-first, 8-connected, ends at the target', () => {
    const w = 20
    const h = 20
    const cost = buildLivewireCost(stripeImage(w, h, 10), w, h)
    const prev = livewireField(cost, w, h, 10, 2)
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

  test('the path snaps to the edge column rather than wandering', () => {
    const w = 20
    const h = 20
    const cost = buildLivewireCost(stripeImage(w, h, 10), w, h)
    const prev = livewireField(cost, w, h, 10, 2)
    const path = livewireBacktrack(prev, w, 10, 17)
    // Every point hugs the vertical edge near column 10.
    for (const p of path) {
      expect(Math.abs(p.x - 10)).toBeLessThanOrEqual(1)
    }
  })
})
