import { describe, expect, it } from 'bun:test'
import { setSlideWindow, windowSlideDrag } from './wsiSlideView'

describe('windowSlideDrag', () => {
  const slide = (channelInfo?: unknown, bitsStored = 8) => {
    const sets: Array<[number, number, number]> = []
    const n = channelInfo ? 1 : 3
    return {
      sets,
      channels: Array.from({ length: n }, () => ({
        calMin: Number.NaN,
        calMax: Number.NaN,
      })),
      manifest: { channelInfo, levels: [{ codec: 'jpeg', bitsStored }] },
      setChannel(c: number, w: { calMin: number; calMax: number }) {
        sets.push([c, w.calMin, w.calMax])
      },
    }
  }
  it('windows all three channels of an RGB slide at cornerstone gain', () => {
    // 12-bit source: RGB still decodes to 8 bits, so the 8-bit range and gain.
    const s = slide(undefined, 12)
    // 8-bit: 255/1024 per px. Right 40 px widens by ~10, down 40 raises centre ~10.
    windowSlideDrag(s as never, 0, 40, 40)
    const k = 255 / 1024
    expect(s.sets.map(([c]) => c)).toEqual([0, 1, 2])
    const [, lo, hi] = s.sets[0] as [number, number, number]
    expect(hi - lo).toBeCloseTo(255 + 40 * k)
    expect((lo + hi) / 2).toBeCloseTo(127.5 + 40 * k)
  })
  it('windows only the given channel of a channelInfo slide', () => {
    const s = slide([{ name: 'dapi' }])
    // -1 is the controller's default windowChannel: the first channel.
    windowSlideDrag(s as never, -1, 1, 0)
    expect(s.sets.map(([c]) => c)).toEqual([0])
  })
  it('a preset window sets all three channels of an RGB slide', () => {
    const s = slide()
    setSlideWindow(s as never, 50, 150)
    expect(s.sets).toEqual([
      [0, 50, 150],
      [1, 50, 150],
      [2, 50, 150],
    ])
  })
  it('a preset window sets channel 0 of a channelInfo slide', () => {
    const s = slide([{ name: 'dapi' }])
    setSlideWindow(s as never, 50, 150)
    expect(s.sets).toEqual([[0, 50, 150]])
  })
})
