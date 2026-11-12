import { expect, test } from 'bun:test'
import { lookupColorMap } from '@/cmap/NVCmaps'
import { CHANNEL_COLORMAPS } from './channelColormaps'

test('every channel ramp starts at black and ends at its hue', () => {
  for (const { name, rgb } of CHANNEL_COLORMAPS) {
    const cmap = lookupColorMap(name)
    expect(cmap, name).not.toBeNull()
    if (!cmap) continue
    const last = cmap.R.length - 1
    expect([cmap.R[0], cmap.G[0], cmap.B[0]], name).toEqual([0, 0, 0])
    expect([cmap.R[last], cmap.G[last], cmap.B[last]], name).toEqual([...rgb])
  }
})
