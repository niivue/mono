// Shared helpers for vendor tile placement (contracts section 7): frames of
// a level-0 mosaic, each with a crop in frame pixels and a placed origin, cut
// into pieces of each level's storage tiles.
import type { NVSlideLevelPlacement, NVSlidePlacedPiece } from '@niivue/niivue'

/** A pyramid level's storage grid, as the TIFF manifest states it. */
export interface StorageLevel {
  tileWidth: number
  tileHeight: number
  columns: number
  rows: number
  /** Level-0 storage px per level px. */
  downsample: number
}

/** One level-0 frame: its storage rect and the part of it placed, and where. */
export interface PlacedFrame {
  /** Storage origin of the frame (level-0 px). */
  x: number
  y: number
  /** Kept crop in frame px. */
  sx: number
  sy: number
  sw: number
  sh: number
  /** Placed origin of the crop (level-0 px). */
  dx: number
  dy: number
}

export interface VendorPlacement {
  /** Placed level-0 extent: the manifest's width/height when placement is on. */
  width: number
  height: number
  levels: NVSlideLevelPlacement[]
}

/** XML attributes of one tag, either quote style. */
export function attrs(tag: string): Record<string, string> {
  return Object.fromEntries(
    Array.from(
      tag.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs),
      ([, k, , v]) => [k, v],
    ),
  ) as Record<string, string>
}

/** Every `<name ...>` start tag in `xml`, as attributes. */
export function tagsOf(xml: string, name: string): Record<string, string>[] {
  return Array.from(
    xml.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g')),
    ([tag]) => attrs(tag),
  )
}

/** The text of the first element whose start tag matches `start` (regex source after `<`), up to its next tag. */
export const elementText = (xml: string, start: string): string | undefined =>
  new RegExp(`<${start}[^<>]*>([^<]*)<`).exec(xml)?.[1]

// Merge pieces of one tile that continue each other in source and placement:
// first along x (same rows), then along y (same columns).
function merge(pieces: NVSlidePlacedPiece[]): NVSlidePlacedPiece[] {
  const along = (
    list: NVSlidePlacedPiece[],
    key: (p: NVSlidePlacedPiece) => string,
    joins: (a: NVSlidePlacedPiece, b: NVSlidePlacedPiece) => boolean,
    grow: (a: NVSlidePlacedPiece, b: NVSlidePlacedPiece) => void,
  ) => {
    const last = new Map<string, NVSlidePlacedPiece>()
    const out: NVSlidePlacedPiece[] = []
    for (const p of list) {
      const k = key(p)
      const prev = last.get(k)
      if (prev && joins(prev, p)) grow(prev, p)
      else {
        const copy = { ...p }
        out.push(copy)
        last.set(k, copy)
      }
    }
    return out
  }
  const rows = along(
    pieces,
    (p) => `${p.tile}|${p.sy}|${p.sh}|${p.dy}`,
    (a, b) => b.sx === a.sx + a.sw && b.dx === a.dx + a.sw,
    (a, b) => {
      a.sw += b.sw
    },
  )
  return along(
    rows.sort((a, b) => a.tile - b.tile || a.sx - b.sx || a.sy - b.sy),
    (p) => `${p.tile}|${p.sx}|${p.sw}|${p.dx}`,
    (a, b) => b.sy === a.sy + a.sh && b.dy === a.dy + a.sh,
    (a, b) => {
      a.sh += b.sh
    },
  )
}

/**
 * Each level's pieces for level-0 `frames`, assuming lower levels are
 * downsampled from the unstitched level-0 storage image (crop and origin scale
 * by 1/downsample; pieces split at the level's tile boundaries). Throws when a
 * piece falls outside a level's storage grid.
 */
export function levelPieces(
  frames: readonly PlacedFrame[],
  levels: readonly StorageLevel[],
): VendorPlacement {
  let width = 0
  let height = 0
  for (const f of frames) {
    width = Math.max(width, f.dx + f.sw)
    height = Math.max(height, f.dy + f.sh)
  }
  const placed = levels.map((level, index): NVSlideLevelPlacement => {
    const k = 1 / level.downsample
    const { tileWidth: tw, tileHeight: th, columns, rows } = level
    const pieces: NVSlidePlacedPiece[] = []
    for (const f of frames) {
      if (f.sw <= 0 || f.sh <= 0) continue
      const x0 = (f.x + f.sx) * k
      const x1 = (f.x + f.sx + f.sw) * k
      const y0 = (f.y + f.sy) * k
      const y1 = (f.y + f.sy + f.sh) * k
      const c1 = Math.ceil(x1 / tw)
      const r1 = Math.ceil(y1 / th)
      if (c1 > columns || r1 > rows)
        throw new Error(`level ${index}: a frame lies outside the tile grid`)
      for (let r = Math.floor(y0 / th); r < r1; r++) {
        const ya = Math.max(y0, r * th)
        const yb = Math.min(y1, (r + 1) * th)
        for (let c = Math.floor(x0 / tw); c < c1; c++) {
          const xa = Math.max(x0, c * tw)
          const xb = Math.min(x1, (c + 1) * tw)
          pieces.push({
            tile: r * columns + c,
            sx: xa - c * tw,
            sy: ya - r * th,
            sw: xb - xa,
            sh: yb - ya,
            dx: f.dx * k + (xa - x0),
            dy: f.dy * k + (ya - y0),
          })
        }
      }
    }
    return { width: width * k, height: height * k, pieces: merge(pieces) }
  })
  return { width, height, levels: placed }
}
