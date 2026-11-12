// Leica SCN: ImageDescription is an <scn> XML collection of images, each a
// pyramid (<dimension ifd r>) placed by its <view> in collection nanometres.
// The macro image's view spans the whole collection; the main (scanned)
// regions are the others. Spec: scratch/vendor/leica-spec.md.
import type { NVSlidePlacedPiece } from '@niivue/niivue'
import { attrs, tagsOf, type VendorPlacement } from './placement'

export interface LeicaRegion {
  /** IFD per resolution, finest (r=0) first. */
  ifds: number[]
  width: number
  height: number
  /** View origin and size in nm. */
  view: { x: number; y: number; width: number; height: number }
  brightfield: boolean
}

/** The main regions of an SCN collection in XML order, or null when it is not one. */
export function leicaRegions(xml: string): LeicaRegion[] | null {
  if (!/<scn\b/.test(xml)) return null
  const collection = tagsOf(xml, 'collection')[0]
  if (!collection) return null
  const cw = Number(collection.sizeX)
  const ch = Number(collection.sizeY)
  const regions: LeicaRegion[] = []
  for (const [, body = ''] of xml.matchAll(
    /<image\b[^>]*>([\s\S]*?)<\/image>/g,
  )) {
    const pixels = /<pixels\b([^>]*)>/.exec(body)?.[1]
    const view = tagsOf(body, 'view')[0]
    if (!pixels || !view) continue
    const p = attrs(pixels)
    const v = {
      x: Number(view.offsetX),
      y: Number(view.offsetY),
      width: Number(view.sizeX),
      height: Number(view.sizeY),
    }
    // The macro covers the collection.
    if (v.x === 0 && v.y === 0 && v.width === cw && v.height === ch) continue
    // Only z=0 (Leica writes one dimension per resolution, plane and channel).
    const dims = tagsOf(body, 'dimension')
      .filter((d) => (d.z ?? '0') === '0' && (d.c ?? '0') === '0')
      .sort((a, b) => Number(a.r) - Number(b.r))
    regions.push({
      ifds: dims.map((d) => Number(d.ifd)),
      width: Number(p.sizeX),
      height: Number(p.sizeY),
      view: v,
      brightfield: !/<illuminationSource>\s*fluorescence/.test(body),
    })
  }
  return regions.length ? regions : null
}

/** One region's storage grid at a level. */
export interface RegionLevel {
  width: number
  height: number
  tileWidth: number
  tileHeight: number
}

/** A level of the composed slide: regions side by side in one storage grid. */
export interface LeicaLevel {
  columns: number
  rows: number
  tileWidth: number
  tileHeight: number
  /** Each region's first column in the shared grid. */
  colStart: number[]
}

/**
 * Compose `regions` (each with its storage grid per level, finest first) into
 * one storage grid per level, regions side by side, placed by their views.
 * All regions must share a pixel size, tile size and level count.
 */
export function leicaComposition(
  regions: readonly LeicaRegion[],
  levels: readonly (readonly RegionLevel[])[],
): { grids: LeicaLevel[]; placement: VendorPlacement } {
  const nm = regions.map((r) => r.view.width / r.width)
  const px = nm[0] as number
  if (nm.some((v) => Math.abs(v - px) > px * 1e-3))
    throw new Error('Leica regions differ in pixel size')
  const count = Math.min(...levels.map((l) => l.length))
  const minX = Math.min(...regions.map((r) => r.view.x))
  const minY = Math.min(...regions.map((r) => r.view.y))
  const maxX = Math.max(...regions.map((r) => r.view.x + r.view.width))
  const maxY = Math.max(...regions.map((r) => r.view.y + r.view.height))
  // Whole level-0 px: sub-pixel view offsets are below the scanner's accuracy.
  const width = Math.round((maxX - minX) / px)
  const height = Math.round((maxY - minY) / px)
  const grids: LeicaLevel[] = []
  const placed = []
  for (let k = 0; k < count; k++) {
    const ls = levels.map((l) => l[k] as RegionLevel)
    const { tileWidth: tw, tileHeight: th } = ls[0] as RegionLevel
    if (ls.some((l) => l.tileWidth !== tw || l.tileHeight !== th))
      throw new Error(`Leica level ${k}: regions differ in tile size`)
    const cols = ls.map((l) => Math.ceil(l.width / tw))
    const colStart = cols.map((_, i) =>
      cols.slice(0, i).reduce((s, c) => s + c, 0),
    )
    const columns = cols.reduce((s, c) => s + c, 0)
    const rows = Math.max(...ls.map((l) => Math.ceil(l.height / th)))
    grids.push({ columns, rows, tileWidth: tw, tileHeight: th, colStart })
    // Level k px per level-0 px, from the first region.
    const s = (ls[0] as RegionLevel).width / (regions[0] as LeicaRegion).width
    const pieces: NVSlidePlacedPiece[] = []
    ls.forEach((l, i) => {
      const r = regions[i] as LeicaRegion
      const ox = Math.round((r.view.x - minX) / px) * s
      const oy = Math.round((r.view.y - minY) / px) * s
      for (let y = 0; y * th < l.height; y++)
        for (let x = 0; x * tw < l.width; x++)
          pieces.push({
            tile: y * columns + (colStart[i] as number) + x,
            sx: 0,
            sy: 0,
            sw: Math.min(tw, l.width - x * tw),
            sh: Math.min(th, l.height - y * th),
            dx: ox + x * tw,
            dy: oy + y * th,
          })
    })
    placed.push({ width: width * s, height: height * s, pieces })
  }
  return { grids, placement: { width, height, levels: placed } }
}
