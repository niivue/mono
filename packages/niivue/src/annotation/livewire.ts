// Intelligent-scissors ("live wire") path finding over a 2D slice image, for the
// LivewireContour annotation tool. Pure + grid-based so it is unit-testable; the
// interaction layer maps slice-2D annotation coords to/from this pixel grid.
//
// The classic algorithm: build a per-pixel traversal cost that is LOW on strong
// image edges, run Dijkstra once from each committed seed to get a shortest-path
// tree, then backtrack from the moving cursor to draw the live wire that snaps to
// edges. Committing a seed appends the backtracked path and re-roots the tree.

import type { AnnotationPoint } from '@/NVTypes'

const SQRT2 = Math.SQRT2

/**
 * Per-pixel traversal cost from the Sobel gradient magnitude: strong edges (high
 * gradient) get LOW cost so the least-cost path snaps to them. Result is in
 * roughly (0, 1]; a small floor keeps every step positive so Dijkstra is stable.
 */
export function buildLivewireCost(
  image: Float32Array | Uint8Array | Int16Array,
  width: number,
  height: number,
): Float32Array {
  const n = width * height
  const grad = new Float32Array(n)
  let maxG = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx =
        image[i - width + 1] +
        2 * image[i + 1] +
        image[i + width + 1] -
        (image[i - width - 1] + 2 * image[i - 1] + image[i + width - 1])
      const gy =
        image[i + width - 1] +
        2 * image[i + width] +
        image[i + width + 1] -
        (image[i - width - 1] + 2 * image[i - width] + image[i - width + 1])
      const g = Math.sqrt(gx * gx + gy * gy)
      grad[i] = g
      if (g > maxG) maxG = g
    }
  }
  const cost = new Float32Array(n)
  const inv = maxG > 0 ? 1 / maxG : 0
  for (let i = 0; i < n; i++) cost[i] = 1 - grad[i] * inv + 0.02
  return cost
}

// Minimal binary min-heap keyed by a parallel distance array (indices are pixels).
class MinHeap {
  private readonly heap: number[] = []
  constructor(private readonly dist: Float32Array) {}
  get size(): number {
    return this.heap.length
  }
  push(idx: number): void {
    const h = this.heap
    h.push(idx)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.dist[h[i]] >= this.dist[h[p]]) break
      ;[h[i], h[p]] = [h[p], h[i]]
      i = p
    }
  }
  pop(): number {
    const h = this.heap
    const top = h[0]
    const last = h.pop() as number
    if (h.length > 0) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let s = i
        if (l < h.length && this.dist[h[l]] < this.dist[h[s]]) s = l
        if (r < h.length && this.dist[h[r]] < this.dist[h[s]]) s = r
        if (s === i) break
        ;[h[i], h[s]] = [h[s], h[i]]
        i = s
      }
    }
    return top
  }
}

/**
 * Dijkstra from a seed pixel over the 8-connected cost grid. Returns the
 * predecessor pixel index for every pixel (-1 for the seed and unreached
 * pixels), i.e. the shortest-path tree used to backtrack the live wire.
 */
export function livewireField(
  cost: Float32Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
): Int32Array {
  const n = width * height
  const dist = new Float32Array(n).fill(Number.POSITIVE_INFINITY)
  const prev = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  const seed = seedY * width + seedX
  dist[seed] = 0
  const heap = new MinHeap(dist)
  heap.push(seed)
  while (heap.size > 0) {
    const u = heap.pop()
    if (done[u]) continue
    done[u] = 1
    const ux = u % width
    const uy = (u - ux) / width
    for (let dy = -1; dy <= 1; dy++) {
      const vy = uy + dy
      if (vy < 0 || vy >= height) continue
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const vx = ux + dx
        if (vx < 0 || vx >= width) continue
        const v = vy * width + vx
        if (done[v]) continue
        const step = (dx !== 0 && dy !== 0 ? SQRT2 : 1) * cost[v]
        const newDist = dist[u] + step
        if (newDist < dist[v]) {
          dist[v] = newDist
          prev[v] = u
          heap.push(v)
        }
      }
    }
  }
  return prev
}

/**
 * Backtrack the least-cost path from a target pixel to the seed of the given
 * predecessor field, returned seed-first in pixel coordinates.
 */
export function livewireBacktrack(
  prev: Int32Array,
  width: number,
  targetX: number,
  targetY: number,
): AnnotationPoint[] {
  const path: AnnotationPoint[] = []
  let idx = targetY * width + targetX
  // Guard against a cycle-free but bounded walk.
  let guard = prev.length + 1
  while (idx >= 0 && guard-- > 0) {
    path.push({ x: idx % width, y: Math.floor(idx / width) })
    idx = prev[idx]
  }
  return path.reverse()
}
