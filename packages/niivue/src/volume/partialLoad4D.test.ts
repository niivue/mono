import { describe, expect, test } from 'bun:test'
import { framesInImage, resolveFrame4DCount } from './utils'

// Partial 4D load (`limitFrames4D`) caps how many time frames a 4D volume keeps
// in memory. The streaming loaders decide how much data to fetch; `nii2volume`
// then reconciles the requested cap against the header's declared frame count
// and the frames actually present in the loaded buffer. That reconciliation is
// the pure `framesInImage` + `resolveFrame4DCount` pair exercised here.

describe('framesInImage', () => {
  const NVOX3D = 8
  const BYTES_PER_VOXEL = 4 // float32

  test('countsWholeFramesInABuffer', () => {
    expect(
      framesInImage(NVOX3D * BYTES_PER_VOXEL * 4, NVOX3D, BYTES_PER_VOXEL),
    ).toBe(4)
  })

  test('floorsAPartialTrailingFrame', () => {
    // A buffer with 2.5 frames' worth of bytes only fully contains 2 frames.
    const bytes = Math.floor(NVOX3D * BYTES_PER_VOXEL * 2.5)
    expect(framesInImage(bytes, NVOX3D, BYTES_PER_VOXEL)).toBe(2)
  })

  test('returnsAtLeastOneFrame', () => {
    expect(framesInImage(0, NVOX3D, BYTES_PER_VOXEL)).toBe(1)
    expect(framesInImage(1000, 0, BYTES_PER_VOXEL)).toBe(1)
  })
})

describe('resolveFrame4DCount', () => {
  // Signature: resolveFrame4DCount(limitFrames4D, framesInImg, nTotalFrame4D)

  test('loadsAllFramesWhenLimitIsInfinity', () => {
    expect(resolveFrame4DCount(Infinity, 4, 4)).toBe(4)
  })

  test('capsToTheRequestedLimit', () => {
    expect(resolveFrame4DCount(2, 4, 4)).toBe(2)
  })

  test('floorsAFractionalLimit', () => {
    // 1.5 must not leak a non-integer nFrame4D (which would mis-align the byte
    // truncation and the 4D graph / setFrame4D indexing).
    expect(resolveFrame4DCount(1.5, 4, 4)).toBe(1)
  })

  test('clampsALimitBelowOneToASingleFrame', () => {
    expect(resolveFrame4DCount(0, 4, 4)).toBe(1)
    expect(resolveFrame4DCount(-3, 4, 4)).toBe(1)
  })

  test('clampsALimitLargerThanTheDataToTheTotalFrameCount', () => {
    expect(resolveFrame4DCount(10, 3, 3)).toBe(3)
  })

  test('clampsToFramesActuallyPresentWhenBufferHoldsFewerThanTheHeaderClaims', () => {
    // Recovery path: a >2 GiB volume was capped by the loader, so the buffer
    // holds fewer frames (2) than the header declares (4). Even with no explicit
    // limit, nFrame4D must not claim more frames than the buffer contains.
    expect(resolveFrame4DCount(Infinity, 2, 4)).toBe(2)
  })

  test('appliesTheTightestOfAllThreeConstraints', () => {
    // request 3, but only 2 frames on hand, header says 5 -> 2 wins.
    expect(resolveFrame4DCount(3, 2, 5)).toBe(2)
    // request 3, 5 frames on hand, header says 4 -> 3 (the request) wins.
    expect(resolveFrame4DCount(3, 5, 4)).toBe(3)
  })
})
