import { afterEach, describe, expect, test } from 'bun:test'
import { decodeImageRGBA, imageSize } from './imageDecode'

/**
 * The decoder's two paths are driven entirely by globals (`createImageBitmap`,
 * `OffscreenCanvas`, `document`, `Image`, `URL.createObjectURL`), none of
 * which exist in the Bun harness, so each test installs exactly the
 * capabilities of the environment it plays and afterEach restores the world.
 */

const globalRef = globalThis as Record<string, unknown>
const patches: Array<{
  target: Record<string, unknown>
  key: string
  had: boolean
  original: unknown
}> = []

function patch(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  patches.push({
    target,
    key,
    had: Object.hasOwn(target, key),
    original: target[key],
  })
  if (value === undefined) {
    delete target[key]
  } else {
    target[key] = value
  }
}

afterEach(() => {
  for (const { target, key, had, original } of patches.reverse()) {
    if (had) {
      target[key] = original
    } else {
      delete target[key]
    }
  }
  patches.length = 0
})

/** URL.createObjectURL/revokeObjectURL doubles that count and pair-check. */
function trackObjectUrls(): { created: string[]; revoked: string[] } {
  const created: string[] = []
  const revoked: string[] = []
  const urlStatics = URL as unknown as Record<string, unknown>
  patch(urlStatics, 'createObjectURL', () => {
    const url = `blob:test-${created.length}`
    created.push(url)
    return url
  })
  patch(urlStatics, 'revokeObjectURL', (url: string) => {
    revoked.push(url)
  })
  return { created, revoked }
}

interface BitmapTracker {
  closed: number
}

function installBitmapPath(options: {
  tracker: BitmapTracker
  context?: unknown
  drawThrows?: boolean
}): void {
  patch(globalRef, 'createImageBitmap', async () => ({
    width: 2,
    height: 1,
    close: () => {
      options.tracker.closed++
    },
  }))
  const ctx =
    options.context !== undefined
      ? options.context
      : {
          drawImage: () => {
            if (options.drawThrows) {
              throw new Error('draw exploded')
            }
          },
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          }),
        }
  patch(
    globalRef,
    'OffscreenCanvas',
    class {
      getContext(): unknown {
        return ctx
      }
    },
  )
}

/** A DOM whose Image fires load or error, and whose canvas is configurable. */
function installDomPath(options: {
  fate: 'load' | 'error'
  context?: unknown
  getImageDataThrows?: boolean
  srcThrows?: boolean
}): void {
  const ctx =
    options.context !== undefined
      ? options.context
      : {
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            if (options.getImageDataThrows) {
              throw new Error('readback exploded')
            }
            return {
              width: w,
              height: h,
              data: new Uint8ClampedArray(w * h * 4),
            }
          },
        }
  patch(globalRef, 'document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ctx,
    }),
  })
  patch(
    globalRef,
    'Image',
    class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 3
      height = 2
      set src(_value: string) {
        if (options.srcThrows) throw new Error('source assignment exploded')
        queueMicrotask(() => {
          if (options.fate === 'load') {
            this.onload?.()
          } else {
            this.onerror?.()
          }
        })
      }
    },
  )
}

/** Header bytes only: the size is all imageSize reads. */
function header(bytes: number[], size: number): ArrayBuffer {
  const b = new Uint8Array(size)
  b.set(bytes)
  return b.buffer
}

function pngHeader(width: number, height: number): ArrayBuffer {
  const buffer = header([0x89, 0x50, 0x4e, 0x47], 24)
  const v = new DataView(buffer)
  v.setUint32(16, width)
  v.setUint32(20, height)
  return buffer
}

const BUFFER = pngHeader(2, 1)

describe('decodeImageRGBA', () => {
  test('decodes via createImageBitmap + OffscreenCanvas and closes the bitmap', async () => {
    const tracker = { closed: 0 }
    installBitmapPath({ tracker })
    const decoded = await decodeImageRGBA(BUFFER)
    expect(decoded.width).toBe(2)
    expect(decoded.height).toBe(1)
    expect(decoded.data).toHaveLength(2 * 1 * 4)
    expect(tracker.closed).toBe(1)
  })

  test('createImageBitmap without OffscreenCanvas falls back to the DOM path', async () => {
    patch(globalRef, 'createImageBitmap', async () => {
      throw new Error('the bitmap path must not be taken')
    })
    patch(globalRef, 'OffscreenCanvas', undefined)
    installDomPath({ fate: 'load' })
    const urls = trackObjectUrls()
    const decoded = await decodeImageRGBA(BUFFER)
    expect(decoded.width).toBe(3)
    expect(decoded.height).toBe(2)
    expect(urls.revoked).toEqual(urls.created)
  })

  test('bitmap path with no 2D context rejects and still closes the bitmap', async () => {
    const tracker = { closed: 0 }
    installBitmapPath({ tracker, context: null })
    await expect(decodeImageRGBA(BUFFER)).rejects.toThrow(
      'Unable to create 2D context',
    )
    expect(tracker.closed).toBe(1)
  })

  test('a throwing canvas operation rejects and still closes the bitmap', async () => {
    const tracker = { closed: 0 }
    installBitmapPath({ tracker, drawThrows: true })
    await expect(decodeImageRGBA(BUFFER)).rejects.toThrow('draw exploded')
    expect(tracker.closed).toBe(1)
  })

  test('DOM path success revokes exactly the URL it created', async () => {
    installDomPath({ fate: 'load' })
    const urls = trackObjectUrls()
    const decoded = await decodeImageRGBA(BUFFER)
    expect(decoded.width).toBe(3)
    expect(urls.created).toHaveLength(1)
    expect(urls.revoked).toEqual(urls.created)
  })

  test('DOM path decode failure rejects and revokes the URL', async () => {
    installDomPath({ fate: 'error' })
    const urls = trackObjectUrls()
    await expect(decodeImageRGBA(BUFFER)).rejects.toThrow(
      'Failed to load image',
    )
    expect(urls.revoked).toEqual(urls.created)
  })

  test('DOM path with no 2D context rejects and revokes the URL', async () => {
    installDomPath({ fate: 'load', context: null })
    const urls = trackObjectUrls()
    await expect(decodeImageRGBA(BUFFER)).rejects.toThrow(
      'Unable to create 2D context',
    )
    expect(urls.revoked).toEqual(urls.created)
  })

  test('DOM path readback failure rejects and revokes the URL', async () => {
    installDomPath({ fate: 'load', getImageDataThrows: true })
    const urls = trackObjectUrls()
    await expect(decodeImageRGBA(BUFFER)).rejects.toThrow('readback exploded')
    expect(urls.revoked).toEqual(urls.created)
  })

  test('a synchronous source assignment failure still revokes the URL', async () => {
    installDomPath({ fate: 'load', srcThrows: true })
    const urls = trackObjectUrls()
    await expect(decodeImageRGBA(BUFFER)).rejects.toThrow(
      'source assignment exploded',
    )
    expect(urls.revoked).toEqual(urls.created)
  })

  test('throws when no decoding path exists at all', async () => {
    patch(globalRef, 'createImageBitmap', undefined)
    patch(globalRef, 'OffscreenCanvas', undefined)
    patch(globalRef, 'document', undefined)
    await expect(decodeImageRGBA(BUFFER)).rejects.toThrow(
      'No image decoding path available',
    )
  })
})

describe('imageSize', () => {
  test('reads PNG IHDR', () => {
    expect(imageSize(pngHeader(2048, 1024))).toEqual({
      width: 2048,
      height: 1024,
    })
  })

  test('reads the GIF logical screen', () => {
    const buffer = header([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 10)
    const v = new DataView(buffer)
    v.setUint16(6, 300, true)
    v.setUint16(8, 200, true)
    expect(imageSize(buffer)).toEqual({ width: 300, height: 200 })
  })

  test('grows the GIF size to a first frame past the logical screen', () => {
    // 1x1 screen with a 2-color table, a graphic control extension, then a
    // frame at (10, 20) of 65535x40000.
    const b = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0]
    b.push(0, 0, 0, 255, 255, 255)
    b.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0)
    b.push(0x2c, 10, 0, 20, 0, 0xff, 0xff, 0x40, 0x9c, 0)
    expect(imageSize(new Uint8Array(b).buffer)).toEqual({
      width: 65545,
      height: 40020,
    })
  })

  test('refuses a JPEG whose height is deferred to a DNL marker', () => {
    // SOI, SOF0 with height 0, width 800
    const buffer = header(
      [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x03, 0x20],
      14,
    )
    expect(() => imageSize(buffer)).toThrow('Unrecognized')
  })

  test('reads a BMP info header, top-down height made positive', () => {
    const buffer = header([0x42, 0x4d], 26)
    const v = new DataView(buffer)
    v.setUint32(14, 40, true)
    v.setInt32(18, 640, true)
    v.setInt32(22, -480, true)
    expect(imageSize(buffer)).toEqual({ width: 640, height: 480 })
  })

  test('reads a BMP core header', () => {
    const buffer = header([0x42, 0x4d], 26)
    const v = new DataView(buffer)
    v.setUint32(14, 12, true)
    v.setUint16(18, 64, true)
    v.setUint16(20, 32, true)
    expect(imageSize(buffer)).toEqual({ width: 64, height: 32 })
  })

  test('skips JPEG segments to the SOF', () => {
    // SOI, APP0 (length 4), SOF2: length, precision, height 600, width 800
    const buffer = header(
      [
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x11,
        0x08, 0x02, 0x58, 0x03, 0x20,
      ],
      20,
    )
    expect(imageSize(buffer)).toEqual({ width: 800, height: 600 })
  })

  test('skips 0xff fill bytes before a JPEG marker', () => {
    // SOI, fill, APP0 (length 4), fill x2, SOF0: height 600, width 800
    const buffer = header(
      [
        0xff, 0xd8, 0xff, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xff, 0xff,
        0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20,
      ],
      24,
    )
    expect(imageSize(buffer)).toEqual({ width: 800, height: 600 })
  })

  test('throws for an unrecognized or truncated header', () => {
    expect(() => imageSize(new Uint8Array([1, 2, 3]).buffer)).toThrow(
      'Unrecognized',
    )
    expect(() =>
      imageSize(header([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04], 8)),
    ).toThrow('Unrecognized')
  })
})

test('decodeImageRGBA refuses an oversized image before decoding', async () => {
  patch(globalRef, 'createImageBitmap', async () => {
    throw new Error('must not decode')
  })
  patch(globalRef, 'OffscreenCanvas', class {})
  await expect(decodeImageRGBA(pngHeader(20000, 20000))).rejects.toThrow(
    '20000x20000, larger than 8192',
  )
})
