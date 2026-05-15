// Tiny PNG writer wrapper around pngjs that takes raw RGBA and returns
// a Buffer. Used to encode 2D slices for the IIIF Image API.

import { PNG } from 'pngjs'

export function rgbaToPng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Buffer {
  const png = new PNG({
    width,
    height,
    colorType: 6,
    inputColorType: 6,
    bitDepth: 8,
  })
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  return PNG.sync.write(png)
}
