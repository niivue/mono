import { expect, test } from 'bun:test'
import NiiVue, { type ChunkedVolumeSource, NiiDataType } from '@/index'
import { channelVolumeFile } from '@/volume/channelVolumeFile'

// M14-02: volumeHistogram and recalculateCalMinMax percentiles.

/** 1..100 once each, as a 100-voxel u8 volume. */
async function ramp(): Promise<NiiVue> {
  const nv = new NiiVue({ backend: 'webgl2' })
  const img = Uint8Array.from({ length: 100 }, (_, i) => i + 1)
  await nv.loadVolumes([
    {
      url: channelVolumeFile(
        [10, 10, 1],
        [1, 1, 1],
        NiiDataType.DT_UINT8,
        img,
        'ramp',
      ),
    },
  ])
  return nv
}

test('a whole volume histogram counts every finite voxel, cached per generation', async () => {
  const nv = await ramp()
  const h = nv.volumeHistogram(0, { bins: 4 })
  expect(h?.coverage).toBe('volume')
  expect([h?.min, h?.max, h?.voxels]).toEqual([1, 100, 100])
  expect(Array.from(h?.counts ?? [])).toEqual([25, 25, 25, 25])
  const again = nv.volumeHistogram(0, { bins: 4 })
  expect(again?.generation).toBe(h?.generation)
  // Copies: editing one cannot change the cached counts.
  if (again) again.counts[0] = 99
  expect(nv.volumeHistogram(0, { bins: 4 })?.counts[0]).toBe(25)
  await nv.updateVolumeData(0, new Uint8Array(100).fill(9))
  const next = nv.volumeHistogram(0, { bins: 4 })
  expect(next?.generation).not.toBe(h?.generation)
  expect(Array.from(next?.counts ?? [])).toEqual([100, 0, 0, 0])
})

test('recalculateCalMinMax takes percentiles; the default is the 2-98 window', async () => {
  const nv = await ramp()
  await nv.recalculateCalMinMax(0)
  const dflt = [nv.volumes[0].calMin, nv.volumes[0].calMax]
  await nv.recalculateCalMinMax(0, undefined, [2, 98])
  expect([nv.volumes[0].calMin, nv.volumes[0].calMax]).toEqual(dflt)
  await nv.recalculateCalMinMax(0, undefined, [0, 100])
  expect([nv.volumes[0].calMin, nv.volumes[0].calMax]).toEqual([1, 100])
  for (const bad of [
    [50, 10],
    [-1, 50],
    [10, 101],
    [Number.NaN, 5],
  ])
    await expect(
      nv.recalculateCalMinMax(0, undefined, bad as [number, number]),
    ).rejects.toThrow(RangeError)
  await nv.recalculateCalMinMax(0, undefined, [10, 50])
  const [lo, hi] = [nv.volumes[0].calMin ?? 0, nv.volumes[0].calMax ?? 0]
  expect(Math.abs(lo - 10)).toBeLessThan(1.5)
  expect(Math.abs(hi - 50)).toBeLessThan(1.5)
})

test('a streamed volume histogram covers its coarsest level and says so', async () => {
  const src: ChunkedVolumeSource = {
    levels: [
      { level: 0, shape: [8, 8, 8], spacing: [1, 1, 1] },
      { level: 1, shape: [4, 4, 4], spacing: [2, 2, 2] },
    ],
    datatypeCode: NiiDataType.DT_UINT8,
    async fetchChunk({ texDims, levelIndex }) {
      const n = texDims[0] * texDims[1] * texDims[2]
      return Uint8Array.from({ length: n }, (_, i) => (levelIndex ? i % 4 : 7))
    },
  }
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadChunkedVolume(src)
  const h = nv.volumeHistogram(0, { bins: 4 })
  expect(h).toMatchObject({ coverage: 'level', level: 1, frame: 0, voxels: 64 })
  expect(Array.from(h?.counts ?? [])).toEqual([16, 16, 16, 16])
  await nv.recalculateCalMinMax(0, undefined, [0, 100])
  expect([nv.volumes[0].calMin, nv.volumes[0].calMax]).toEqual([0, 3])
})

test('volumeHistogram rejects a non-integer frame or bins', async () => {
  const nv = await ramp()
  for (const bad of [
    { bins: 0 },
    { bins: 2.5 },
    { bins: Number.NaN },
    { frame: 1 },
    { frame: 0.5 },
  ])
    expect(() => nv.volumeHistogram(0, bad)).toThrow(RangeError)
})

test('a negative slope keeps the calibrated half-open bins', async () => {
  const { frameHistogram } = await import('@/volume/utils')
  const vol = {
    img: Uint8Array.from([0, 1, 2, 3]),
    nVox3D: 4,
    hdr: { datatypeCode: 2, scl_slope: -1, scl_inter: 0 },
  } as unknown as Parameters<typeof frameHistogram>[0]
  // Calibrated -3, -2, -1, 0 into [-3,-2), [-2,-1), [-1,0].
  const h = frameHistogram(vol, 0, 3)
  expect([h?.min, h?.max]).toEqual([-3, 0])
  expect(Array.from(h?.counts ?? [])).toEqual([1, 1, 2])
})

test('a lazy volume counts the frame it shows when asked for it by number', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const img = Uint8Array.from({ length: 100 }, (_, i) => i + 1)
  await nv.loadVolumes([
    {
      url: channelVolumeFile(
        [10, 10, 1],
        [1, 1, 1],
        NiiDataType.DT_UINT8,
        img,
        'lazy',
      ),
      frameSource: {
        count: 5,
        frame: 0,
        group: {},
        load: async (t) => new Uint8Array(100).fill(10 + t),
      },
    },
  ])
  await nv.setFrame4D('lazy.nii', 3)
  const h = nv.volumeHistogram(0, { bins: 4, frame: 3 })
  expect(h?.frame).toBe(3)
  expect(h?.voxels).toBe(100)
  expect(() => nv.volumeHistogram(0, { frame: 2 })).toThrow(
    'holds only frame 3',
  )
})
