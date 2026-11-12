import { lookupColorMap } from '@/cmap/NVCmaps'
import { log } from '@/logger'
import { channelColormapsFor } from '@/volume/channelColormaps'
import type {
  NVChannel,
  NVSlideChannelInfo,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideWindow,
} from './NVSlide'

// raw-gray tiles are samples whatever the (optional, DICOM) photometric says.
export const isMonochrome = (level: NVSlideLevelManifest): boolean =>
  level.codec === 'raw-gray' ||
  (level.photometric?.startsWith('MONOCHROME') ?? false)

/** RGB samples (no channelInfo, not monochrome) only make sense added. */
export const isRgbSlide = (manifest: NVSlideManifest): boolean =>
  !manifest.channelInfo && !manifest.levels.some(isMonochrome)

export const usableWindow = (w?: NVSlideWindow): w is NVSlideWindow =>
  !!w &&
  Number.isFinite(w.calMin) &&
  Number.isFinite(w.calMax) &&
  w.calMax > w.calMin

/** The channels a slide opens with: its manifest's `channelInfo`, else grey or RGB. */
export function defaultSlideChannels(manifest: NVSlideManifest): NVChannel[] {
  const info = manifest.channelInfo
  if (info) {
    // One channel with no stated colour is grey, as with no channelInfo.
    const colormaps =
      info.length === 1 && !info[0]?.rgb
        ? ['gray']
        : channelColormapsFor(info.map((c) => c.rgb))
    return info.map((c, i) => ({
      name: c.name,
      // An unknown name would make every later setChannel throw.
      colormap:
        c.colormap && lookupColorMap(c.colormap)
          ? c.colormap
          : (colormaps[i] as string),
      calMin: usableWindow(c.window) ? c.window.calMin : Number.NaN,
      calMax: usableWindow(c.window) ? c.window.calMax : Number.NaN,
      visible: c.active,
    }))
  }
  const names = manifest.levels.some(isMonochrome)
    ? ['gray']
    : ['red', 'green', 'blue']
  return names.map((name) => ({
    name,
    colormap: name,
    calMin: Number.NaN,
    calMax: Number.NaN,
    visible: true,
  }))
}

/**
 * The single-channel rules for a manifest's `channelInfo` on a source with or
 * without `fetchTileSamples`: a caller's non-monochrome bytes source cannot
 * state channels (it would stop being RGB); several on a monochrome bytes
 * source warn, since its tiles hold channel 0 only. `restored`: the manifest
 * alone, its sample source gone (a document); it keeps its channel state with
 * one warning.
 */
export function checkChannelInfo(
  manifest: NVSlideManifest,
  hasSamples: boolean,
  restored: boolean,
): void {
  const info = manifest.channelInfo
  if (!info || hasSamples) return
  if (!manifest.levels.some(isMonochrome)) {
    if (!restored)
      throw new Error(
        `Slide ${manifest.id}: channelInfo needs a monochrome level or a source with fetchTileSamples`,
      )
    log.warn(
      `Slide ${manifest.id}: channelInfo without its sample source; tiles draw as stored, channel settings are kept`,
    )
  } else if (info.length > 1)
    log.warn(
      `Slide ${manifest.id}: ${info.length} channels on a source without fetchTileSamples; only channel 0 receives samples`,
    )
}

type StoredToValue = NVSlideChannelInfo['storedToValue']

/** A stored sample in data units: stored * scale + offset; identity without a map. */
export const toValue = (stored: number, map?: StoredToValue): number =>
  map ? stored * map.scale + map.offset : stored

/**
 * The inverse of {@link toValue}. A quantized map's stored values are integers,
 * so the result is rounded: toStored(toValue(s, m), m) === s.
 */
export function toStored(value: number, map?: StoredToValue): number {
  if (!map) return value
  const stored = (value - map.offset) / map.scale
  return map.quantized === false ? stored : Math.round(stored)
}

/** A CPU-backed 2D context to read pixels from; null without OffscreenCanvas. */
export function readbackContext(
  width: number,
  height: number,
): OffscreenCanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  // Skip a GPU-backed canvas and its readback.
  const ctx = new OffscreenCanvas(width, height).getContext('2d', {
    willReadFrequently: true,
  })
  // A reused context: a translucent pixel must not blend with the last one.
  if (ctx) ctx.globalCompositeOperation = 'copy'
  return ctx
}

/** A bitmap region's decoded RGBA. */
export function readPixels(
  ctx: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  sx: number,
  sy: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  ctx.drawImage(bitmap, sx, sy, width, height, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height).data
}
