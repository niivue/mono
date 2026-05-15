// Generate a small synthetic NIfTI volume for end-to-end testing.
// Writes fixtures/synthetic.nii.gz containing a 64^3 Float32 volume
// shaped like a Gaussian blob plus a sinusoidal grid, so all three
// orthogonal slices look distinct.

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import { gzipSync } from 'node:zlib'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '..', 'fixtures', 'synthetic.nii.gz')

const SX = 64
const SY = 64
const SZ = 64

function makeData(): Float32Array {
  const data = new Float32Array(SX * SY * SZ)
  const cx = SX / 2
  const cy = SY / 2
  const cz = SZ / 2
  for (let z = 0; z < SZ; z++) {
    for (let y = 0; y < SY; y++) {
      for (let x = 0; x < SX; x++) {
        const dx = x - cx
        const dy = y - cy
        const dz = z - cz
        const r2 = dx * dx + dy * dy + dz * dz
        const blob = Math.exp(-r2 / (2 * 14 * 14))
        const grid =
          0.15 * (Math.sin(x / 3) + Math.sin(y / 3) + Math.sin(z / 3))
        data[x + y * SX + z * SX * SY] = blob + grid
      }
    }
  }
  return data
}

function makeHeader(): ArrayBuffer {
  const buf = new ArrayBuffer(352)
  const view = new DataView(buf)
  view.setInt32(0, 348, true)
  view.setInt16(40, 3, true)
  view.setInt16(42, SX, true)
  view.setInt16(44, SY, true)
  view.setInt16(46, SZ, true)
  view.setInt16(48, 1, true)
  view.setInt16(50, 1, true)
  view.setInt16(52, 1, true)
  view.setInt16(54, 1, true)
  view.setInt16(70, 16, true) // datatype 16 = float32
  view.setInt16(72, 32, true)
  view.setFloat32(76, 1, true)
  view.setFloat32(80, 2.0, true)
  view.setFloat32(84, 2.0, true)
  view.setFloat32(88, 2.0, true)
  view.setFloat32(108, 352, true)
  const magic = new Uint8Array(buf, 344, 4)
  magic[0] = 0x6e
  magic[1] = 0x2b
  magic[2] = 0x31
  magic[3] = 0x00
  return buf
}

async function main(): Promise<void> {
  await fs.mkdir(path.dirname(OUT), { recursive: true })
  const data = makeData()
  const header = makeHeader()
  const out = Buffer.alloc(352 + data.byteLength)
  Buffer.from(header).copy(out, 0)
  Buffer.from(data.buffer).copy(out, 352)
  const gz = gzipSync(out)
  await fs.writeFile(OUT, gz)
  console.log(`Wrote ${OUT} (${gz.length} bytes, ${SX}x${SY}x${SZ} float32)`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
