import { expect, test } from 'bun:test'
import NiiVue, { type ChunkedVolumeSource } from '@/index'
import { devImageUrl } from '@/testing/headless'

// CT scans are calibrated in Hounsfield units, so each CT colormap is designed
// for one window (ct_kidneys 114..302, ct_bones 180..600) stored as min/max in
// its LUT. Setting such a colormap fills any bound not given from that window;
// a given bound wins, NaN means the image's own default, generic colormaps
// (e.g. gray) never change the window, and re-sending the current colormap
// keeps it (#395).

test('CT colormaps apply their Hounsfield window', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([
    {
      url: devImageUrl('volumes/hippo.nii.gz'),
      colormap: 'ct_bones',
      calMax: Number.NaN,
    },
  ])
  const v = nv.volumes[0]
  const win = () => [v.calMin, v.calMax]
  const lo = v.robustMin
  const hi = v.robustMax
  const load = win()
  await nv.setVolume(0, { colormap: 'ct_kidneys' })
  const kidneys = win()
  await nv.setVolume(0, { colormap: 'gray', calMax: 500 })
  const gray = win()
  await nv.setVolume(0, { colormap: 'ct_kidneys', calMin: -1024 })
  const oneBound = win()
  await nv.setVolume(0, { calMin: 0 })
  await nv.setVolume(0, { colormap: 'ct_kidneys' })
  const resent = win()
  await nv.setVolume(0, { calMin: Number.NaN, calMax: Number.NaN })
  const reset = win()

  expect({ load, kidneys, gray, oneBound, resent, reset }).toEqual({
    load: [180, hi],
    kidneys: [114, 302],
    gray: [114, 500],
    oneBound: [-1024, 302],
    resent: [0, 302],
    reset: [lo, hi],
  })
})

test('a streamed volume takes the CT window and auto-windows only a NaN bound', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const N = 32
  const source: ChunkedVolumeSource = {
    datatypeCode: 4,
    levels: [{ level: 0, shape: [N, N, 4], spacing: [1, 1, 1] }],
    fetchChunk: async ({ texOrigin: o, texDims: d }) => {
      const out = new Int16Array(d[0] * d[1] * d[2])
      for (let i = 0; i < out.length; i++) out[i] = (o[0] + (i % d[0])) * 100
      return new Uint8Array(out.buffer)
    },
  }
  // loadChunkedVolume samples the robust range before it resolves, so there
  // is nothing to poll for.
  await nv.loadChunkedVolume(source, {
    colormap: 'ct_bones',
    calMax: Number.NaN,
  })
  const v = nv.volumes[0]
  expect(v.calMin).toBe(180)
  expect(v.calMax).toBe(v.robustMax)
  expect(v.calMax).toBeGreaterThan(600)
})
