import { describe, expect, it } from 'bun:test'
import { keepOneRuler, windowSlideDrag } from './wsiSlideView'

describe('keepOneRuler', () => {
  it('keeps only the last finished ruler', () => {
    const ctl = { measurements: ['a', 'b', 'c'], activeMeasurement: null }
    keepOneRuler(ctl)
    expect(ctl.measurements).toEqual(['c'])
  })

  it('clears the kept ruler while a new one is dragged', () => {
    const ctl = { measurements: ['a'], activeMeasurement: {} }
    keepOneRuler(ctl)
    expect(ctl.measurements).toEqual([])
  })

  it('leaves no rulers as none', () => {
    const ctl = { measurements: [], activeMeasurement: null }
    keepOneRuler(ctl)
    expect(ctl.measurements).toEqual([])
  })
})

describe('windowSlideDrag', () => {
  const slide = (channelInfo?: unknown) => {
    const sets: Array<[number, number, number]> = []
    const n = channelInfo ? 1 : 3
    return {
      sets,
      channels: Array.from({ length: n }, () => ({
        calMin: Number.NaN,
        calMax: Number.NaN,
      })),
      manifest: { channelInfo, levels: [{ codec: 'jpeg', bitsStored: 8 }] },
      setChannel(c: number, w: { calMin: number; calMax: number }) {
        sets.push([c, w.calMin, w.calMax])
      },
    }
  }
  it('windows all three channels of an RGB slide at cornerstone gain', () => {
    const s = slide()
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
    windowSlideDrag(s as never, 0, 1, 0)
    expect(s.sets.map(([c]) => c)).toEqual([0])
  })
})
