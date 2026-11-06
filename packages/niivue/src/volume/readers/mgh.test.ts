import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { NiiDataType } from '@/NVConstants'
import { calMinMax, toTypedViewOrU8 } from '@/volume/utils'
import { read } from './mgh'

// A small synthetic FreeSurfer INT32 (MRI_INT, type 1) volume. MGH/MGZ is
// big-endian, so an int-typed file is required to exercise the byte-swap: a
// UCHAR file would decode correctly even without swapping and so would not
// guard the regression. No value's four bytes are a palindrome, so a missed
// swap changes every one of them (most into +-tens of millions or more).
const DIMS = [4, 3, 2] as const
const VALUES = [
  0, 1, 2, 3, 250, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  0x01020304, -2, 70000, -123456,
]
const N_VOX = DIMS[0] * DIMS[1] * DIMS[2]
const EXPECTED = {
  min: -123456,
  max: 0x01020304,
  sum: VALUES.reduce((a, b) => a + b, 0),
  // linear RAS index of voxel [0,2,1] = i + j*4 + k*4*3
  midIndex: 0 + 2 * 4 + 1 * 4 * 3,
  midValue: 0x01020304,
}

/** A version-1 MGH: 284-byte big-endian header, then big-endian INT32 voxels. */
function mghInt32(): Uint8Array {
  const bytes = new Uint8Array(284 + N_VOX * 4)
  const dv = new DataView(bytes.buffer)
  dv.setInt32(0, 1, false) // version
  dv.setInt32(4, DIMS[0], false)
  dv.setInt32(8, DIMS[1], false)
  dv.setInt32(12, DIMS[2], false)
  dv.setInt32(16, 1, false) // frames
  dv.setInt32(20, 1, false) // MRI_INT
  dv.setInt16(28, 1, false) // goodRASFlag
  for (let a = 0; a < 3; a++) dv.setFloat32(30 + a * 4, 1, false) // spacing
  // direction cosines x_ras, y_ras, z_ras: identity
  dv.setFloat32(42, 1, false)
  dv.setFloat32(58, 1, false)
  dv.setFloat32(74, 1, false)
  for (let i = 0; i < N_VOX; i++) dv.setInt32(284 + i * 4, VALUES[i], false)
  return bytes
}

describe('mgh reader (big-endian INT32)', () => {
  test('decodesInt32VoxelsInNativeByteOrder', async () => {
    // Gzipped, so the reader's own gzip branch is covered.
    const buf = gzipSync(mghInt32())
    const { hdr, img } = await read(buf, 'brainmask-int.mgz')

    expect(hdr.datatypeCode).toBe(NiiDataType.DT_INT32)
    expect(hdr.numBitsPerVoxel).toBe(32)
    expect(hdr.dims[1]).toBe(DIMS[0])
    expect(hdr.dims[2]).toBe(DIMS[1])
    expect(hdr.dims[3]).toBe(DIMS[2])

    // Exercise the same conversion and range calculation used by nii2volume.
    // Returning Uint8Array from the reader would bypass this conversion and
    // incorrectly treat each byte as a voxel.
    expect(img).toBeInstanceOf(ArrayBuffer)
    const i32 = toTypedViewOrU8(img, hdr.datatypeCode)
    expect(i32).toBeInstanceOf(Int32Array)
    if (!(i32 instanceof Int32Array)) {
      throw new Error('Expected MGH INT32 data to become an Int32Array')
    }
    expect(i32.length).toBe(N_VOX)

    const [, , globalMin, globalMax] = calMinMax(hdr, img)
    expect(globalMin).toBe(EXPECTED.min)
    expect(globalMax).toBe(EXPECTED.max)

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
    expect(max).toBe(EXPECTED.max)
    expect(sum).toBe(EXPECTED.sum)
    expect(Array.from(i32)).toEqual(VALUES)
    expect(i32[EXPECTED.midIndex]).toBe(EXPECTED.midValue)
  })

  test('acceptsANodeBufferWithoutHandingBackItsWholeAllocation', async () => {
    // A Buffer's slice() is subarray(), so taking `.buffer` off it returns the
    // entire underlying allocation rather than the image. The Buffer here is a
    // view at a non-zero offset into a larger allocation (as gunzipSync and
    // pooled Buffers give); a .mgh name skips the gzip branch so this
    // exercises only the slicing. The reader must also leave the caller's
    // bytes unswapped.
    const pad = Buffer.alloc(64, 0xaa)
    const bytes = mghInt32()
    const raw = Buffer.concat([pad, bytes, pad]).subarray(
      pad.length,
      pad.length + bytes.length,
    )
    expect(raw.buffer.byteLength).toBeGreaterThan(raw.length)
    const lastVoxelByte = raw[raw.length - 1]
    const { hdr, img } = await read(raw, 'brainmask-int.mgh')

    expect(img).toBeInstanceOf(ArrayBuffer)
    expect((img as ArrayBuffer).byteLength).toBe(N_VOX * 4)
    const i32 = toTypedViewOrU8(img, hdr.datatypeCode)
    expect(i32).toBeInstanceOf(Int32Array)
    expect((i32 as Int32Array).length).toBe(N_VOX)
    expect((i32 as Int32Array)[EXPECTED.midIndex]).toBe(EXPECTED.midValue)
    expect(raw[raw.length - 1]).toBe(lastVoxelByte)
  })
})
