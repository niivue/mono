import type {
  NVChannel,
  NVSlideChannelBlend,
  NVSlideChannelInfo,
  NVSlideColorLut,
  NVSlideLevelManifest,
  TileBitmap,
} from './NVSlide'
import { fusePlan, fuseSamples, isFuseTile } from './slideFuse'

/**
 * Composite `level` from its resident tile `entries` (one per `level.tiles`
 * slot) on the CPU, scaled to fit `maxPx` a side. Null without a 2D context.
 * `info` and `selected` (channelInfo, selectedLabel) colour label channels;
 * `lut` (displayColorLut) maps the result to sRGB as the renderers do.
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
  lut?: NVSlideColorLut | null,
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
  // Label channels alone: no blended colours between IDs, as the GPU draws them nearest.
  ctx.imageSmoothingEnabled = !(
    channels.some((c) => c.visible) &&
    channels.every((c, i) => !c.visible || info?.[i]?.kind === 'label')
  )
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
  if (lut) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    applyColorLut(img.data, lut)
    ctx.putImageData(img, 0, 0)
  }
  return canvas.transferToImageBitmap()
}

/**
 * `rgba` through `lut` in place: trilinear between nodes, as the shaders'
 * linear 3D texture fetch at node centres (slide/colorLutShader.ts). Alpha kept.
 */
export function applyColorLut(
  rgba: Uint8ClampedArray,
  lut: NVSlideColorLut,
): void {
  const { size: n, data } = lut
  const dR = 4
  const dG = 4 * n
  const dB = 4 * n * n
  // Per 8-bit value: lower node (stride-scaled, red fastest) and weight. The
  // lower node stops at n - 2, so its upper neighbour always exists.
  const loR = new Int32Array(256)
  const loG = new Int32Array(256)
  const loB = new Int32Array(256)
  const frac = new Float32Array(256)
  for (let v = 0; v < 256; v++) {
    const t = (v * (n - 1)) / 255
    const i = Math.min(Math.floor(t), n - 2)
    frac[v] = t - i
    loR[v] = i * dR
    loG[v] = i * dG
    loB[v] = i * dB
  }
  for (let p = 0; p < rgba.length; p += 4) {
    const r = rgba[p]
    const g = rgba[p + 1]
    const b = rgba[p + 2]
    const fr = frac[r]
    const fg = frac[g]
    const fb = frac[b]
    const o000 = loR[r] + loG[g] + loB[b]
    const o100 = o000 + dR
    const o010 = o000 + dG
    const o110 = o010 + dR
    for (let c = 0; c < 3; c++) {
      const x00 = data[o000 + c] + (data[o100 + c] - data[o000 + c]) * fr
      const x10 = data[o010 + c] + (data[o110 + c] - data[o010 + c]) * fr
      const x01 =
        data[o000 + dB + c] + (data[o100 + dB + c] - data[o000 + dB + c]) * fr
      const x11 =
        data[o010 + dB + c] + (data[o110 + dB + c] - data[o010 + dB + c]) * fr
      const y0 = x00 + (x10 - x00) * fg
      const y1 = x01 + (x11 - x01) * fg
      rgba[p + c] = y0 + (y1 - y0) * fb
    }
  }
}
