import { afterEach, describe, expect, test } from 'bun:test'
import { decodeImageRGBA } from './imageDecode'

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

const BUFFER = new Uint8Array([1, 2, 3]).buffer

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
      'Failed to decode image',
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
