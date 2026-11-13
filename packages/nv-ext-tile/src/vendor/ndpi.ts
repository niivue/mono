// Hamamatsu NDPI: each pyramid level is one baseline JPEG strip with restart
// markers, and tag 65426 lists every restart interval's offset in the strip.
// A virtual tile is a rectangle of whole intervals, re-wrapped as a small
// JPEG: the strip's header with the tile's size, the intervals' entropy data
// renumbered RST0-7, then EOI. Spec: scratch/vendor/ndpi-spec.md.

/** NDPI_MCU_STARTS: each restart interval's byte offset in the strip. */
export const NDPI_MCU_STARTS = 65426
/** NDPI_SOURCELENS: objective magnification; -1 macro, -2 map (not levels). */
export const NDPI_SOURCELENS = 65421

export interface NdpiJpeg {
  /** The strip's bytes from SOI through the SOS segment. */
  header: Uint8Array
  /** Offset of the SOF height field in `header` (width follows). */
  sof: number
  width: number
  height: number
  mcuWidth: number
  mcuHeight: number
  /** MCUs per restart interval, and intervals per MCU row. */
  interval: number
  perRow: number
  mcuRows: number
}

/**
 * The strip's JPEG layout from its first bytes (through SOS), for a level of
 * `width` x `height` (TIFF ImageWidth/ImageLength: the SOF's 16-bit fields
 * cannot hold a level past 65535 px). Throws when it is not baseline/extended
 * Huffman with restart intervals that tile each MCU row exactly.
 */
export function ndpiJpeg(
  head: Uint8Array,
  width: number,
  height: number,
): NdpiJpeg {
  if (head[0] !== 0xff || head[1] !== 0xd8)
    throw new Error('NDPI strip is not JPEG')
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  let sof = -1
  let interval = 0
  let hMax = 1
  let vMax = 1
  for (let p = 2; p + 4 <= head.length; ) {
    if (head[p] !== 0xff)
      throw new Error('NDPI strip: a JPEG marker is missing')
    const m = head[p + 1] as number
    const len = dv.getUint16(p + 2)
    if (m === 0xc0 || m === 0xc1) {
      sof = p + 5
      const n = head[p + 9] as number
      for (let c = 0; c < n; c++) {
        const s = head[p + 11 + 3 * c] as number
        hMax = Math.max(hMax, s >> 4)
        vMax = Math.max(vMax, s & 15)
      }
    } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      throw new Error('NDPI strip: only baseline JPEG is tiled')
    else if (m === 0xdd) interval = dv.getUint16(p + 4)
    else if (m === 0xda) {
      const mcuWidth = 8 * hMax
      const mcuHeight = 8 * vMax
      const perMcuRow = Math.ceil(width / mcuWidth)
      if (sof < 0 || !interval || perMcuRow % interval)
        throw new Error('NDPI strip: restart intervals do not tile its rows')
      return {
        header: head.slice(0, p + 2 + len),
        sof,
        width,
        height,
        mcuWidth,
        mcuHeight,
        interval,
        perRow: perMcuRow / interval,
        mcuRows: Math.ceil(height / mcuHeight),
      }
    }
    p += 2 + len
  }
  throw new Error('NDPI strip: no scan in its first bytes')
}

/** The virtual tile grid: `across` intervals wide, `down` MCU rows high. */
export function ndpiGrid(j: NdpiJpeg, target = 512) {
  const iw = j.interval * j.mcuWidth
  const across = Math.max(1, Math.floor(target / iw))
  const down = Math.max(1, Math.round(target / j.mcuHeight))
  return {
    across,
    down,
    tileWidth: across * iw,
    tileHeight: down * j.mcuHeight,
    columns: Math.ceil(j.perRow / across),
    rows: Math.ceil(j.mcuRows / down),
  }
}

/**
 * One tile's JPEG from its MCU rows. Each row is the strip's bytes from its
 * first interval's start to its last interval's end marker (inclusive); `ends`
 * are each interval's end within it, where an RST (or, last in the strip, EOI)
 * marker sits. Throws when one is not there.
 */
export function ndpiTileJpeg(
  j: NdpiJpeg,
  width: number,
  height: number,
  rows: readonly { bytes: Uint8Array; ends: readonly number[] }[],
): Uint8Array {
  let size = j.header.length + 2
  for (const r of rows) size += r.bytes.length
  const out = new Uint8Array(size)
  out.set(j.header)
  out[j.sof] = height >> 8
  out[j.sof + 1] = height & 255
  out[j.sof + 2] = width >> 8
  out[j.sof + 3] = width & 255
  let o = j.header.length
  let rst = 0
  let first = true
  for (const { bytes, ends } of rows) {
    let from = 0
    for (const end of ends) {
      if (bytes[end] !== 0xff || ((bytes[end + 1] as number) & 0xf8) !== 0xd0) {
        if (!(bytes[end] === 0xff && bytes[end + 1] === 0xd9))
          throw new Error(
            'NDPI strip: no restart marker where its interval ends',
          )
      }
      if (!first) {
        out[o++] = 0xff
        out[o++] = 0xd0 | (rst++ & 7)
      }
      first = false
      out.set(bytes.subarray(from, end), o)
      o += end - from
      from = end + 2
    }
  }
  out[o++] = 0xff
  out[o++] = 0xd9
  return out.subarray(0, o)
}
