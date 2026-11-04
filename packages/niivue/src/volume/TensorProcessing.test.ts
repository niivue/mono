import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import { loadImgV1 } from './TensorProcessing'

/** One voxel whose direction points along +x, as a tensor reader keeps it. */
function vectorVolume(stored: boolean): NVImage {
  const v1 = new Float32Array([2, 0, 0])
  return {
    hdr: {
      dims: [4, 1, 1, 1, 3, 1, 1, 1],
      scl_slope: 1,
      scl_inter: 0,
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    },
    img: v1.slice(),
    v1: stored ? v1 : undefined,
    nVox3D: 1,
    nFrame4D: 3,
    frame4D: 2,
  } as unknown as NVImage
}

/** Whether the converted voxel's x component points the positive way. */
const xPositive = (vol: NVImage) => ((vol.img as Uint8Array)[3] & 1) === 1

describe('loadImgV1', () => {
  test('a flip acts on one conversion, so a stored V1 is flipped afresh each time', () => {
    const vol = vectorVolume(true)
    expect(loadImgV1(vol, true)).toBe(true)
    expect(xPositive(vol)).toBe(false)
    expect(loadImgV1(vol, true)).toBe(true)
    expect(xPositive(vol)).toBe(false)
    expect(loadImgV1(vol)).toBe(true)
    expect(xPositive(vol)).toBe(true)
  })

  test('the converted image has one frame, and shows it', () => {
    const vol = vectorVolume(false)
    expect(loadImgV1(vol)).toBe(true)
    expect(vol.nFrame4D).toBe(1)
    expect(vol.frame4D).toBe(0)
  })
})
