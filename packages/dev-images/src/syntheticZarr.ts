/**
 * Procedural OME-Zarr stores with the geometry of the DANDI 000722 OCT stores
 * (float32, 64^3 chunks, 20 um), generated per chunk by the dev server. They
 * load through the same zarr fetch/decode path as the remote stores, with
 * localhost latency and no bytes in the repository.
 *
 * The field is a sum of gyroid octaves, clipped at 0, inside a soft ellipsoid.
 * Each level keeps only the octaves it can represent (wavelength >= 2 voxels),
 * so every finer level adds detail the coarser ones lack, as a real pyramid does.
 *
 * Bump a store's version when the field changes: the demo's persistent cache
 * keeps chunks across reloads.
 */

export const SYNTHETIC_ZARR_ROOT = '/tiles/'

const CHUNK = 64
const BASE_SPACING_MM = 0.02
const EDGE_MM = 2 * BASE_SPACING_MM

// Level-0 shape [z, y, x] and level count of each DANDI store copied.
const STORES: Record<string, { shape: number[]; levels: number }> = {
  // 000722 chunk-02, 106 MB
  'synthetic-v1': { shape: [301, 301, 301], levels: 4 },
  // 000722 chunk-01, 4.5 GB
  'synthetic-oct-v1': { shape: [561, 1470, 1716], levels: 6 },
}

type Level = { shape: number[]; scale: number[]; translation: number[] }

type Store = {
  levels: Level[]
  extent: number[]
  amplitudes: number[]
  wavelengths: number[]
}

function buildStore(shape0: number[], count: number): Store {
  // Each level halves (rounding up) and spans the same extent, so its voxel
  // centres sit half a voxel in.
  const levels: Level[] = []
  let shape = shape0
  for (let i = 0; i < count; i++) {
    const scale = shape.map((n, a) => (BASE_SPACING_MM * shape0[a]) / n)
    levels.push({
      shape,
      scale,
      translation: scale.map((s) => (s - BASE_SPACING_MM) / 2),
    })
    shape = shape.map((n) => Math.ceil(n / 2))
  }
  const extent = shape0.map((n) => n * BASE_SPACING_MM)
  // Finest octave spans 3 level-0 voxels; each doubles up to a third of the
  // longest side.
  const wavelengths: number[] = []
  for (let w = 3 * BASE_SPACING_MM; w <= Math.max(...extent) / 3; w *= 2) {
    wavelengths.push(w)
  }
  const amplitudes = wavelengths.map(
    (_, k) => 0.8 ** (wavelengths.length - 1 - k),
  )
  return { levels, extent, amplitudes, wavelengths }
}

const stores = new Map(
  Object.entries(STORES).map(([name, s]) => [
    name,
    buildStore(s.shape, s.levels),
  ]),
)

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function zattrs(store: Store) {
  return json({
    multiscales: [
      {
        version: '0.4',
        name: 'synthetic',
        axes: ['z', 'y', 'x'].map((name) => ({
          name,
          type: 'space',
          unit: 'millimeter',
        })),
        datasets: store.levels.map(({ scale, translation }, i) => ({
          path: String(i),
          coordinateTransformations: [
            { type: 'scale', scale },
            { type: 'translation', translation },
          ],
        })),
      },
    ],
  })
}

function zarray(shape: number[]) {
  return json({
    zarr_format: 2,
    shape,
    chunks: [CHUNK, CHUNK, CHUNK],
    dtype: '<f4',
    compressor: null,
    filters: null,
    fill_value: 0,
    order: 'C',
    dimension_separator: '/',
  })
}

/** One full 64^3 chunk at chunk index [z, y, x], x fastest. Voxels past the array edge are 0. */
function syntheticChunk(
  store: Store,
  level: number,
  chunk: number[],
): Float32Array {
  const { shape, scale, translation } = store.levels[level]
  const out = new Float32Array(CHUNK ** 3)
  // Per-axis voxel-centre positions (mm) and ellipsoid-normalized offsets.
  const valid = shape.map((n, a) => Math.min(CHUNK, n - chunk[a] * CHUNK))
  const mm = shape.map((_, a) =>
    Float32Array.from(
      { length: CHUNK },
      (_, i) => translation[a] + scale[a] * (chunk[a] * CHUNK + i),
    ),
  )
  const radius = store.extent.map((e) => 0.45 * e)
  const minRadius = Math.min(...radius)
  const unit = mm.map((p, a) =>
    p.map((v) => (v - (store.extent[a] - BASE_SPACING_MM) / 2) / radius[a]),
  )
  const coarsest = Math.max(...scale)
  const octaves = store.wavelengths.flatMap((wavelength, k) => {
    if (wavelength < 2 * coarsest) return []
    const f = (2 * Math.PI) / wavelength
    // Per-octave, per-axis phases break the gyroid's alignment across octaves.
    const axis = (a: number, phase: number) => [
      mm[a].map((v) => Math.sin(f * v + phase)),
      mm[a].map((v) => Math.cos(f * v + phase)),
    ]
    // Arbitrary phase steps, not e: changing them changes every chunk.
    // biome-ignore lint/suspicious/noApproximativeNumericConstant: a phase, not e
    const [sz, czs] = axis(0, k * 2.718)
    const [sy, cys] = axis(1, k * 1.618)
    const [sx, cxs] = axis(2, k * 0.618)
    return [{ a: store.amplitudes[k], sx, cxs, sy, cys, sz, czs }]
  })
  const amplitudeSum = store.amplitudes.reduce((a, b) => a + b, 0)
  for (let z = 0; z < valid[0]; z++) {
    for (let y = 0; y < valid[1]; y++) {
      const row = (z * CHUNK + y) * CHUNK
      for (let x = 0; x < valid[2]; x++) {
        const r = Math.sqrt(unit[0][z] ** 2 + unit[1][y] ** 2 + unit[2][x] ** 2)
        const mask = Math.min(1, Math.max(0, ((1 - r) * minRadius) / EDGE_MM))
        if (mask === 0) continue
        let sum = 0
        for (const o of octaves) {
          sum +=
            o.a * (o.sx[x] * o.cys[y] + o.sy[y] * o.czs[z] + o.sz[z] * o.cxs[x])
        }
        // Clipping at 0 leaves the lattice open, so the 3D render has structure.
        out[row + x] = mask * Math.max(0, sum / amplitudeSum)
      }
    }
  }
  return out
}

/**
 * Bytes for a path under {@link SYNTHETIC_ZARR_ROOT}, such as
 * 'synthetic-v1.ome.zarr/0/1/2/3', or null for a miss.
 */
export function syntheticZarrFile(path: string): Uint8Array | null {
  const [dir, ...parts] = path.split('/')
  const store = stores.get(dir.replace(/\.ome\.zarr$/, ''))
  if (!store) return null
  const key = parts.join('/')
  if (key === '.zgroup') return json({ zarr_format: 2 })
  if (key === '.zattrs') return zattrs(store)
  const level = parts[0] === '' ? undefined : store.levels[Number(parts[0])]
  if (!level) return null
  if (parts.length === 2 && parts[1] === '.zarray') return zarray(level.shape)
  if (parts.length !== 4) return null
  const chunk = parts.slice(1).map(Number)
  const inside = chunk.every(
    (c, a) =>
      Number.isInteger(c) && c >= 0 && c < Math.ceil(level.shape[a] / CHUNK),
  )
  if (!inside) return null
  return new Uint8Array(syntheticChunk(store, Number(parts[0]), chunk).buffer)
}
