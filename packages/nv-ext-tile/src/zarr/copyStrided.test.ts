import { expect, test } from 'bun:test'
import { copyStrided } from './copyStrided'

// Frozen pre-extraction loops: omeZarrBlockToDisplay and readLevelRegion.
function oldBlock(
  data: Uint16Array,
  [nx, ny, nz]: number[],
  [a, b, c]: number[],
) {
  const img = new Uint16Array(nx * ny * nz)
  let out = 0
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      let src = z * c + y * b
      for (let x = 0; x < nx; x++) {
        img[out] = data[src]
        out += 1
        src += a
      }
    }
  return img
}
function oldRegion(
  data: Uint16Array,
  [rx, ry, rz]: number[],
  [a, b, c]: number[],
  [sx, sy, sz]: number[],
) {
  const out = new Uint16Array(sx * sy * sz)
  for (let z = 0; z < rz; z++)
    for (let y = 0; y < ry; y++) {
      const src = z * c + y * b
      const dst = z * sx * sy + y * sx
      if (a === 1) out.set(data.subarray(src, src + rx), dst)
      else for (let x = 0; x < rx; x++) out[dst + x] = data[src + x * a]
    }
  return out
}

const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
]

test('matches both old loops for every declared axis order, short and long rows', () => {
  for (const dims of [
    [3, 4, 5],
    [130, 3, 2],
    [200, 1, 1],
    [1, 7, 3],
  ]) {
    const n = dims[0] * dims[1] * dims[2]
    const data = new Uint16Array(n).map((_, i) => (i * 7919) & 0xffff)
    // zarrita's C-order strides over the axes as declared (slowest first).
    for (const declared of permutations) {
      const strides = [0, 0, 0]
      let s = 1
      for (const axis of [...declared].reverse()) {
        strides[axis] = s
        s *= dims[axis]
      }
      const packed = new Uint16Array(n)
      copyStrided(packed, data, dims, strides, dims[0], dims[0] * dims[1])
      expect(packed).toEqual(oldBlock(data, dims, strides))
      // readLevelRegion: zero-padded into a larger brick.
      const tex = [dims[0] + 3, dims[1] + 1, dims[2] + 2]
      const padded = new Uint16Array(tex[0] * tex[1] * tex[2])
      copyStrided(padded, data, dims, strides, tex[0], tex[0] * tex[1])
      expect(padded).toEqual(oldRegion(data, dims, strides, tex))
    }
  }
})
