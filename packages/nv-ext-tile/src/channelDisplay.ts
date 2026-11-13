import type { NVSlideWindow } from '@niivue/niivue'

// Display mapping shared by the TIFF and Zarr slide sources: uint8/uint16
// samples pass through; other dtypes are quantized to uint16 over a data
// range, with the inverse stated as channelInfo[c].storedToValue.

// One decoded tile stays under 64 MiB of RGBA; real slides use 256-1024 px.
export const MAX_TILE_SIZE = 4096
// Bounds the manifest's tile list: a 200k x 200k slide at 256 px is ~815k
// tiles incl. pyramid.
export const MAX_TILES = 1 << 21
// Each visible channel is a sample plane per tile in NVSlide's tile budget
// (tileCapacity): 27 u16 planes of 512² fit 4 tiles in the default cache. Caps a
// store that marks no channel inactive; the rest stay listed, hidden.
export const MAX_DEFAULT_VISIBLE = 4

/**
 * Stored = (v * k - lo) / span * 65535, with k = 1/2 when hi - lo overflows;
 * dividing before scaling keeps a subnormal span finite.
 * scale = 65535 / span, Infinity only for a subnormal span.
 */
export type Quantize = { k: number; lo: number; span: number; scale: number }

/**
 * Quantization of lo..hi to uint16. A flat or empty range says nothing of
 * the rest: centre a window on it (one step per unit, or half its magnitude
 * for a flat float) so values outside it stay distinct. `noData`: no finite
 * value was seen.
 */
export function quantizeRange(
  lo: number,
  hi: number,
  float: boolean,
): { quantize: Quantize; noData: boolean } {
  let noData = false
  if (!(hi > lo)) {
    noData = !Number.isFinite(lo)
    const mid = noData ? 0 : lo
    const half = !noData && float ? Math.max(Math.abs(mid) / 2, 1) : 32767.5
    ;[lo, hi] = [mid - half, mid + half]
  }
  const k = Number.isFinite(hi - lo) ? 1 : 0.5
  const span = hi * k - lo * k
  return { quantize: { k, lo: lo * k, span, scale: 65535 / span }, noData }
}

/** A data value in stored units (unclamped); identity without quantization. */
function toStored(q: Quantize | null, v: number): number {
  return q ? ((v * q.k - q.lo) / q.span) * 65535 : v
}

/** The inverse of {@link grayInto}'s quantization. */
export function storedToValue(q: Quantize): { scale: number; offset: number } {
  return { scale: q.span / (65535 * q.k), offset: q.lo / q.k }
}

/**
 * The window start..end (data units) in stored units; the full stored range
 * when degenerate (constant or all-NaN data), which setChannel would refuse.
 */
export function storedWindow(
  q: Quantize | null,
  start: number,
  end: number,
  bitsStored: 8 | 16,
): NVSlideWindow {
  const [calMin, calMax] = [toStored(q, start), toStored(q, end)]
  return calMax > calMin
    ? { calMin, calMax }
    : { calMin: 0, calMax: 2 ** bitsStored - 1 }
}

/**
 * One w x h grey plane into `out` from sample `o0`, `data` read with strides
 * (sy, sx); quantized (into a Uint16Array) when `q` is set, else copied (and
 * widened) as is. Strides are fixed per tile, so each loop is one case.
 */
export function grayInto(
  out: Uint8Array | Uint16Array | Int16Array | Float32Array,
  o0: number,
  data: ArrayLike<number>,
  sy: number,
  sx: number,
  w: number,
  h: number,
  q: Quantize | null,
): void {
  if (q) {
    // Clamp: a Uint16Array store wraps out-of-range values; NaN stores 0.
    // Multiply per pixel; divide only when a subnormal span overflows scale.
    const { k, lo, span, scale } = q
    if (Number.isFinite(scale) && k === 1 && sx === 1 && sy === w) {
      // The common case (TIFF tiles, x-fastest Zarr): one flat loop over
      // the tile's w * h samples is ~12% faster than the strided one (JSC),
      // and v * 1 is exact.
      for (let i = 0, n = w * h; i < n; i++)
        out[o0 + i] = Math.min(65535, Math.max(0, (data[i] - lo) * scale + 0.5))
    } else if (Number.isFinite(scale)) {
      for (let y = 0, o = o0; y < h; y++)
        for (let x = 0, i = y * sy; x < w; x++, i += sx, o++)
          out[o] = Math.min(
            65535,
            Math.max(0, (data[i] * k - lo) * scale + 0.5),
          )
    } else {
      for (let y = 0, o = o0; y < h; y++)
        for (let x = 0, i = y * sy; x < w; x++, i += sx, o++)
          out[o] = Math.min(
            65535,
            Math.max(0, ((data[i] * k - lo) / span) * 65535 + 0.5),
          )
    }
  } else if (sx === 1 && sy === w) {
    out.set(data, o0)
  } else {
    for (let y = 0, o = o0; y < h; y++)
      for (let x = 0, i = y * sy; x < w; x++, i += sx, o++) out[o] = data[i]
  }
}
