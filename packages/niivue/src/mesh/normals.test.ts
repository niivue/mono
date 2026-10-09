import { describe, expect, test } from 'bun:test'
import { generateNormals } from './normals'

// The allocation-heavy implementation generateNormals replaced, kept verbatim
// as the reference: the rewrite must reproduce it bit for bit.
function referenceNormals(pts: Float32Array, tris: Uint32Array): Float32Array {
  const norms = new Float32Array(pts.length)
  for (let i = 0; i < tris.length; i += 3) {
    const i1 = tris[i] * 3
    const i2 = tris[i + 1] * 3
    const i3 = tris[i + 2] * 3
    const v1 = [pts[i1], pts[i1 + 1], pts[i1 + 2]]
    const v2 = [pts[i2], pts[i2 + 1], pts[i2 + 2]]
    const v3 = [pts[i3], pts[i3 + 1], pts[i3 + 2]]
    const q = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]]
    const p = [v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2]]
    const n = [
      p[1] * q[2] - p[2] * q[1],
      p[2] * q[0] - p[0] * q[2],
      p[0] * q[1] - p[1] * q[0],
    ]
    for (const index of [i1, i2, i3]) {
      norms[index] += n[0]
      norms[index + 1] += n[1]
      norms[index + 2] += n[2]
    }
  }
  for (let i = 0; i < norms.length; i += 3) {
    const len = Math.sqrt(norms[i] ** 2 + norms[i + 1] ** 2 + norms[i + 2] ** 2)
    if (len > 0) {
      norms[i] /= -len
      norms[i + 1] /= -len
      norms[i + 2] /= -len
    }
  }
  return norms
}

/** Element-wise Object.is: exact float32 values, -0 vs +0 and NaN included. */
function expectIdentical(actual: Float32Array, expected: Float32Array): void {
  expect(actual.length).toBe(expected.length)
  let mismatches = 0
  for (let i = 0; i < expected.length; i++) {
    if (!Object.is(actual[i], expected[i])) mismatches++
  }
  expect(mismatches).toBe(0)
}

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A closed UV sphere with noisy radius: shared vertices, poles, seams. */
function noisySphere(
  rings: number,
  segments: number,
  seed: number,
): { positions: Float32Array; indices: Uint32Array } {
  const rand = rng(seed)
  const positions: number[] = []
  for (let r = 0; r <= rings; r++) {
    const theta = (r / rings) * Math.PI
    for (let s = 0; s < segments; s++) {
      const phi = (s / segments) * 2 * Math.PI
      const radius = 50 + rand() * 5
      positions.push(
        radius * Math.sin(theta) * Math.cos(phi) + 12.5,
        radius * Math.sin(theta) * Math.sin(phi) - 3.25,
        radius * Math.cos(theta) + 0.1,
      )
    }
  }
  const indices: number[] = []
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * segments + s
      const b = r * segments + ((s + 1) % segments)
      const c = a + segments
      const d = b + segments
      indices.push(a, c, b, b, c, d)
    }
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  }
}

function randomSoup(
  nVerts: number,
  nTris: number,
  seed: number,
): { positions: Float32Array; indices: Uint32Array } {
  const rand = rng(seed)
  const positions = new Float32Array(nVerts * 3)
  for (let i = 0; i < positions.length; i++) {
    positions[i] = (rand() - 0.5) * 10 ** Math.floor(rand() * 6 - 2)
  }
  const indices = new Uint32Array(nTris * 3)
  for (let i = 0; i < indices.length; i++) {
    indices[i] = Math.floor(rand() * nVerts)
  }
  return { positions, indices }
}

describe('generateNormals', () => {
  test('matches the reference on a closed sphere with shared vertices', () => {
    const { positions, indices } = noisySphere(40, 64, 1)
    expectIdentical(
      generateNormals(positions, indices),
      referenceNormals(positions, indices),
    )
  })

  test('matches the reference on random soups with heavy vertex sharing', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { positions, indices } = randomSoup(500, 4000, seed)
      expectIdentical(
        generateNormals(positions, indices),
        referenceNormals(positions, indices),
      )
    }
  })

  test('matches the reference on degenerate triangles and unused vertices', () => {
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 7, 7, 7, 1e-30, 0, 0, 0,
      1e-30, 0,
    ])
    const triangles = [
      [0, 0, 0], // all three corners the same vertex
      [0, 1, 1], // repeated index
      [0, 1, 3], // collinear, zero area
      [1, 3, 4], // collinear, zero area
      [0, 1, 2], // a real triangle...
      [0, 2, 1], // ...and its mirror: the sums for 0, 1 and 2 cancel to zero
      [0, 6, 7], // area underflows to zero in the float32 accumulator
    ] // vertex 5 is unused
    const indices = new Uint32Array(triangles.flat())
    const actual = generateNormals(positions, indices)
    expectIdentical(actual, referenceNormals(positions, indices))
    // Zero-length sums stay zero rather than becoming NaN.
    expect(Math.hypot(...actual.subarray(15, 18))).toBe(0)
    expect(Math.hypot(...actual.subarray(0, 3))).toBe(0)
  })

  test('matches the reference on a single triangle, both windings', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    for (const tri of [
      [0, 1, 2],
      [0, 2, 1],
    ]) {
      const indices = new Uint32Array(tri)
      const actual = generateNormals(positions, indices)
      expectIdentical(actual, referenceNormals(positions, indices))
      expect(Math.abs(actual[2])).toBe(1)
    }
  })

  test('matches the reference on malformed index data', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
    for (const tri of [
      [0, 1, 2, 3], // trailing partial triangle
      [0, 1, 9], // out-of-range index
    ]) {
      const indices = new Uint32Array(tri)
      expectIdentical(
        generateNormals(positions, indices),
        referenceNormals(positions, indices),
      )
    }
  })

  test('returns zeros for an empty index list', () => {
    const positions = new Float32Array([1, 2, 3, 4, 5, 6])
    expectIdentical(
      generateNormals(positions, new Uint32Array(0)),
      new Float32Array(6),
    )
  })
})
