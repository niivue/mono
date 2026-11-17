import { describe, expect, test } from 'bun:test'
import { computeAllScalarMeta } from '../index'
import { read } from './trk'

// A one-streamline, one-point TRK with one scalar and one property name.
function trk(
  scalar: string,
  property: string,
  voxelSize = 1,
  vox2ras = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
): ArrayBuffer {
  const buf = new ArrayBuffer(1000 + 4 * 6)
  const v = new DataView(buf)
  const bytes = new Uint8Array(buf)
  v.setUint32(0, 1128354388, true) // 'TRAC'
  for (const o of [12, 16, 20]) v.setFloat32(o, voxelSize, true)
  v.setInt16(36, 1, true)
  bytes.set(new TextEncoder().encode(scalar), 38)
  v.setInt16(238, 1, true)
  bytes.set(new TextEncoder().encode(property), 240)
  for (let i = 0; i < 16; i++) v.setFloat32(440 + i * 4, vox2ras[i], true)
  v.setUint32(992, 2, true)
  v.setUint32(996, 1000, true)
  v.setInt32(1000, 1, true) // one point: x y z scalar, then the property
  for (let i = 1; i < 6; i++) v.setFloat32(1000 + i * 4, i, true)
  return buf
}

describe('TRK reader', () => {
  test('keeps names that collide with Object.prototype as own keys', async () => {
    const t = await read(trk('__proto__', 'constructor'))
    expect(Object.keys(t.dpv)).toEqual(['__proto__'])
    expect(Object.keys(t.dps)).toEqual(['constructor'])
    expect(Object.values(t.dpv).map((a) => Array.from(a))).toEqual([[4]])
    expect(Object.values(t.dps).map((a) => Array.from(a))).toEqual([[5]])
  })

  test('scalar metadata keeps prototype-named scalars', async () => {
    const t = await read(trk('__proto__', 'constructor'))
    computeAllScalarMeta(t)
    expect(Object.keys(t.dpvMeta)).toEqual(['__proto__'])
    expect(Object.keys(t.dpsMeta)).toEqual(['constructor'])
  })

  test('maps voxmm through vox_to_ras for LAS order and non-unit voxels', async () => {
    // LAS, 2 mm voxels; the point (1, 2, 3) voxmm sits at voxel (0, 0.5, 1).
    const las = [-2, 0, 0, 100, 0, 2, 0, -50, 0, 0, 2, 10, 0, 0, 0, 1]
    const t = await read(trk('s', 'p', 2, las))
    expect(Array.from(t.vertices)).toEqual([100, -49, 12])
  })
})
