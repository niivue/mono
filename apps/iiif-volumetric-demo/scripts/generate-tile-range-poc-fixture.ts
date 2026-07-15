import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../public/tile-range-poc')

const BASE_WIDTH = 1536
const BASE_HEIGHT = 1024
const TILE_SIZE = 256
const LEVEL_COUNT = 4

interface TileManifestEntry {
  x: number
  y: number
  width: number
  height: number
  offset: number
  length: number
}

interface TileLevelManifest {
  index: number
  width: number
  height: number
  downsample: number
  columns: number
  rows: number
  tiles: TileManifestEntry[]
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function levelSize(size: number, level: number): number {
  return Math.max(1, Math.round(size / 2 ** level))
}

function gaussian(dx: number, dy: number, sigma: number): number {
  return Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
}

function tissuePixel(
  levelX: number,
  levelY: number,
  downsample: number,
): readonly [number, number, number] {
  const baseX = (levelX + 0.5) * downsample
  const baseY = (levelY + 0.5) * downsample
  const nx = baseX / (BASE_WIDTH - 1)
  const ny = baseY / (BASE_HEIGHT - 1)
  const cx = nx - 0.5
  const cy = ny - 0.52
  const ellipse = Math.sqrt((cx * cx) / 0.22 + (cy * cy) / 0.31)
  const mask = Math.max(0, 1 - ellipse)
  const ridge =
    0.5 +
    0.5 *
      Math.sin(
        38 * Math.sqrt((nx - 0.37) ** 2 + (ny - 0.58) ** 2) +
          7 * Math.sin(ny * 8.5),
      )
  const fiber =
    0.5 + 0.5 * Math.sin(nx * 34 + ny * 19 + 2.5 * Math.sin((nx + ny) * 8))
  const warmSpot = gaussian(nx - 0.72, ny - 0.28, 0.12)
  const coolSpot = gaussian(nx - 0.28, ny - 0.73, 0.16)
  const edge = Math.max(0, 1 - Math.abs(ellipse - 0.77) * 16)
  const grid =
    levelX % TILE_SIZE < 2 ||
    levelY % TILE_SIZE < 2 ||
    levelX === 0 ||
    levelY === 0
      ? 1
      : 0

  const base = 18 + 165 * mask
  const red = base + 52 * ridge + 38 * warmSpot + 18 * edge + 30 * grid
  const green = 35 + 112 * mask + 58 * fiber + 26 * edge - 22 * warmSpot
  const blue = 44 + 98 * mask + 78 * coolSpot + 32 * (1 - ridge) - 18 * grid

  return [clampByte(red), clampByte(green), clampByte(blue)]
}

function makeTile(
  levelIndex: number,
  tileX: number,
  tileY: number,
  width: number,
  height: number,
): Uint8Array {
  const downsample = 2 ** levelIndex
  const rgba = new Uint8Array(width * height * 4)
  let ptr = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = tissuePixel(
        tileX * TILE_SIZE + x,
        tileY * TILE_SIZE + y,
        downsample,
      )
      rgba[ptr] = red
      rgba[ptr + 1] = green
      rgba[ptr + 2] = blue
      rgba[ptr + 3] = 255
      ptr += 4
    }
  }
  return rgba
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  const parts: Uint8Array[] = []
  const levels: TileLevelManifest[] = []
  let byteLength = 0

  for (let levelIndex = 0; levelIndex < LEVEL_COUNT; levelIndex++) {
    const width = levelSize(BASE_WIDTH, levelIndex)
    const height = levelSize(BASE_HEIGHT, levelIndex)
    const columns = Math.ceil(width / TILE_SIZE)
    const rows = Math.ceil(height / TILE_SIZE)
    const tiles: TileManifestEntry[] = []

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const tileWidth = Math.min(TILE_SIZE, width - x * TILE_SIZE)
        const tileHeight = Math.min(TILE_SIZE, height - y * TILE_SIZE)
        const tile = makeTile(levelIndex, x, y, tileWidth, tileHeight)
        tiles.push({
          x,
          y,
          width: tileWidth,
          height: tileHeight,
          offset: byteLength,
          length: tile.byteLength,
        })
        byteLength += tile.byteLength
        parts.push(tile)
      }
    }

    levels.push({
      index: levelIndex,
      width,
      height,
      downsample: 2 ** levelIndex,
      columns,
      rows,
      tiles,
    })
  }

  const shard = new Uint8Array(byteLength)
  let ptr = 0
  for (const part of parts) {
    shard.set(part, ptr)
    ptr += part.byteLength
  }

  const manifest = {
    id: 'synthetic-tile-range-shard-v1',
    name: 'Synthetic HTTP Range tile pyramid',
    description:
      'Multiscale RGBA tile pyramid used by tile-range.html to demonstrate client-only HTTP Range tile loading.',
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    tileSize: TILE_SIZE,
    dtype: 'uint8',
    channels: 'rgba',
    bytesPerPixel: 4,
    byteLength,
    dataUrl: 'tiles.bin',
    order: 'level-major, tile-row-major, rgba',
    levels,
  }

  await writeFile(path.join(OUT_DIR, 'tiles.bin'), shard)
  await writeFile(
    path.join(OUT_DIR, 'tiles.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
