import { describe, expect, it } from 'bun:test'
import type {
  NVChannel,
  NVSlideChannelInfo,
  NVSlideLevelManifest,
  TileBitmap,
} from './NVSlide'
import { composeThumbnail } from './slideThumbnail'

// Bun has no OffscreenCanvas: record the smoothing each drawImage ran with.
const smoothing: boolean[] = []
const Real = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas
const RealImageData = (globalThis as { ImageData?: unknown }).ImageData
class FakeCanvas {
  getContext() {
    const ctx = {
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'low',
      drawImage: () => smoothing.push(ctx.imageSmoothingEnabled),
    }
    return ctx
  }
  transferToImageBitmap() {
    return {}
  }
}

const level = {
  width: 8,
  height: 8,
  tiles: [{ x: 0, y: 0 }],
} as unknown as NVSlideLevelManifest
const entries = [{ bitmap: { width: 8, height: 8 } } as unknown as TileBitmap]
const ch = (visible: boolean) => ({ visible }) as NVChannel
const LABEL: NVSlideChannelInfo = { name: 'l', active: true, kind: 'label' }
const I: NVSlideChannelInfo = { name: 'i', active: true }

describe('composeThumbnail', () => {
  it('draws label-only channels without smoothing, others smoothed', () => {
    const smoothed = (channels: NVChannel[], info?: NVSlideChannelInfo[]) => {
      smoothing.length = 0
      composeThumbnail(level, entries, 4, 8, 8, channels, 'max', info)
      return smoothing[0]
    }
    Object.assign(globalThis, { OffscreenCanvas: FakeCanvas })
    try {
      expect(smoothed([ch(true)], [LABEL])).toBe(false)
      expect(smoothed([ch(false), ch(true)], [I, LABEL])).toBe(false)
      expect(smoothed([ch(true), ch(true)], [I, LABEL])).toBe(true)
      expect(smoothed([ch(true)])).toBe(true)
      expect(smoothed([])).toBe(true)
    } finally {
      Object.assign(globalThis, { OffscreenCanvas: Real })
    }
  })

  it('windows bitmap tiles beside a fused tile', () => {
    // 1:1 pixel canvases: drawImage copies, image data round-trips.
    type Px = { width: number; height: number; data: Uint8ClampedArray }
    class PixelCanvas implements Px {
      data: Uint8ClampedArray
      constructor(
        public width: number,
        public height: number,
      ) {
        this.data = new Uint8ClampedArray(width * height * 4)
      }
      getContext() {
        const c = this
        return {
          canvas: c,
          clearRect: () => c.data.fill(0),
          drawImage: (
            src: Px,
            sx = 0,
            sy = 0,
            w = src.width,
            h = src.height,
            dx = 0,
            dy = 0,
          ) => {
            for (let y = 0; y < h; y++)
              for (let x = 0; x < w; x++)
                for (let k = 0; k < 4; k++)
                  c.data[((dy + y) * c.width + dx + x) * 4 + k] = src.data[
                    ((sy + y) * src.width + sx + x) * 4 + k
                  ] as number
          },
          getImageData: (x: number, y: number, w: number, h: number) => {
            const out = new PixelCanvas(w, h)
            out.getContext().drawImage(c, x, y, w, h)
            return out
          },
          putImageData: (img: Px, dx: number, dy: number) =>
            c.getContext().drawImage(img, 0, 0, img.width, img.height, dx, dy),
        }
      }
      transferToImageBitmap() {
        return this
      }
    }
    const bitmap = new PixelCanvas(1, 1)
    bitmap.data.set([100, 100, 100, 255])
    const fused = {
      samples: {
        samples: new Uint8Array(1),
        width: 1,
        height: 1,
        bitsStored: 8,
      },
      level: {},
    }
    const mixed = {
      width: 2,
      height: 1,
      tiles: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
    } as unknown as NVSlideLevelManifest
    // Red scale 2.55, offset 0: 100 -> 255; green and blue identity.
    const win = new Float32Array([2.55, 1, 1, 0, 0, 0, 0, 0])
    Object.assign(globalThis, {
      OffscreenCanvas: PixelCanvas,
      ImageData: class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number,
        ) {}
      },
    })
    try {
      const out = composeThumbnail(
        mixed,
        [{ bitmap } as unknown as TileBitmap, fused as unknown as TileBitmap],
        2,
        1,
        1,
        [],
        'max',
        undefined,
        null,
        null,
        win,
      ) as unknown as PixelCanvas
      expect([...out.data.slice(0, 4)]).toEqual([255, 100, 100, 255])
    } finally {
      Object.assign(globalThis, {
        OffscreenCanvas: Real,
        ImageData: RealImageData,
      })
    }
  })
})
