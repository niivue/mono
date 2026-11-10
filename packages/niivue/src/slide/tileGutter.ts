// Backend-neutral planning of the 1-texel tile gutter shared by the slide
// renderers (gl/ and wgpu/ slide.ts, slidePlaneRender.ts).
//
// Each tile is its own texture, so bilinear filtering cannot see the
// neighbouring tile: clamp-to-edge leaves a one-source-texel seam at every
// tile border when magnified. A tile is therefore uploaded into a texture 2
// texels larger per axis whose border holds the adjacent texels of its 8
// neighbours (a clamped copy of its own edge while a neighbour is absent), and
// the renderers sample only the interior. The border copies run on the GPU
// from the neighbours' textures, so no decoded CPU bytes are kept: an upload
// fills its own border (8 copies) and refreshes the slots of resident
// neighbours that now read from it (at most 16), so borders converge as tiles
// stream and a frame without uploads does no gutter work.

/** Interior size of a tile texture (the bitmap size). */
export interface GutterTile {
  width: number
  height: number
}

/**
 * Where a tile goes: its cache key (NVSlide's `L<level>/<col>/<row>`), grid
 * position and slide. Keys do not name the slide, so a neighbour is read only
 * when it was uploaded from the same slide.
 */
export interface GutterAt {
  slide: object
  key: string
  level: number
  col: number
  row: number
}

/**
 * Copy `width` x `height` texels from (srcX, srcY) of a padded source texture
 * to (x, y) of the padded destination.
 */
export interface GutterCopy {
  x: number
  y: number
  srcX: number
  srcY: number
  width: number
  height: number
}

const NEIGHBOURS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const

/** GPU bytes of a w x h tile texture with its gutter. */
export function gutterTextureBytes(width: number, height: number): number {
  return (width + 2) * (height + 2) * 4
}

// [destination, source, length] along one axis, in padded texels: from the
// adjacent edge of a neighbour of `neighbourSize`, else a clamped own edge.
function gutterAxis(
  d: number,
  size: number,
  neighbourSize: number | undefined,
): [number, number, number] {
  if (d < 0) return [0, neighbourSize ?? 1, 1]
  if (d > 0) return [size + 1, neighbourSize === undefined ? size : 1, 1]
  return [1, 1, size]
}

/**
 * Fill border slot (dx, dy) of `tile` (at `col`, `row`) from the nearest
 * resident source: for an edge the neighbour, for a corner the diagonal, then
 * the edge neighbour beside it (clamped along the other axis, as at the slide
 * edge), else the tile's own edge. With `only`, copies only when that is the
 * source. Same-column (row) tiles share a width (height), as in any grid.
 */
function fillSlot<T extends GutterTile>(
  level: number,
  col: number,
  row: number,
  tile: T,
  dx: number,
  dy: number,
  neighbour: (key: string) => T | undefined,
  copy: (src: T | null, dst: T, c: GutterCopy) => void,
  only?: T,
): void {
  const sources = dx && dy ? [dx, dy, dx, 0, 0, dy, 0, 0] : [dx, dy, 0, 0]
  for (let i = 0; i < sources.length; i += 2) {
    const sx = sources[i] as number
    const sy = sources[i + 1] as number
    const src = sx || sy ? neighbour(`L${level}/${col + sx}/${row + sy}`) : tile
    if (!src) continue
    if (only && src !== only) return
    const [x, srcX, width] = gutterAxis(
      dx,
      tile.width,
      sx ? src.width : undefined,
    )
    const [y, srcY, height] = gutterAxis(
      dy,
      tile.height,
      sy ? src.height : undefined,
    )
    copy(src === tile ? null : src, tile, { x, y, srcX, srcY, width, height })
    return
  }
}

/**
 * Fill the gutter of `tile` (tile `col`, `row` of level `level`, just
 * uploaded and already returned by `neighbour`) and refresh the slots of
 * resident neighbours that now read from it. `neighbour` looks a texture up
 * by tile key; `copy` records one copy into `dst`, where a null `src` means
 * `dst`'s own edge.
 */
export function syncGutters<T extends GutterTile>(
  level: number,
  col: number,
  row: number,
  tile: T,
  neighbour: (key: string) => T | undefined,
  copy: (src: T | null, dst: T, c: GutterCopy) => void,
): void {
  for (const [dx, dy] of NEIGHBOURS)
    fillSlot(level, col, row, tile, dx, dy, neighbour, copy)
  for (const [ox, oy] of NEIGHBOURS) {
    const n = neighbour(`L${level}/${col + ox}/${row + oy}`)
    if (!n) continue
    // Slots of n that can read this tile, at offset (-ox, -oy) from n.
    for (const [dx, dy] of NEIGHBOURS)
      if ((dx === -ox && (dy === -oy || oy === 0)) || (ox === 0 && dy === -oy))
        fillSlot(level, col + ox, row + oy, n, dx, dy, neighbour, copy, tile)
  }
}
