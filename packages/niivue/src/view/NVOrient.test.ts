import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import { markVolumeDataChanged } from '@/volume/dataVersion'
import { computeModulationData } from '@/volume/modulation'
import { prepareRGBAData, rgbaTextureKey } from './NVOrient'

const DT_RGB24 = 128
const DT_RGBA32 = 2304

// A 2x2x1 color volume already in RAS order. Only the fields
// prepareRGBAData / rgbaTextureKey read matter, so a structural cast keeps the
// fixture small instead of building a full NVImage.
function makeVol(overrides: Record<string, unknown> = {}): NVImage {
  return {
    hdr: { datatypeCode: DT_RGBA32 },
    img: Uint8Array.from([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
    ]),
    dims: [3, 2, 2, 1],
    dimsRAS: [3, 2, 2, 1],
    img2RASstart: [0, 0, 0],
    img2RASstep: [1, 2, 4],
    _modulationData: null,
    ...overrides,
  } as unknown as NVImage
}

describe('rgbaTextureKey', () => {
  test('is stable while nothing changes', () => {
    const vol = makeVol()
    expect(rgbaTextureKey(vol)).toBe(rgbaTextureKey(vol))
  })

  test('an in-place edit reported through the data version changes it', () => {
    const vol = makeVol()
    const before = rgbaTextureKey(vol)
    vol.img?.fill(0)
    expect(rgbaTextureKey(vol)).toBe(before)
    markVolumeDataChanged(vol)
    expect(rgbaTextureKey(vol)).not.toBe(before)
  })

  test('a same-length replacement buffer changes it', () => {
    const vol = makeVol()
    const before = rgbaTextureKey(vol)
    vol.img = Uint8Array.from(vol.img ?? [])
    expect(rgbaTextureKey(vol)).not.toBe(before)
  })

  test.each([
    ['datatype', { hdr: { datatypeCode: DT_RGB24 } }],
    ['native dims', { dims: [3, 4, 1, 1] }],
    ['RAS dims', { dimsRAS: [3, 1, 2, 2] }],
    ['RAS start', { img2RASstart: [1, 0, 0] }],
    ['RAS step', { img2RASstep: [-1, 2, 4] }],
  ])('a changed %s changes it', (_field, overrides) => {
    // Same img for both, so only the overridden field differs.
    const img = makeVol().img
    expect(rgbaTextureKey(makeVol({ img, ...overrides }))).not.toBe(
      rgbaTextureKey(makeVol({ img })),
    )
  })

  test('a new 4D frame changes it', () => {
    // setFrame4D on a 4D color volume must not reuse the old frame's upload.
    const img = makeVol().img
    expect(rgbaTextureKey(makeVol({ img, frame4D: 1 }))).not.toBe(
      rgbaTextureKey(makeVol({ img, frame4D: 0 })),
    )
  })

  test('a new modulation array changes it', () => {
    const vol = makeVol()
    const plain = rgbaTextureKey(vol)
    vol._modulationData = new Float32Array(4).fill(1)
    const modulated = rgbaTextureKey(vol)
    expect(modulated).not.toBe(plain)
    expect(rgbaTextureKey(vol)).toBe(modulated)
    vol._modulationData = new Float32Array(4).fill(1)
    expect(rgbaTextureKey(vol)).not.toBe(modulated)
  })
})

describe('rgbaTextureKey with a modulator', () => {
  test('stays put across GPU updates while the modulator is unchanged', () => {
    // computeModulationData runs on every GPU update; a modulated RGBA
    // background must not re-upload each time.
    const target = makeVol({ id: 'rgba', modulationImage: 'mod' })
    const modulator = {
      id: 'mod',
      hdr: { datatypeCode: 16, scl_slope: 1, scl_inter: 0 },
      img: new Float32Array([0, 1, 2, 3]),
      nVox3D: 4,
      dimsRAS: [3, 2, 2, 1],
      img2RASstart: [0, 0, 0],
      img2RASstep: [1, 2, 4],
      calMin: 0,
      calMax: 3,
    } as unknown as NVImage
    computeModulationData([target, modulator])
    const before = rgbaTextureKey(target)
    computeModulationData([target, modulator])
    expect(rgbaTextureKey(target)).toBe(before)
    markVolumeDataChanged(modulator)
    computeModulationData([target, modulator])
    expect(rgbaTextureKey(target)).not.toBe(before)
  })
})

describe('prepareRGBAData', () => {
  test('modulating an RAS-ordered RGBA volume leaves its img untouched', () => {
    // The RAS RGBA case passes img's own bytes through, so scaling them in
    // place would darken the volume again on every re-upload.
    const vol = makeVol({ _modulationData: new Float32Array(4).fill(0.5) })
    const original = Uint8Array.from(vol.img ?? [])
    const first = prepareRGBAData(vol).rgbaData
    expect(first[0]).toBe(5)
    expect(Array.from(vol.img ?? [])).toEqual(Array.from(original))
    expect(prepareRGBAData(vol).rgbaData[0]).toBe(5)
  })

  test.each([
    ['RGBA', DT_RGBA32, 4],
    ['RGB', DT_RGB24, 3],
  ])('a 4D %s volume reads only the selected frame', (_name, dt, bpv) => {
    // Two frames of 2x2x1 voxels: every byte of frame 0 is 1, of frame 1 is 2.
    const frameBytes = 4 * bpv
    const img = new Uint8Array(2 * frameBytes)
    img.fill(1, 0, frameBytes)
    img.fill(2, frameBytes)
    const vol = makeVol({ img, hdr: { datatypeCode: dt }, nFrame4D: 2 })
    expect(prepareRGBAData(vol).rgbaData[0]).toBe(1)
    vol.frame4D = 1
    const { rgbaData } = prepareRGBAData(vol)
    expect(rgbaData.length).toBe(16)
    expect(Array.from(rgbaData.subarray(0, 3))).toEqual([2, 2, 2])
  })
})
