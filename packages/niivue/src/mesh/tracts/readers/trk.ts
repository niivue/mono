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

  const vsx = reader.getFloat32(12, true)
  const vsy = reader.getFloat32(16, true)
  const vsz = reader.getFloat32(20, true)

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

  // Points are voxmm with the origin at a voxel corner (TrackVis), so
  // mm = vox_to_ras · (p / voxel_size − 0.5), i.e. m = vox_to_ras · zoom.
  const zoom = [1 / vsx, 1 / vsy, 1 / vsz]
  const m = new Float32Array(16)
  for (let r = 0; r < 16; r += 4) {
    m[r] = vox2ras[r] * zoom[0]
    m[r + 1] = vox2ras[r + 1] * zoom[1]
    m[r + 2] = vox2ras[r + 2] * zoom[2]
    m[r + 3] =
      vox2ras[r + 3] - 0.5 * (vox2ras[r] + vox2ras[r + 1] + vox2ras[r + 2])
  }

  // Parse streamline data: views on the original buffer, no copy
  const nWords = (buffer.byteLength - hdr_sz) >> 2
  if (nWords < 1) throw new Error('Empty TRK file')
  const i32 = new Int32Array(buffer, hdr_sz, nWords)
  const f32 = new Float32Array(buffer, hdr_sz, nWords)

  // Pass 1: count streamlines and points for exact allocation
  let nStreamlines = 0
  let nPoints = 0
  let idx = 0
  while (idx < nWords) {
    const n_pts = i32[idx]
    if (n_pts < 1) break
    const next = idx + 1 + n_pts * (3 + n_scalars) + n_properties
    if (next > nWords) break
    nStreamlines++
    nPoints += n_pts
    idx = next
  }
  const nWordsValid = idx

  const vertices = new Float32Array(nPoints * 3)
  const offsets = new Uint32Array(nStreamlines + 1)
  const dpvVals = dpvNames.map(() => new Float32Array(nPoints))
  const dpsVals = dpsNames.map(() => new Float32Array(nStreamlines))

  // Pass 2: read
  let npt = 0
  let npt3 = 0
  let noffset = 0
  idx = 0
  while (idx < nWordsValid) {
    const n_pts = i32[idx]
    idx++
    offsets[noffset] = npt
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
        dpvVals[s][npt] = f32[idx++]
      }
      npt++
    }
    // Per-streamline properties
    for (let s = 0; s < n_properties; s++) {
      dpsVals[s][noffset] = f32[idx++]
    }
    noffset++
  }

  // Fence-post: final offset
  offsets[noffset] = npt

  // Names come from the file, so a scalar called `__proto__` must stay an own key.
  const dpv: Record<string, Float32Array> = Object.create(null)
  for (let i = 0; i < dpvNames.length; i++) {
    dpv[dpvNames[i]] = dpvVals[i]
  }
  const dps: Record<string, Float32Array> = Object.create(null)
  for (let i = 0; i < dpsNames.length; i++) {
    dps[dpsNames[i]] = dpsVals[i]
  }

  return { vertices, offsets, dpv, dps, groups: {}, dpvMeta: {}, dpsMeta: {} }
}
