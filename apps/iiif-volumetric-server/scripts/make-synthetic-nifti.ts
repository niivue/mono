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
const SPACING = 2.0

// Voxel-center coordinates that map to world (0,0,0). For a volume of length
// N along an axis, the geometric center sits at (N-1)/2, so the Gaussian blob
// and the sform offset use the same value and the volume renders centered on
// the world origin instead of in the +X/+Y/+Z octant.
const CX = (SX - 1) / 2
const CY = (SY - 1) / 2
const CZ = (SZ - 1) / 2

function makeData(): Float32Array {
  const data = new Float32Array(SX * SY * SZ)
  for (let z = 0; z < SZ; z++) {
    for (let y = 0; y < SY; y++) {
      for (let x = 0; x < SX; x++) {
        const dx = x - CX
        const dy = y - CY
        const dz = z - CZ
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
  view.setFloat32(80, SPACING, true)
  view.setFloat32(84, SPACING, true)
  view.setFloat32(88, SPACING, true)
  view.setFloat32(108, 352, true)

  // sform = identity scale × SPACING with translation so that the geometric
  // center voxel (CX, CY, CZ) maps to world (0, 0, 0). Without this the
  // synthetic cube sits with one corner at the origin and looks off-center
  // next to real T1w fixtures that follow the MNI convention.
  view.setInt16(254, 1, true) // sform_code = 1 (NIFTI_XFORM_SCANNER_ANAT)
  view.setFloat32(280, SPACING, true) // srow_x[0]
  view.setFloat32(284, 0, true)
  view.setFloat32(288, 0, true)
  view.setFloat32(292, -SPACING * CX, true) // qoffset_x via srow_x[3]
  view.setFloat32(296, 0, true)
  view.setFloat32(300, SPACING, true) // srow_y[1]
  view.setFloat32(304, 0, true)
  view.setFloat32(308, -SPACING * CY, true)
  view.setFloat32(312, 0, true)
  view.setFloat32(316, 0, true)
  view.setFloat32(320, SPACING, true) // srow_z[2]
  view.setFloat32(324, -SPACING * CZ, true)

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
