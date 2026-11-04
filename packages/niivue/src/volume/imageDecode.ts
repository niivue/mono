/**
 * Decode a browser-native image (PNG/JPEG/GIF/BMP) to raw RGBA bytes.
 *
 * Shared by the 2D image volume reader and the Allen atlas loader so the two
 * cannot drift on the OffscreenCanvas-vs-`document` fallback.
 */

import { loadImageElement, MAX_IMAGE_SIDE } from '@/NVLoader'

/** Decoded image: `data` is 4 bytes per pixel, row-major over `width`. */
export interface DecodedImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/**
 * The bitmap path needs BOTH capabilities: `createImageBitmap` decodes and
 * `OffscreenCanvas` rasterizes. They ship independently (a worker may have
 * one without the other), so each is detected on its own and anything less
 * falls through to the `document` path.
 */
function hasBitmapPath(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas === 'function'
  )
}

async function decodeViaBitmap(blob: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(blob)
  // finally: the bitmap holds decoder-owned memory and must be closed on
  // every path out of here, including a throwing drawImage/getImageData.
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Unable to create 2D context for image decode')
    }
    ctx.drawImage(bitmap, 0, 0)
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

async function decodeViaImageElement(blob: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImageElement(url)
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Unable to create 2D context for image decode')
    }
    ctx.drawImage(img, 0, 0)
    return ctx.getImageData(0, 0, img.width, img.height)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Width and height from a PNG, GIF, BMP or JPEG header, read before decoding
 * so a tiny file declaring a huge size is refused before it allocates pixels
 * (#511). Throws for anything else: the browser would sniff and decode it
 * unchecked.
 */
export function imageSize(buffer: ArrayBuffer): {
  width: number
  height: number
} {
  const b = new Uint8Array(buffer)
  const v = new DataView(buffer)
  if (b.length >= 24 && v.getUint32(0) === 0x89504e47) {
    return { width: v.getUint32(16), height: v.getUint32(20) }
  }
  if (b.length >= 10 && v.getUint32(0) === 0x47494638) {
    return gifSize(b, v)
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    // OS/2 BITMAPCOREHEADER (12 bytes) stores 16-bit sizes.
    if (v.getUint32(14, true) === 12) {
      return { width: v.getUint16(18, true), height: v.getUint16(20, true) }
    }
    // Negative height marks a top-down bitmap.
    return {
      width: Math.abs(v.getInt32(18, true)),
      height: Math.abs(v.getInt32(22, true)),
    }
  }
  if (b.length >= 4 && v.getUint16(0) === 0xffd8) {
    let i = 2
    while (i + 9 <= b.length && b[i] === 0xff) {
      // Any marker may be preceded by 0xff fill bytes.
      if (b[i + 1] === 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      // SOF0-SOF15, less DHT (C4), JPG (C8) and DAC (CC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = v.getUint16(i + 5)
        // Height 0 defers it to a DNL marker after the scan: size unknown.
        if (height === 0) break
        return { width: v.getUint16(i + 7), height }
      }
      i += 2 + v.getUint16(i + 2)
    }
  }
  throw new Error('Unrecognized or truncated image header')
}

/**
 * GIF size: the logical screen, grown to the first frame's bounds. Chromium
 * decodes a frame that overflows the screen at the frame's size, so a 1x1
 * screen alone does not bound the allocation.
 */
function gifSize(
  b: Uint8Array,
  v: DataView,
): { width: number; height: number } {
  let width = v.getUint16(6, true)
  let height = v.getUint16(8, true)
  // Skip the global color table, then extension blocks, to the first frame.
  let i = 13
  if (b.length > 10 && b[10] & 0x80) i += 3 * 2 ** ((b[10] & 7) + 1)
  while (i < b.length) {
    if (b[i] === 0x2c) {
      if (i + 9 > b.length) break
      width = Math.max(
        width,
        v.getUint16(i + 1, true) + v.getUint16(i + 5, true),
      )
      height = Math.max(
        height,
        v.getUint16(i + 3, true) + v.getUint16(i + 7, true),
      )
      break
    }
    if (b[i] !== 0x21) break
    // Extension: introducer, label, then sub-blocks up to a zero length.
    i += 2
    while (i < b.length && b[i] !== 0) i += b[i] + 1
    i++
  }
  return { width, height }
}

export async function decodeImageRGBA(
  buffer: ArrayBuffer,
): Promise<DecodedImage> {
  const { width, height } = imageSize(buffer)
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    throw new Error(
      `Image is ${width}x${height}, larger than ${MAX_IMAGE_SIDE} on a side`,
    )
  }
  const blob = new Blob([buffer])
  if (hasBitmapPath()) {
    return decodeViaBitmap(blob)
  }
  if (typeof document !== 'undefined') {
    return decodeViaImageElement(blob)
  }
  throw new Error('No image decoding path available')
}
