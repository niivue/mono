// Trestle (MedScan) TIFF: each level is a mosaic of tiles that overlap their
// right and lower neighbours by that level's "OverlapsXY" pixels (the
// ImageDescription lists x y per level, finest first; missing levels are 0).
// Spec from our own decode: scratch/vendor/trestle-spec.md.
import type { NVSlidePlacedPiece } from '@niivue/niivue'
import type { StorageLevel, VendorPlacement } from './placement'

/** Per level [x, y] overlap in level px, or null when the description has none. */
export function trestleOverlaps(
  description: string,
): [number, number][] | null {
  const m = /OverlapsXY=\s*([\d\s]+)/.exec(description)
  const v = m?.[1]?.trim().split(/\s+/).map(Number) ?? []
  if (v.length < 2 || v.some((n) => !Number.isInteger(n) || n < 0)) return null
  const out: [number, number][] = []
  for (let i = 0; i + 1 < v.length; i += 2)
    out.push([v[i] as number, v[i + 1] as number])
  return out
}

/**
 * Each level's pieces: tile (c, r) drawn at (c, r) times (tile - overlap),
 * each interior overlap split at its midpoint. Levels past the listed
 * overlaps abut. `levels` carry their storage width/height. Throws on an
 * overlap not smaller than the tile.
 */
export function trestlePlacement(
  overlaps: readonly [number, number][],
  levels: readonly (StorageLevel & { width: number; height: number })[],
): VendorPlacement {
  const placed = levels.map((level, k) => {
    const [ox, oy] = overlaps[k] ?? [0, 0]
    const {
      tileWidth: tw,
      tileHeight: th,
      columns,
      rows,
      width,
      height,
    } = level
    if (ox >= tw || oy >= th)
      throw new Error(
        `level ${k}: overlap ${ox},${oy} is not smaller than the tile`,
      )
    const placedW = width - (columns - 1) * ox
    const placedH = height - (rows - 1) * oy
    // One axis of tile i: its crop start and size. Each interior overlap is
    // split at its midpoint; an edge tile shorter than half the overlap is
    // all duplicate (size 0) and its neighbour runs to the placed edge.
    const span = (
      i: number,
      n: number,
      t: number,
      o: number,
      size: number,
      placed: number,
    ) => {
      const start = i * (t - o)
      const s0 = i ? o / 2 : 0
      const end = Math.min(
        start + Math.min(t, size - i * t) - (i < n - 1 ? o / 2 : 0),
        placed,
      )
      return [s0, Math.max(0, end - start - s0)] as const
    }
    const pieces: NVSlidePlacedPiece[] = []
    for (let r = 0; r < rows; r++) {
      const [sy, h] = span(r, rows, th, oy, height, placedH)
      if (!h) continue
      for (let c = 0; c < columns; c++) {
        const [sx, w] = span(c, columns, tw, ox, width, placedW)
        if (!w) continue
        pieces.push({
          tile: r * columns + c,
          sx,
          sy,
          sw: w,
          sh: h,
          dx: c * (tw - ox) + sx,
          dy: r * (th - oy) + sy,
        })
      }
    }
    return { width: placedW, height: placedH, pieces }
  })
  const l0 = placed[0]
  return { width: l0?.width ?? 0, height: l0?.height ?? 0, levels: placed }
}
