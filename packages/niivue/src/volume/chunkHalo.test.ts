import { describe, expect, test } from 'bun:test'
import {
  type ChunkPlan,
  CUBIC_MIN_HALO,
  chunkVolume,
  chunkVolumeGrid,
  chunkVolumeMultiLOD,
  LINEAR_MIN_HALO,
  planSupportsCubic,
  planSupportsHalo,
  type Vec3i,
} from './chunking'

// ---------------------------------------------------------------------------
// Why these numbers: a CPU replica of the shader's reconstruction.
//
// `sampleTricubic` (gl/renderShader.ts, mirrored in wgpu/volumeShaderLib.ts)
// reads texels `floor(x) - 1 .. floor(x) + 2`, and `chunkTexCoord` lets a ray
// sample land half a voxel past the outermost OWNED voxel centre (right on the
// brick face). So a brick must carry neighbour voxels past its own data, or the
// kernel reconstructs from clamp-to-edge texels and every internal brick face
// shows a seam.
//
// The probe below measures exactly that: the same reconstruction evaluated over
// the whole volume vs over one extracted brick, sampled in the half-voxel band
// at the brick's faces. It pins LINEAR_MIN_HALO and CUBIC_MIN_HALO to measured
// behaviour rather than to a comment, so lowering either constant fails here.
// ---------------------------------------------------------------------------

type Vol = { d: Vec3i; v: Float32Array }

/** Clamp-to-edge voxel fetch, matching the samplers' wrap mode. */
function at(V: Vol, i: number, j: number, k: number): number {
  const [dx, dy, dz] = V.d
  const ci = i < 0 ? 0 : i >= dx ? dx - 1 : i
  const cj = j < 0 ? 0 : j >= dy ? dy - 1 : j
  const ck = k < 0 ? 0 : k >= dz ? dz - 1 : k
  return V.v[ci + cj * dx + ck * dx * dy]
}

/** Hardware trilinear filtering of `V` at a [0,1] texture coordinate. */
function texture(V: Vol, u: number, w: number, t: number): number {
  const [dx, dy, dz] = V.d
  const x = u * dx - 0.5
  const y = w * dy - 0.5
  const z = t * dz - 0.5
  const i = Math.floor(x)
  const j = Math.floor(y)
  const k = Math.floor(z)
  const fx = x - i
  const fy = y - j
  const fz = z - k
  let acc = 0
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      for (let c = 0; c < 2; c++) {
        const wgt = (a ? fx : 1 - fx) * (b ? fy : 1 - fy) * (c ? fz : 1 - fz)
        acc += wgt * at(V, i + a, j + b, k + c)
      }
    }
  }
  return acc
}

/** Port of sampleTricubic(): 8 trilinear fetches, B-spline weights. */
function sampleTricubic(V: Vol, co: [number, number, number]): number {
  const dims = V.d
  const grid = co.map((c, a) => c * dims[a] - 0.5)
  const idx = grid.map(Math.floor)
  const f = grid.map((g, a) => g - idx[a])
  const g = f.map((x) => 1 - x)
  const w0 = g.map((x) => (1 / 6) * x * x * x)
  const w1 = f.map((x) => 2 / 3 - 0.5 * x * x * (2 - x))
  const w2 = g.map((x) => 2 / 3 - 0.5 * x * x * (2 - x))
  const w3 = f.map((x) => (1 / 6) * x * x * x)
  const s0 = w0.map((x, a) => x + w1[a])
  const s1 = w2.map((x, a) => x + w3[a])
  const inv = dims.map((x) => 1 / x)
  const h0 = inv.map((x, a) => x * (w1[a] / s0[a] - 0.5 + idx[a]))
  const h1 = inv.map((x, a) => x * (w3[a] / s1[a] + 1.5 + idx[a]))
  const mix = (x: number, y: number, a: number): number => x * (1 - a) + y * a
  const T = (i: number, j: number, k: number): number =>
    texture(V, i ? h1[0] : h0[0], j ? h1[1] : h0[1], k ? h1[2] : h0[2])
  const line = (j: number, k: number): number =>
    mix(T(1, j, k), T(0, j, k), s0[0])
  const plane = (k: number): number => mix(line(1, k), line(0, k), s0[1])
  return mix(plane(1), plane(0), s0[2])
}

/** Copy a brick's texture out of the volume (clamped reads at the boundary). */
function brick(V: Vol, o: Vec3i, s: Vec3i): Vol {
  const v = new Float32Array(s[0] * s[1] * s[2])
  for (let k = 0; k < s[2]; k++) {
    for (let j = 0; j < s[1]; j++) {
      for (let i = 0; i < s[0]; i++) {
        v[i + j * s[0] + k * s[0] * s[1]] = at(V, o[0] + i, o[1] + j, o[2] + k)
      }
    }
  }
  return { d: [s[0], s[1], s[2]], v }
}

function mulberry(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Worst case for a reconstruction filter: every voxel independently 0 or 255,
 * so any kernel overhang onto fabricated data shows at full contrast.
 */
function noiseVolume(edge: number): Vol {
  const rnd = mulberry(1337)
  const v = new Float32Array(edge * edge * edge)
  for (let i = 0; i < v.length; i++) v[i] = rnd() < 0.5 ? 0 : 255
  return { d: [edge, edge, edge], v }
}

/**
 * Reconstruction error of ONE interior brick against the whole volume, as a
 * fraction of the intensity range, sampled in the half-voxel band at each face.
 */
function faceError(V: Vol, cell: number, halo: number, cubic: boolean): number {
  const [dx, dy, dz] = V.d
  const o: Vec3i = [cell, cell, cell]
  const to: Vec3i = [o[0] - halo, o[1] - halo, o[2] - halo]
  const ts: Vec3i = [cell + 2 * halo, cell + 2 * halo, cell + 2 * halo]
  const B = brick(V, to, ts)
  const smp = cubic
    ? sampleTricubic
    : (W: Vol, c: [number, number, number]) => texture(W, c[0], c[1], c[2])
  const rnd = mulberry(12345)
  let maxAbs = 0
  for (let s = 0; s < 3000; s++) {
    const face = s % 3
    const t = [
      o[0] + rnd() * (cell - 1),
      o[1] + rnd() * (cell - 1),
      o[2] + rnd() * (cell - 1),
    ]
    // chunkTexCoord maps the brick's owned cube onto texture coords
    // [haloLow, haloLow + data], i.e. continuous voxel index
    // [haloLow - 0.5, haloLow + data - 0.5]. A ray sample can therefore land
    // half a voxel past the outermost owned voxel centre: that band is where
    // the kernel overhangs, so it is what must be probed.
    t[face] = o[face] - 0.5 + rnd()
    const full = smp(V, [
      (t[0] + 0.5) / dx,
      (t[1] + 0.5) / dy,
      (t[2] + 0.5) / dz,
    ])
    const chunked = smp(B, [
      (t[0] - to[0] + 0.5) / ts[0],
      (t[1] - to[1] + 0.5) / ts[1],
      (t[2] - to[2] + 0.5) / ts[2],
    ])
    maxAbs = Math.max(maxAbs, Math.abs(full - chunked))
  }
  return maxAbs / 255
}

describe('required brick halo (measured against the shader reconstruction)', () => {
  const V = noiseVolume(96)
  const CELL = 24
  // Bit-exact agreement is not required: the brick's reconstruction differs
  // only by float rounding once the halo is sufficient.
  const EXACT = 1e-6

  test(`trilinear reproduces the whole volume at halo ${LINEAR_MIN_HALO}`, () => {
    expect(faceError(V, CELL, LINEAR_MIN_HALO, false)).toBeLessThan(EXACT)
    expect(faceError(V, CELL, LINEAR_MIN_HALO + 1, false)).toBeLessThan(EXACT)
  })

  test('trilinear seams badly with no halo', () => {
    expect(faceError(V, CELL, 0, false)).toBeGreaterThan(0.1)
  })

  test(`tricubic reproduces the whole volume at halo ${CUBIC_MIN_HALO}`, () => {
    expect(faceError(V, CELL, CUBIC_MIN_HALO, true)).toBeLessThan(EXACT)
    expect(faceError(V, CELL, CUBIC_MIN_HALO + 1, true)).toBeLessThan(EXACT)
  })

  test('tricubic still seams at the trilinear halo', () => {
    // Small (the outermost B-spline tap carries at most (0.5)^3/6 ~ 2% of the
    // weight) but a coherent sheet on every internal face, which reads as a
    // visible grid of brick boundaries. This is the regression under test:
    // CUBIC_MIN_HALO must stay above LINEAR_MIN_HALO.
    expect(CUBIC_MIN_HALO).toBeGreaterThan(LINEAR_MIN_HALO)
    expect(faceError(V, CELL, LINEAR_MIN_HALO, true)).toBeGreaterThan(0.005)
  })
})

describe('planSupportsHalo / planSupportsCubic', () => {
  const DIMS: Vec3i = [400, 400, 400]

  test('a chunkVolume plan is cubic-safe only when planned with halo >= 2', () => {
    for (const h of [0, 1, 2, 3]) {
      const plan = chunkVolume(DIMS, 256, [h, h, h])
      expect(plan.chunks.length).toBeGreaterThan(1)
      expect(planSupportsHalo(plan, LINEAR_MIN_HALO)).toBe(h >= LINEAR_MIN_HALO)
      expect(planSupportsCubic(plan)).toBe(h >= CUBIC_MIN_HALO)
    }
  })

  test('a single-brick plan is always safe (no internal faces)', () => {
    const plan = chunkVolume([64, 64, 64], 256, [0, 0, 0])
    expect(plan.chunks.length).toBe(1)
    expect(planSupportsCubic(plan)).toBe(true)
  })

  test('a source-aligned grid plan follows its requested halo', () => {
    const grid: Vec3i = [4, 4, 4]
    for (const h of [0, 1, 2]) {
      const plan = chunkVolumeGrid([256, 256, 256], grid, 256, [h, h, h])
      expect(planSupportsCubic(plan)).toBe(h >= CUBIC_MIN_HALO)
    }
  })

  test('a multi-LOD plan follows its requested halo across levels', () => {
    const pyramid: Vec3i[] = [
      [1024, 1024, 1024],
      [512, 512, 512],
      [256, 256, 256],
      [128, 128, 128],
    ]
    for (const h of [1, 2, 3]) {
      const plan = chunkVolumeMultiLOD(
        pyramid,
        { center: [512, 512, 512], radius: 128 },
        256,
        { cellEdge: 64, haloSize: [h, h, h] },
      )
      // Mixed levels, so the predicate must resolve each brick's own level dims.
      const levels = new Set(plan.chunks.map((c) => c.sourceLevel ?? 0))
      expect(levels.size).toBeGreaterThan(1)
      expect(planSupportsCubic(plan)).toBe(h >= CUBIC_MIN_HALO)
    }
  })

  test('a brick clamped by the level boundary counts as safe on that face', () => {
    // haloLow 0 with texOrigin 0 is the volume's own edge: the brick's
    // clamp-to-edge reproduces the whole-volume clamp exactly, so no seam.
    const plan = chunkVolume([400, 400, 400], 256, [
      CUBIC_MIN_HALO,
      CUBIC_MIN_HALO,
      CUBIC_MIN_HALO,
    ])
    const edge = plan.chunks.filter((c) => c.haloLow[0] === 0)
    expect(edge.length).toBeGreaterThan(0)
    for (const c of edge) expect(c.texOrigin[0]).toBe(0)
    expect(planSupportsCubic(plan)).toBe(true)
  })

  test('a hand-built plan with a truncated interior halo is rejected', () => {
    const plan = chunkVolume([400, 400, 400], 256, [3, 3, 3])
    expect(planSupportsCubic(plan)).toBe(true)
    // Pick a brick whose high-x face is INTERNAL, so its halo actually matters.
    const victim = plan.chunks.findIndex(
      (c) => c.texOrigin[0] + c.texDims[0] < 400,
    )
    expect(victim).toBeGreaterThanOrEqual(0)
    const broken: ChunkPlan = {
      ...plan,
      chunks: plan.chunks.map((c, i) =>
        i === victim
          ? { ...c, haloHigh: [1, c.haloHigh[1], c.haloHigh[2]] }
          : c,
      ),
    }
    expect(planSupportsCubic(broken)).toBe(false)
    expect(planSupportsHalo(broken, LINEAR_MIN_HALO)).toBe(true)
  })
})
