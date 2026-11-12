import type {
  NVChannel,
  NVSlideChannelBlend,
  NVSlideLevelManifest,
} from './NVSlide'
import { fusePlan, fuseSamples, isFuseTile } from './slideFuse'
import type { TileBitmap } from './tileLru'

/**
 * Composite `level` from its resident tile `entries` (one per `level.tiles`
 * slot) on the CPU, scaled to fit `maxPx` a side. Null without a 2D context.
 */
export function composeThumbnail(
  level: NVSlideLevelManifest,
  entries: readonly (TileBitmap | undefined)[],
  maxPx: number,
  tw: number,
  th: number,
  channels: readonly Readonly<NVChannel>[],
  blend: NVSlideChannelBlend,
): ImageBitmap | null {
  const k = Math.min(1, maxPx / Math.max(level.width, level.height))
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(level.width * k)),
    Math.max(1, Math.round(level.height * k)),
  )
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // Minified tiles: browsers filter better than bilinear at 'high'.
  ctx.imageSmoothingQuality = 'high'
  // Rounded edges: fractional ones would leave seams between tiles.
  const draw = (
    src: CanvasImageSource,
    w: number,
    h: number,
    x: number,
    y: number,
  ) => {
    const x0 = Math.round(x * k)
    const y0 = Math.round(y * k)
    ctx.drawImage(
      src,
      0,
      0,
      w,
      h,
      x0,
      y0,
      Math.round((x + w) * k) - x0,
      Math.round((y + h) * k) - y0,
    )
  }
  let scratch: OffscreenCanvasRenderingContext2D | null = null
  level.tiles.forEach((tile, i) => {
    const entry = entries[i]
    if (!tile || !entry) return
    if (isFuseTile(entry)) {
      const { samples, width, height } = entry.samples
      const plan = fusePlan(channels, blend, entry)
      const rgba = fuseSamples(samples, width * height, plan)
      // putImageData does not scale: through a tile-sized canvas.
      scratch ??= new OffscreenCanvas(tw, th).getContext('2d')
      if (!scratch) return
      scratch.putImageData(new ImageData(rgba, width, height), 0, 0)
      draw(scratch.canvas, width, height, tile.x * tw, tile.y * th)
    } else if (entry.bitmap) {
      const { width, height } = entry.bitmap
      draw(entry.bitmap, width, height, tile.x * tw, tile.y * th)
    }
  })
  const bitmap = canvas.transferToImageBitmap()
  return bitmap
}
