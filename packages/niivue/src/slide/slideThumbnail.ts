import type {
  NVChannel,
  NVSlideChannelBlend,
  NVSlideChannelInfo,
  NVSlideLevelManifest,
} from './NVSlide'
import { fusePlan, fuseSamples, isFuseTile } from './slideFuse'
import type { TileBitmap } from './tileLru'

/**
 * Composite `level` from its resident tile `entries` (one per `level.tiles`
 * slot) on the CPU, scaled to fit `maxPx` a side. Null without a 2D context.
 * `info` and `selected` (channelInfo, selectedLabel) colour label channels.
 */
export function composeThumbnail(
  level: NVSlideLevelManifest,
  entries: readonly (TileBitmap | undefined)[],
  maxPx: number,
  tw: number,
  th: number,
  channels: readonly Readonly<NVChannel>[],
  blend: NVSlideChannelBlend,
  info?: readonly NVSlideChannelInfo[],
  selected?: { channel: number; id: number } | null,
): ImageBitmap | null {
  // Placed (SRC-20): the placed extent, each piece's crop at its origin.
  const placement = level.placement
  const width = placement?.width ?? level.width
  const height = placement?.height ?? level.height
  const k = Math.min(1, maxPx / Math.max(width, height))
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(width * k)),
    Math.max(1, Math.round(height * k)),
  )
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // Minified tiles: browsers filter better than bilinear at 'high'.
  ctx.imageSmoothingQuality = 'high'
  // Rounded edges: fractional ones would leave seams between tiles.
  const draw = (
    src: CanvasImageSource,
    sx: number,
    sy: number,
    w: number,
    h: number,
    x: number,
    y: number,
  ) => {
    const x0 = Math.round(x * k)
    const y0 = Math.round(y * k)
    ctx.drawImage(
      src,
      sx,
      sy,
      w,
      h,
      x0,
      y0,
      Math.round((x + w) * k) - x0,
      Math.round((y + h) * k) - y0,
    )
  }
  let scratch: OffscreenCanvasRenderingContext2D | null = null
  // Tile slot `i` as a drawable and its size, or null.
  const source = (i: number): [CanvasImageSource, number, number] | null => {
    const entry = entries[i]
    if (!level.tiles[i] || !entry) return null
    if (isFuseTile(entry)) {
      const { samples, width: w, height: h } = entry.samples
      const plan = fusePlan(channels, blend, entry, info, selected)
      const rgba = fuseSamples(samples, w * h, plan)
      // putImageData does not scale: through a tile-sized canvas.
      scratch ??= new OffscreenCanvas(tw, th).getContext('2d')
      if (!scratch) return null
      scratch.putImageData(new ImageData(rgba, w, h), 0, 0)
      return [scratch.canvas, w, h]
    }
    return entry.bitmap
      ? [entry.bitmap, entry.bitmap.width, entry.bitmap.height]
      : null
  }
  if (placement)
    // ponytail: a tile with two pieces is fused twice; seams inside a tile are rare.
    for (const p of placement.pieces) {
      const src = source(p.tile)
      if (src) draw(src[0], p.sx, p.sy, p.sw, p.sh, p.dx, p.dy)
    }
  else
    level.tiles.forEach((tile, i) => {
      const src = tile && source(i)
      if (src) draw(src[0], 0, 0, src[1], src[2], tile.x * tw, tile.y * th)
    })
  const bitmap = canvas.transferToImageBitmap()
  return bitmap
}
