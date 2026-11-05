import { describe, expect, test } from 'bun:test'
import { FLOATS_PER_BOX_EDGE, packBoxEdges, scissorRect } from './NVBoxEdges'

const box = {
  min: [0, 0, 0] as [number, number, number],
  max: [1, 2, 3] as [number, number, number],
  color: [1, 0.5, 0.25],
  thickness: 0,
}

const shows = (
  focus: typeof box | null,
  lod: (typeof box)[] | null = null,
  picked: typeof box | null = null,
) => ({ _focusBox: focus, _lodBoxes: lod, _pickedBlockBox: picked })

describe('packBoxEdges', () => {
  test('null when no box is shown', () => {
    expect(packBoxEdges(shows(null))).toBeNull()
    expect(packBoxEdges(shows(null, []))).toBeNull()
  })

  test('12 edges per box, each joining corners that differ on one axis', () => {
    const out = packBoxEdges(shows(box, [], box)) as Float32Array
    expect(out.length).toBe(2 * 12 * FLOATS_PER_BOX_EDGE)
    const keys = new Set<string>()
    for (let o = 0; o < 12 * FLOATS_PER_BOX_EDGE; o += FLOATS_PER_BOX_EDGE) {
      const a = Array.from(out.subarray(o, o + 3))
      const b = Array.from(out.subarray(o + 3, o + 6))
      expect(a.filter((v, i) => v !== b[i]).length).toBe(1)
      keys.add([a, b].map(String).sort().join('|'))
    }
    expect(keys.size).toBe(12)
  })

  test('packs focus, then LOD boxes, then the picked block', () => {
    const at = (b: typeof box, x: number) => ({
      ...b,
      min: [x, 0, 0] as [number, number, number],
    })
    const out = packBoxEdges(
      shows(at(box, 7), [at(box, 8)], at(box, 9)),
    ) as Float32Array
    const stride = 12 * FLOATS_PER_BOX_EDGE
    expect([out[0], out[stride], out[2 * stride]]).toEqual([7, 8, 9])
  })

  test('scissor rounds to whole pixels and stays inside the clip', () => {
    expect(scissorRect([10.4, 0, 20.4, 5], [0, 0, 100, 100])).toEqual([
      10, 0, 21, 5,
    ])
    expect(scissorRect([-5, 90, 20, 20], [0, 0, 100, 100])).toEqual([
      0, 90, 15, 10,
    ])
    expect(scissorRect([200, 0, 10, 10], [0, 0, 100, 100])).toBeNull()
  })

  test('thickness is at least 1 and alpha defaults to opaque', () => {
    const out = packBoxEdges(shows(box)) as Float32Array
    expect(out[6]).toBe(1)
    expect(Array.from(out.subarray(8, 12))).toEqual([1, 0.5, 0.25, 1])
  })
})
