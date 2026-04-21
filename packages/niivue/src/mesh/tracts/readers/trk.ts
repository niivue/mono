import * as NVGz from '@/codecs/NVGz'
import { log } from '@/logger'
import type { NVTractData } from '@/NVTypes'

export const extensions = ['TRK']

/**
 * Read TrackVis TRK format.
 * http://trackvis.org/docs/?subsect=fileformat
 *
 * Points are in voxel space; transformed to mm via vox_to_ras matrix.
 * Supports per-vertex scalars (dpv) and per-streamline properties (dps).
 */
export async function read(buffer: ArrayBufferLike): Promise<NVTractData> {
  // Handle gzip-compressed TRK files
  buffer = await NVGz.maybeDecompress(buffer)
  const reader = new DataView(buffer as ArrayBuffer)
  const magic = reader.getUint32(0, true)
  if (magic !== 1128354388) {
    throw new Error(
      `Not a valid TRK file, expected signature 'TRAC' 1128354388 not ${magic}`,
    )
  }
  const vers = reader.getUint32(992, true)
  const hdr_sz = reader.getUint32(996, true)
  if (vers > 3 || hdr_sz !== 1000) {
    throw new Error(
      `Not a valid TRK file, expected version 3 or earlier with header size 1000, not version ${vers} size ${hdr_sz}`,
    )
  }

  // Read per-vertex scalar names (n_scalars at offset 36)
  const n_scalars = reader.getInt16(36, true)
  const dpvNames: string[] = []
  for (let i = 0; i < n_scalars; i++) {
    const arr = new Uint8Array(buffer.slice(38 + i * 20, 58 + i * 20))
    const name = new TextDecoder().decode(arr).split('\0')[0].trim()
    dpvNames.push(name || `scalar_${i}`)
  }

  // Read per-streamline property names (n_properties at offset 238)
  const n_properties = reader.getInt16(238, true)
  const dpsNames: string[] = []
  for (let i = 0; i < n_properties; i++) {
    const arr = new Uint8Array(buffer.slice(240 + i * 20, 260 + i * 20))
    const name = new TextDecoder().decode(arr).split('\0')[0].trim()
    dpsNames.push(name || `property_${i}`)
  }

  // Build vox→mm transformation matrix
  // zoomMat: scale by 1/voxel_size, offset by -0.5
  const vsx = reader.getFloat32(12, true)
  const vsy = reader.getFloat32(16, true)
  const vsz = reader.getFloat32(20, true)
  // zoomMat is column-major: [1/vsx, 0, 0, 0, 0, 1/vsy, 0, 0, 0, 0, 1/vsz, 0, -0.5, -0.5, -0.5, 1]
  // But the reference code treats it as row-major with mat4.fromValues
  // The actual multiplication is: out = vox2ras @ zoom @ point
  // Let's build it the same way as the reference code

  // Read vox_to_ras 4x4 matrix (16 floats at offset 440)
  const vox2ras = new Float32Array(16)
  for (let i = 0; i < 16; i++) {
    vox2ras[i] = reader.getFloat32(440 + i * 4, true)
  }
  if (vox2ras[15] === 0.0) {
    log.warn('TRK vox_to_ras not set, using identity')
    vox2ras[0] = 1
    vox2ras[5] = 1
    vox2ras[10] = 1
    vox2ras[15] = 1
  }

  // Combined transform: multiply zoomMat (row-major) by vox2ras (row-major)
  // zoomMat rows: [1/vsx, 0, 0, -0.5], [0, 1/vsy, 0, -0.5], [0, 0, 1/vsz, -0.5], [0, 0, 0, 1]
  // Result M = zoomMat * vox2ras, then point_mm = M * point_vox
  const m = new Float32Array(16)
  const z0 = 1 / vsx,
    z5 = 1 / vsy,
    z10 = 1 / vsz,
    zt = -0.5
  // Row 0: z0*vox2ras[0..3] + zt*vox2ras[12..15]
  m[0] = z0 * vox2ras[0] + zt * vox2ras[12]
  m[1] = z0 * vox2ras[1] + zt * vox2ras[13]
  m[2] = z0 * vox2ras[2] + zt * vox2ras[14]
  m[3] = z0 * vox2ras[3] + zt * vox2ras[15]
  // Row 1
  m[4] = z5 * vox2ras[4] + zt * vox2ras[12]
  m[5] = z5 * vox2ras[5] + zt * vox2ras[13]
  m[6] = z5 * vox2ras[6] + zt * vox2ras[14]
  m[7] = z5 * vox2ras[7] + zt * vox2ras[15]
  // Row 2
  m[8] = z10 * vox2ras[8] + zt * vox2ras[12]
  m[9] = z10 * vox2ras[9] + zt * vox2ras[13]
  m[10] = z10 * vox2ras[10] + zt * vox2ras[14]
  m[11] = z10 * vox2ras[11] + zt * vox2ras[15]
  // Row 3
  m[12] = vox2ras[12]
  m[13] = vox2ras[13]
  m[14] = vox2ras[14]
  m[15] = vox2ras[15]

  // Parse streamline data
  const i32 = new Int32Array(buffer.slice(hdr_sz))
  const f32 = new Float32Array(i32.buffer)
  const ntracks = i32.length
  if (ntracks < 1) throw new Error('Empty TRK file')

  // Over-provision arrays
  let vertices = new Float32Array(ntracks)
  let offsets = new Uint32Array(ntracks / 4)
  let npt = 0
  let npt3 = 0
  let noffset = 0

  // Temporary arrays for scalars (converted to Float32Array after)
  const dpvVals: number[][] = dpvNames.map(() => [])
  const dpsVals: number[][] = dpsNames.map(() => [])

  let idx = 0
  while (idx < ntracks) {
    const n_pts = i32[idx]
    idx++
    if (!Number.isFinite(n_pts) || n_pts < 1) break

    offsets[noffset++] = npt

    for (let j = 0; j < n_pts; j++) {
      const px = f32[idx],
        py = f32[idx + 1],
        pz = f32[idx + 2]
      idx += 3
      // Transform voxel → mm
      vertices[npt3++] = px * m[0] + py * m[1] + pz * m[2] + m[3]
      vertices[npt3++] = px * m[4] + py * m[5] + pz * m[6] + m[7]
      vertices[npt3++] = px * m[8] + py * m[9] + pz * m[10] + m[11]
      // Per-vertex scalars
      for (let s = 0; s < n_scalars; s++) {
        dpvVals[s].push(f32[idx])
        idx++
      }
      npt++
    }
    // Per-streamline properties
    for (let s = 0; s < n_properties; s++) {
      dpsVals[s].push(f32[idx])
      idx++
    }
  }

  // Fence-post: final offset
  offsets[noffset++] = npt

  // Trim arrays
  vertices = vertices.slice(0, npt3)
  offsets = offsets.slice(0, noffset)

  // Convert scalar arrays to Record<string, Float32Array>
  const dpv: Record<string, Float32Array> = {}
  for (let i = 0; i < dpvNames.length; i++) {
    dpv[dpvNames[i]] = Float32Array.from(dpvVals[i])
  }
  const dps: Record<string, Float32Array> = {}
  for (let i = 0; i < dpsNames.length; i++) {
    dps[dpsNames[i]] = Float32Array.from(dpsVals[i])
  }

  return { vertices, offsets, dpv, dps, groups: {}, dpvMeta: {}, dpsMeta: {} }
}
