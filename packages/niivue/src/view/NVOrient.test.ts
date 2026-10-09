import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import { markVolumeDataChanged } from '@/volume/dataVersion'
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
})
