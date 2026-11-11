import { robustMinMax } from '@niivue/niivue'

// A slide source's default windows come from a GRID x GRID grid of tiles
// spread over the coarsest level, at most SPAN square from the middle of each:
// open reads at most GRID^2 tiles per channel whatever the level's size, and a
// level of up to GRID x GRID tiles is read whole. The spread, not the centre
// alone, keeps a background-heavy centre from collapsing the window.
const GRID = 4
const SPAN = 1024
// Reads in flight per channel.
const READS = 4
// The 2-98% window is taken from at most this many samples (8 MiB of float64,
// a fixed stride over every read); min and max from every sample.
const MAX_KEPT = 1 << 20

/** [start, end) ranges along one axis of `n` samples in tiles of `tile`. */
function spread(n: number, tile: number): [number, number][] {
  const count = Math.ceil(n / tile)
  const starts = new Set<number>()
  for (let i = 0; i < GRID; i++)
    starts.add(Math.max(0, Math.round((i * (count - 1)) / (GRID - 1))) * tile)
  return [...starts].map((a) => {
    const len = Math.min(tile, n - a)
    const k = Math.min(len, SPAN)
    const b = a + Math.floor((len - k) / 2)
    return [b, b + k]
  })
}

/**
 * `[p2, p98, min, max]` of the finite values of a level's sample grid (the
 * volume rule, `robustMinMax`); `[Infinity, -Infinity, ...]` when none is
 * finite. `read(y, x)` returns the samples of one cell, any order. A failed
 * read rejects at once; reads already started (at most READS - 1) finish
 * unawaited, so a stalled one cannot hold the open.
 */
export async function sampleLevel(
  width: number,
  height: number,
  tileWidth: number,
  tileHeight: number,
  read: (
    y: [number, number],
    x: [number, number],
  ) => Promise<ArrayLike<number>>,
): Promise<[number, number, number, number]> {
  const xs = spread(width, tileWidth)
  const cells = spread(height, tileHeight).flatMap((y) =>
    xs.map((x): [typeof y, typeof x] => [y, x]),
  )
  const area = ([y, x]: (typeof cells)[number]) => (y[1] - y[0]) * (x[1] - x[0])
  const total = cells.reduce((s, c) => s + area(c), 0)
  const stride = Math.max(1, Math.ceil(total / MAX_KEPT))
  // Each cell keeps ceil(len / stride) samples.
  const kept = new Float64Array(Math.ceil(total / stride) + cells.length)
  let n = 0
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < cells.length) {
      const [y, x] = cells[next++]
      try {
        const data = await read(y, x)
        // One pass: keep each stride's first sample, min/max over all.
        for (let i = 0; i < data.length; i += stride) {
          kept[n++] = data[i]
          const end = Math.min(i + stride, data.length)
          for (let j = i; j < end; j++) {
            const v = data[j]
            if (!Number.isFinite(v)) continue
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
        }
      } catch (e) {
        failed = true
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: READS }, worker))
  // Kept non-finite samples are left out of the percentiles too.
  const robust = robustMinMax(kept.subarray(0, n))
  return robust ? [robust[0], robust[1], lo, hi] : [lo, hi, lo, hi]
}
