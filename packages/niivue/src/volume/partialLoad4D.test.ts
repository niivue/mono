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
  // Each case: [limitFrames4D, framesInImg, nTotalFrame4D, expected nFrame4D]
  test.each<{ name: string; cases: [number, number, number, number][] }>([
    { name: 'loadsAllFramesWhenLimitIsInfinity', cases: [[Infinity, 4, 4, 4]] },
    { name: 'capsToTheRequestedLimit', cases: [[2, 4, 4, 2]] },
    {
      // 1.5 must not leak a non-integer nFrame4D (which would mis-align the
      // byte truncation and the 4D graph / setFrame4D indexing).
      name: 'floorsAFractionalLimit',
      cases: [[1.5, 4, 4, 1]],
    },
    {
      name: 'clampsALimitBelowOneToASingleFrame',
      cases: [
        [0, 4, 4, 1],
        [-3, 4, 4, 1],
      ],
    },
    {
      name: 'clampsALimitLargerThanTheDataToTheTotalFrameCount',
      cases: [[10, 3, 3, 3]],
    },
    {
      // Recovery path: a >2 GiB volume was capped by the loader, so the buffer
      // holds fewer frames (2) than the header declares (4). Even with no
      // explicit limit, nFrame4D must not claim more frames than the buffer
      // contains.
      name: 'clampsToFramesActuallyPresentWhenBufferHoldsFewerThanTheHeaderClaims',
      cases: [[Infinity, 2, 4, 2]],
    },
    {
      // request 3, but only 2 frames on hand, header says 5 -> 2 wins;
      // request 3, 5 frames on hand, header says 4 -> 3 (the request) wins.
      name: 'appliesTheTightestOfAllThreeConstraints',
      cases: [
        [3, 2, 5, 2],
        [3, 5, 4, 3],
      ],
    },
  ])('$name', ({ cases }) => {
    for (const [limit, inImg, total, expected] of cases) {
      expect(resolveFrame4DCount(limit, inImg, total)).toBe(expected)
    }
  })
})
