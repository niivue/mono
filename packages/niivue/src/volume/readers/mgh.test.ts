import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NiiDataType } from '@/NVConstants'
import { read } from './mgh'

// A real FreeSurfer INT32 (MRI_INT) volume. MGH/MGZ is big-endian, so an
// int-typed fixture is required to exercise the byte-swap: a UCHAR .mgz would
// decode correctly even without swapping and so would not guard the regression.
const FIXTURE = join(
  import.meta.dir,
  '../../../../dev-images/images/volumes/fs',
  'brainmask-int.mgz',
)

// Ground-truth values, computed independently by reading the file as big-endian
// int32. The pre-fix bug (native little-endian view of big-endian bytes) turns
// these into 0 + scattered +-tens-of-millions.
const EXPECTED = {
  min: 0,
  max: 250,
  sum: 109423756,
  // linear RAS index of voxel [128,128,128] = i + j*256 + k*256*256
  midIndex: 128 + 128 * 256 + 128 * 256 * 256,
  midValue: 8,
}

describe('mgh reader (big-endian INT32 MGZ)', () => {
  test('decodesInt32VoxelsInNativeByteOrder', async () => {
    const buf = readFileSync(FIXTURE)
    const { hdr, img } = await read(buf, 'brainmask-int.mgz')

    expect(hdr.datatypeCode).toBe(NiiDataType.DT_INT32)
    expect(hdr.numBitsPerVoxel).toBe(32)
    expect(hdr.dims[1]).toBe(256)
    expect(hdr.dims[2]).toBe(256)
    expect(hdr.dims[3]).toBe(256)

    // View the returned bytes exactly as the platform (and toTypedViewOrU8)
    // reads them: a native Int32Array. After the fix these are the true values.
    const bytes = img instanceof Uint8Array ? img : new Uint8Array(img)
    const i32 = new Int32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4,
    )
    expect(i32.length).toBe(256 * 256 * 256)

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let sum = 0
    for (let i = 0; i < i32.length; i++) {
      const v = i32[i]
      if (v < min) {
        min = v
      }
      if (v > max) {
        max = v
      }
      sum += v
    }

    expect(min).toBe(EXPECTED.min)
    // Regression guard: the buggy native-LE misread produced max > 2e9.
    expect(max).toBe(EXPECTED.max)
    expect(sum).toBe(EXPECTED.sum)
    expect(i32[EXPECTED.midIndex]).toBe(EXPECTED.midValue)
  })
})
