import { describe, expect, spyOn, test } from 'bun:test'

import NiiVue, { NVSlide } from '@/index'

function slide(): NVSlide {
  return new NVSlide({
    id: 's',
    name: 's',
    width: 8,
    height: 8,
    dtype: 'uint8',
    channels: 'planar',
    channelInfo: [
      { name: 'a', rgb: [255, 0, 0], active: true },
      { name: 'b', active: true },
    ],
    levels: [
      {
        index: 0,
        width: 8,
        height: 8,
        downsample: 1,
        tileWidth: 8,
        tileHeight: 8,
        columns: 1,
        rows: 1,
        tiles: [],
      },
    ],
  })
}

describe('slide plane channels', () => {
  test('read null and ignore sets without a plane', () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    expect(nv.slideChannels).toBeNull()
    expect(nv.slideChannelBlend).toBeNull()
    nv.setSlideChannel(0, { visible: false })
    nv.setSlideChannelBlend('additive')
    expect(nv.slideChannels).toBeNull()
  })

  test("set and read the plane's channels and blend, redrawing", () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    const s = slide()
    nv.setSlidePlane(s, {
      pixelToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    })
    const draws = spyOn(nv, 'drawScene')
    nv.setSlideChannel(1, { colormap: 'green', calMin: 2, calMax: 9 })
    nv.setSlideChannelBlend('additive')
    expect(nv.slideChannels?.[1]).toEqual({
      name: 'b',
      colormap: 'green',
      calMin: 2,
      calMax: 9,
      visible: true,
    })
    expect(nv.slideChannelBlend).toBe('additive')
    expect(s.channelBlend).toBe('additive')
    expect(draws).toHaveBeenCalled()
    expect(() => nv.setSlideChannel(5, { visible: true })).toThrow(RangeError)
    nv.clearSlidePlane()
    s.dispose()
  })
})
