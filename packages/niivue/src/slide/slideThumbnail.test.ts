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
})
