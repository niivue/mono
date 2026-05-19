// Client-side generated NIfTI overlay paired with the server's
// synthetic.nii.gz fixture. Same dimensions (64^3), spacing (2 mm) and
// sform-centered world origin so the cube + overlay scene AABB stays
// symmetric. Content is a soft spherical shell at radius 22 voxels
// (44 mm), visually distinct from the cube's Gaussian blob.

const SX = 64
const SY = 64
const SZ = 64
const SPACING = 2.0
const CX = (SX - 1) / 2
const CY = (SY - 1) / 2
const CZ = (SZ - 1) / 2

// ID the server assigns the matching cube fixture (registry strips
// the .nii.gz extension).
export const SYNTHETIC_VOLUME_ID = 'synthetic'

function makeShellData(): Float32Array {
  const data = new Float32Array(SX * SY * SZ)
  const r0 = 22
  const halfWidth = 2.0
  for (let z = 0; z < SZ; z++) {
    for (let y = 0; y < SY; y++) {
      for (let x = 0; x < SX; x++) {
        const dx = x - CX
        const dy = y - CY
        const dz = z - CZ
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const d = Math.abs(r - r0)
        if (d <= halfWidth) {
          data[x + y * SX + z * SX * SY] = 1 - d / halfWidth
        }
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
  view.setInt16(254, 1, true) // sform_code = 1
  view.setFloat32(280, SPACING, true)
  view.setFloat32(292, -SPACING * CX, true)
  view.setFloat32(300, SPACING, true)
  view.setFloat32(308, -SPACING * CY, true)
  view.setFloat32(320, SPACING, true)
  view.setFloat32(324, -SPACING * CZ, true)
  const magic = new Uint8Array(buf, 344, 4)
  magic[0] = 0x6e
  magic[1] = 0x2b
  magic[2] = 0x31
  magic[3] = 0x00
  return buf
}

let cachedUrl: string | null = null

export function getSyntheticOverlayUrl(): string {
  if (cachedUrl) return cachedUrl
  const data = makeShellData()
  const header = makeHeader()
  const out = new Uint8Array(352 + data.byteLength)
  out.set(new Uint8Array(header), 0)
  out.set(new Uint8Array(data.buffer), 352)
  const blob = new Blob([out], { type: 'application/x.nifti' })
  cachedUrl = URL.createObjectURL(blob)
  return cachedUrl
}
