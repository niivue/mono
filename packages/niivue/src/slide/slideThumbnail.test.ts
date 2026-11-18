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

  it('windows bitmap tiles beside a fused tile after scaling, as the GPU', () => {
    // Pixel canvases: drawImage box-filters to the destination size.
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
        return {
          canvas: this,
          drawImage: (
            src: Px,
            sx = 0,
            sy = 0,
            w = src.width,
            h = src.height,
            dx = 0,
            dy = 0,
            dw = w,
            dh = h,
          ) => {
            for (let y = 0; y < dh; y++)
              for (let x = 0; x < dw; x++) {
                const [x0, x1] = [(x * w) / dw, ((x + 1) * w) / dw]
                const [y0, y1] = [(y * h) / dh, ((y + 1) * h) / dh]
                for (let k = 0; k < 4; k++) {
                  let sum = 0
                  for (let v = y0; v < y1; v++)
                    for (let u = x0; u < x1; u++)
                      sum += src.data[
                        ((sy + v) * src.width + sx + u) * 4 + k
                      ] as number
                  this.data[((dy + y) * this.width + dx + x) * 4 + k] =
                    sum / ((x1 - x0) * (y1 - y0))
                }
              }
          },
          getImageData: (x: number, y: number, w: number, h: number) => {
            const out = new PixelCanvas(w, h)
            out.getContext().drawImage(this, x, y, w, h)
            return out
          },
          putImageData: (img: Px, dx: number, dy: number) =>
            this.getContext().drawImage(
              img,
              0,
              0,
              img.width,
              img.height,
              dx,
              dy,
            ),
        }
      }
      transferToImageBitmap() {
        return this
      }
    }
    // A bitmap tile beside a fused tile, scaled by 1 / n.
    const compose = (bitmapRow: number[], n: number, win: Float32Array) => {
      const bitmap = new PixelCanvas(n, 1)
      bitmap.data.set(bitmapRow)
      const fused = {
        samples: {
          samples: new Uint8Array(n),
          width: n,
          height: 1,
          bitsStored: 8,
        },
        level: {},
      }
      const mixed = {
        width: 2 * n,
        height: 1,
        tiles: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      } as unknown as NVSlideLevelManifest
      const out = composeThumbnail(
        mixed,
        [{ bitmap } as unknown as TileBitmap, fused as unknown as TileBitmap],
        2,
        n,
        1,
        [],
        'max',
        undefined,
        null,
        null,
        win,
      ) as unknown as PixelCanvas
      return [...out.data.slice(0, 4)]
    }
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
      // Red scale 2.55, offset 0: 100 -> 255; green and blue identity.
      const gain = new Float32Array([2.55, 1, 1, 0, 0, 0, 0, 0])
      expect(compose([100, 100, 100, 255], 1, gain)).toEqual([
        255, 100, 100, 255,
      ])
      // Red window 100..200: red 0 and 254 filter to 127, then window to
      // 127 * 2.55 - 255 = 69 (windowing first: 0 and 255 filter to 128).
      const window = new Float32Array([2.55, 1, 1, 0, -1, 0, 0, 0])
      expect(compose([0, 0, 0, 255, 254, 0, 0, 255], 2, window)[0]).toBe(69)
    } finally {
      Object.assign(globalThis, {
        OffscreenCanvas: Real,
        ImageData: RealImageData,
      })
    }
  })
})
