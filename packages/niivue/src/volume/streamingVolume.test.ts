import { describe, expect, test } from 'bun:test'
import { NiiDataType } from '@/NVConstants'
import { createStreamingNVImage } from './streamingVolume'

describe('createStreamingNVImage', () => {
  test('builds an axis-aligned streamed NVImage skeleton with derived transforms', () => {
    const vol = createStreamingNVImage({
      shape: [4, 6, 8],
      spacing: [2, 1, 0.5],
      datatypeCode: NiiDataType.DT_INT16,
      calMin: 10,
      calMax: 200,
      colormap: 'viridis',
      id: 'stream-a',
    })

    // No resident image data — voxels arrive via a chunkSource the caller attaches.
    expect(vol.img).toBeNull()
    expect(vol.id).toBe('stream-a')
    expect(vol.name).toBe('stream-a')
    expect(vol.dims).toEqual([3, 4, 6, 8])
    expect(vol.nVox3D).toBe(4 * 6 * 8)
    expect(vol.hdr.datatypeCode).toBe(NiiDataType.DT_INT16)

    // Display state carried through.
    expect(vol.calMin).toBe(10)
    expect(vol.calMax).toBe(200)
    expect(vol.colormap).toBe('viridis')
    expect(vol.isTransparentBelowCalMin).toBe(true)

    // Geometry derived by calculateRAS (axis-aligned diag(spacing) => no reorder).
    expect(vol.permRAS).toEqual([1, 2, 3])
    expect(vol.dimsRAS).toEqual([3, 4, 6, 8])
    expect(vol.matRAS).toBeDefined()
    expect(vol.frac2mm).toBeDefined()
    expect(vol.mm000).toBeDefined()

    // Extents are finite and ordered per axis.
    for (let a = 0; a < 3; a++) {
      expect(Number.isFinite(vol.extentsMin?.[a] ?? Number.NaN)).toBe(true)
      expect(Number.isFinite(vol.extentsMax?.[a] ?? Number.NaN)).toBe(true)
      expect(vol.extentsMax?.[a]).toBeGreaterThan(vol.extentsMin?.[a] ?? 0)
    }

    // volScale = per-axis mm extent / longest axis; dimsMM = [8, 6, 4], longest 8.
    expect(vol.volScale?.[0]).toBeCloseTo(1)
    expect(vol.volScale?.[1]).toBeCloseTo(0.75)
    expect(vol.volScale?.[2]).toBeCloseTo(0.5)
  })

  test('defaults name/colormap/opacity when omitted', () => {
    const vol = createStreamingNVImage({
      shape: [2, 2, 2],
      spacing: [1, 1, 1],
      datatypeCode: NiiDataType.DT_UINT8,
      calMin: 0,
      calMax: 255,
    })
    expect(vol.name).toBe('streamed volume')
    expect(vol.colormap).toBe('gray')
    expect(vol.opacity).toBe(1)
  })
})
