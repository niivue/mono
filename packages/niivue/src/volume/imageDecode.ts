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

export async function decodeImageRGBA(
  buffer: ArrayBuffer,
): Promise<DecodedImage> {
  const blob = new Blob([buffer])
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      throw new Error('Unable to create 2D context for image decode')
    }
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    bitmap.close()
    return imageData
  }
  if (typeof document !== 'undefined') {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Unable to create 2D context for image decode'))
          return
        }
        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, img.width, img.height)
        URL.revokeObjectURL(img.src)
        resolve(imageData)
      }
      img.onerror = () => reject(new Error('Failed to decode image'))
      img.src = URL.createObjectURL(blob)
    })
  }
  throw new Error('No image decoding path available')
}
