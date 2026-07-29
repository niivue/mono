import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

type Shape3 = readonly [number, number, number]

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../public/range-poc')

const SHAPE: Shape3 = [96, 96, 96]
const SPACING: Shape3 = [1, 1, 1]
const CHUNK_GRID: Shape3 = [4, 4, 4]
const CHUNK_SHAPE: Shape3 = [24, 24, 24]
const CHUNK_BYTES = CHUNK_SHAPE[0] * CHUNK_SHAPE[1] * CHUNK_SHAPE[2]

function gaussian(dx: number, dy: number, dz: number, sigma: number): number {
  return Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * sigma * sigma))
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function voxelValue(x: number, y: number, z: number): number {
  const nx = (x / (SHAPE[0] - 1)) * 2 - 1
  const ny = (y / (SHAPE[1] - 1)) * 2 - 1
  const nz = (z / (SHAPE[2] - 1)) * 2 - 1
  const ellipsoid = Math.sqrt(
    (nx * nx) / 0.82 + (ny * ny) / 0.58 + (nz * nz) / 0.92,
  )
  const core = 134 * Math.max(0, 1 - ellipsoid)
  const shell = 58 * Math.max(0, 1 - Math.abs(ellipsoid - 0.72) * 10)
  const ridge =
    14 *
    (Math.sin((nx * 2.6 + ny * 1.4) * Math.PI) +
      Math.cos((nz * 3.2 - nx * 0.7) * Math.PI))
  const hotSpot = 92 * gaussian(nx - 0.32, ny + 0.2, nz - 0.08, 0.13)
  const coolPocket = 80 * gaussian(nx + 0.16, ny - 0.04, nz + 0.2, 0.16)
  const fineTexture =
    9 * Math.sin((x * 0.37 + y * 0.19 + z * 0.11) * Math.PI * 0.5)
  return clampByte(
    18 + core + shell + ridge + hotSpot - coolPocket + fineTexture,
  )
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  const shard = new Uint8Array(
    CHUNK_GRID[0] * CHUNK_GRID[1] * CHUNK_GRID[2] * CHUNK_BYTES,
  )
  let ptr = 0
  for (let cz = 0; cz < CHUNK_GRID[2]; cz++) {
    for (let cy = 0; cy < CHUNK_GRID[1]; cy++) {
      for (let cx = 0; cx < CHUNK_GRID[0]; cx++) {
        const ox = cx * CHUNK_SHAPE[0]
        const oy = cy * CHUNK_SHAPE[1]
        const oz = cz * CHUNK_SHAPE[2]
        for (let z = 0; z < CHUNK_SHAPE[2]; z++) {
          for (let y = 0; y < CHUNK_SHAPE[1]; y++) {
            for (let x = 0; x < CHUNK_SHAPE[0]; x++) {
              shard[ptr] = voxelValue(ox + x, oy + y, oz + z)
              ptr++
            }
          }
        }
      }
    }
  }

  const manifest = {
    id: 'synthetic-range-shard-v1',
    name: 'Synthetic HTTP Range shard',
    description:
      'Chunk-major uint8 scalar volume used by range.html to demonstrate client-side HTTP Range chunk loading.',
    shape: SHAPE,
    spacing: SPACING,
    dtype: 'uint8',
    chunkGrid: CHUNK_GRID,
    chunkShape: CHUNK_SHAPE,
    chunkBytes: CHUNK_BYTES,
    chunkCount: CHUNK_GRID[0] * CHUNK_GRID[1] * CHUNK_GRID[2],
    byteLength: shard.byteLength,
    dataUrl: 'synthetic-volume.bin',
    order: 'chunk-major-z-y-x, voxel-major-z-y-x',
  }

  await writeFile(path.join(OUT_DIR, 'synthetic-volume.bin'), shard)
  await writeFile(
    path.join(OUT_DIR, 'synthetic-volume.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
