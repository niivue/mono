// OpenJPEG (JPEG 2000) tile decoder for NVSlide, used by the slides demo.
//
// NVSlide ships no JPEG 2000 codec (browsers can't createImageBitmap a J2K
// codestream), so the demo registers this decoder via
// NVSlide.registerTileDecoder('image/jp2', decodeJp2). The WASM is embedded in
// the JS build (no separate .wasm to serve), and loaded lazily on first use.
import OpenJPEGJS from '@cornerstonejs/codec-openjpeg'

let modulePromise = null

function openjpeg() {
  if (!modulePromise) modulePromise = OpenJPEGJS()
  return modulePromise
}

// Decode a DICOM-encapsulated J2K codestream tile into an ImageBitmap. OpenJPEG
// applies the multi-component (color) transform, so a 3-component image comes
// back as interleaved RGB; 1 component is grayscale.
export async function decodeJp2(bytes) {
  const m = await openjpeg()
  const decoder = new m.J2KDecoder()
  try {
    const encoded = decoder.getEncodedBuffer(bytes.length)
    encoded.set(bytes)
    decoder.decode()
    const info = decoder.getFrameInfo()
    const decoded = decoder.getDecodedBuffer()
    const { width, height, componentCount } = info
    const pixels = width * height
    const rgba = new Uint8ClampedArray(pixels * 4)
    if (componentCount >= 3) {
      for (let i = 0; i < pixels; i++) {
        const s = i * componentCount
        rgba[i * 4] = decoded[s]
        rgba[i * 4 + 1] = decoded[s + 1]
        rgba[i * 4 + 2] = decoded[s + 2]
        rgba[i * 4 + 3] = 255
      }
    } else {
      for (let i = 0; i < pixels; i++) {
        const v = decoded[i]
        rgba[i * 4] = v
        rgba[i * 4 + 1] = v
        rgba[i * 4 + 2] = v
        rgba[i * 4 + 3] = 255
      }
    }
    return createImageBitmap(new ImageData(rgba, width, height))
  } finally {
    decoder.delete()
  }
}
