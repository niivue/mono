/**
 * Decode a browser-native image (PNG/JPEG/GIF/BMP) to raw RGBA bytes.
 *
 * Shared by the 2D image volume reader and the Allen atlas loader so the two
 * cannot drift on the OffscreenCanvas-vs-`document` fallback.
 */

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

function decodeViaImageElement(blob: Blob): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    // Every terminal path runs through settle exactly once, so the object URL
    // is revoked on success, on decode failure, and on a throwing canvas op.
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      URL.revokeObjectURL(url)
      action()
    }
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          throw new Error('Unable to create 2D context for image decode')
        }
        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, img.width, img.height)
        settle(() => resolve(imageData))
      } catch (err) {
        settle(() => reject(err))
      }
    }
    img.onerror = () => {
      settle(() => reject(new Error('Failed to decode image')))
    }
    try {
      img.src = url
    } catch (err) {
      settle(() => reject(err))
    }
  })
}

export async function decodeImageRGBA(
  buffer: ArrayBuffer,
): Promise<DecodedImage> {
  const blob = new Blob([buffer])
  if (hasBitmapPath()) {
    return decodeViaBitmap(blob)
  }
  if (typeof document !== 'undefined') {
    return decodeViaImageElement(blob)
  }
  throw new Error('No image decoding path available')
}
