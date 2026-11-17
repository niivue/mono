// Specialized quantification loops vs a naive general loop (per-voxel op
// switch, per-voxel scaling and index math). `bun bench/quant.bench.ts`
import { computeVolume, timeActivity } from '../src/kinetics'
import {
  boxAround,
  type RasGrid,
  type Sampled,
  segmentStats,
  thresholdBox,
} from '../src/quantify'

const time = (name: string, fn: () => unknown) => {
  fn()
  const t = performance.now()
  for (let i = 0; i < 5; i++) fn()
  console.log(`${name}: ${((performance.now() - t) / 5).toFixed(1)} ms`)
}
const timeAsync = async (name: string, fn: () => Promise<unknown>) => {
  await fn()
  const t = performance.now()
  for (let i = 0; i < 5; i++) await fn()
  console.log(`${name}: ${((performance.now() - t) / 5).toFixed(1)} ms`)
}

// D6-size PT: 200x200x135, x flipped in native order.
const [nx, ny, nz] = [200, 200, 135]
const n = nx * ny * nz
const grid: RasGrid = {
  dims: [nx, ny, nz],
  start: nx - 1,
  step: [-1, nx, nx * ny],
  affine: [4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 3, 0],
}
const raw = Int16Array.from({ length: n }, (_, i) => (i * 7919) % 30000)
const pt: Sampled = { data: raw, grid, slope: 0.001, inter: 0 }
const box = boxAround(
  [
    [0, 0, 0],
    [799, 799, 404],
  ],
  grid,
)
const label = new Uint8Array(n)

function naiveThreshold(lower: number, upper: number) {
  label.fill(0)
  for (let z = box[4]; z <= box[5]; z++)
    for (let y = box[2]; y <= box[3]; y++)
      for (let x = box[0]; x <= box[1]; x++) {
        const native =
          grid.start + x * grid.step[0] + y * grid.step[1] + z * grid.step[2]
        const v = (raw[native] as number) * pt.slope + pt.inter
        if (v > lower && v < upper) label[(z * ny + y) * nx + x] = 1
      }
}
time('threshold naive (5.4M vox)', () => naiveThreshold(10, 25))
time('threshold specialized (5.4M vox)', () =>
  thresholdBox(label, pt, box, 10, 25, 1),
)
const ct = { ct: pt, lower: 0, upper: 20 }
time('threshold + CT range (5.4M vox)', () =>
  thresholdBox(label, pt, box, 10, 25, 1, ct),
)
label.fill(1)
time('segmentStats incl. SUVpeak scan (5.4M vox)', () =>
  segmentStats(label, pt, 1),
)

// D2-size 4D: 1M voxels x 40 frames.
const fn = 40
const fv = 1 << 20
const store = Array.from({ length: fn }, (_, f) =>
  Int16Array.from({ length: fv }, (_, i) => (i + f * 31) % 4000),
)
const frames = { count: fn, load: async (f: number) => store[f] as Int16Array }

async function naiveCompute(op: string, start: number, end: number) {
  const out = new Float32Array(fv)
  for (let f = start; f <= end; f++) {
    const d = await frames.load(f - 1)
    for (let i = 0; i < fv; i++) {
      const v = (d[i] as number) * 0.5 + 1
      if (op === 'SUM' || op === 'AVERAGE') out[i] = (out[i] as number) + v
    }
  }
  if (op === 'AVERAGE')
    for (let i = 0; i < fv; i++) out[i] = (out[i] as number) / (end - start + 1)
  return out
}
await timeAsync('SUM naive (1M x 40)', () => naiveCompute('SUM', 1, fn))
await timeAsync('SUM specialized (1M x 40)', () =>
  computeVolume('SUM', frames, 1, fn, 0.5, 1),
)

const mask = new Uint8Array(fv)
for (let i = 0; i < fv; i += 7) mask[i] = 1 + (i % 3)
const g4: RasGrid = {
  dims: [128, 128, 64],
  start: 0,
  step: [1, 128, 128 * 128],
  affine: grid.affine,
}
async function naiveTac() {
  const means: number[][] = [[], [], [], []]
  for (let f = 0; f < fn; f++) {
    const d = await frames.load(f)
    const sum = [0, 0, 0, 0]
    const cnt = [0, 0, 0, 0]
    for (let i = 0; i < fv; i++) {
      const v = mask[i] as number
      if (!v) continue
      sum[v] = (sum[v] as number) + (d[i] as number) * 0.5 + 1
      cnt[v] = (cnt[v] as number) + 1
    }
    for (let v = 1; v < 4; v++)
      means[v]?.push((sum[v] as number) / (cnt[v] as number))
  }
  return means
}
await timeAsync('TAC naive (1M x 40, 3 labels)', naiveTac)
await timeAsync('TAC specialized (1M x 40, 3 labels)', () =>
  timeActivity(mask, g4, frames, 0.5, 1),
)
