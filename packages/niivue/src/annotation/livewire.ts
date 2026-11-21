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

/**
 * cornerstone's LivewireScissors terms (annotationIsLivewireScissors), on the
 * slice mapped through the display window to 0..1 as cornerstone maps it
 * through its VOI range: edge strength (1 - |gradient| / max), a Laplacian
 * zero-crossing mask (0 on a crossing) and the gradient for the direction term.
 */
export type ScissorsCost = {
  grad: Float32Array
  laplace: Uint8Array
  gx: Float32Array
  gy: Float32Array
}

export function buildScissorsCost(
  image: Float32Array,
  width: number,
  height: number,
  lower: number,
  upper: number,
): ScissorsCost {
  const n = width * height
  const g = new Float32Array(n)
  const range = upper - lower || 1
  for (let i = 0; i < n; i++)
    g[i] = Math.max(0, Math.min(1, ((image[i] as number) - lower) / range))
  // Forward differences, repeating the last row/column (cornerstone's deltas).
  const gx = new Float32Array(n)
  const gy = new Float32Array(n)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const ix = x + 1 === width ? i - 1 : i
      const iy = y + 1 === height ? i - width : i
      gx[i] = (g[ix + 1] as number) - (g[ix] as number)
      gy[i] = (g[iy] as number) - (g[iy + width] as number)
    }
  const grad = new Float32Array(n)
  let max = 0
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(gx[i] as number, gy[i] as number)
    grad[i] = m
    if (m > max) max = m
  }
  for (let i = 0; i < n; i++) grad[i] = 1 - (grad[i] as number) / (max || 1)
  const laplace = new Uint8Array(n).fill(1)
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x
      const w = width
      const lap =
        (g[i - 2 * w] as number) +
        (g[i - w - 1] as number) +
        2 * (g[i - w] as number) +
        (g[i - w + 1] as number) +
        (g[i - 2] as number) +
        2 * (g[i - 1] as number) -
        16 * (g[i] as number) +
        2 * (g[i + 1] as number) +
        (g[i + 2] as number) +
        (g[i + w - 1] as number) +
        2 * (g[i + w] as number) +
        (g[i + w + 1] as number) +
        (g[i + 2 * w] as number)
      laplace[i] = lap > 0.33 ? 0 : 1
    }
  return { grad, laplace, gx, gy }
}

const TWO_THIRD_PI = 2 / (3 * Math.PI)

/**
 * {@link livewireField} with cornerstone's step cost from `u` to its neighbour
 * `v`: 0.43 edge strength + 0.43 Laplacian + 0.11 gradient direction. A
 * separate loop: the direction term depends on the step, not the pixel.
 */
export function livewireFieldScissors(
  sc: ScissorsCost,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
): Int32Array {
  const { grad, laplace, gx, gy } = sc
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
    const ul = Math.hypot(gx[u] as number, gy[u] as number) || 1e-100
    const upx = (gx[u] as number) / ul
    const upy = (gy[u] as number) / ul
    for (let dy = -1; dy <= 1; dy++) {
      const vy = uy + dy
      if (vy < 0 || vy >= height) continue
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const vx = ux + dx
        if (vx < 0 || vx >= width) continue
        const v = vy * width + vx
        if (done[v]) continue
        const isAxial = dx === 0 || dy === 0
        const vl = Math.hypot(gx[v] as number, gy[v] as number) || 1e-100
        let dp = upy * dx - upx * dy
        let dq = ((gy[v] as number) / vl) * dx - ((gx[v] as number) / vl) * dy
        if (dp < 0) {
          dp = -dp
          dq = -dq
        }
        if (!isAxial) {
          dp *= Math.SQRT1_2
          dq *= Math.SQRT1_2
        }
        dq = Math.min(Math.max(dq, -1), 1)
        const dir = TWO_THIRD_PI * (Math.acos(Math.min(dp, 1)) + Math.acos(dq))
        const step =
          0.43 * (grad[v] as number) * (isAxial ? Math.SQRT1_2 : 1) +
          0.43 * (laplace[v] as number) +
          0.11 * (Number.isFinite(dir) ? dir : 1)
        const newDist = (dist[u] as number) + step
        if (newDist < (dist[v] as number)) {
          dist[v] = newDist
          prev[v] = u
          heap.push(v)
        }
      }
    }
  }
  return prev
}
