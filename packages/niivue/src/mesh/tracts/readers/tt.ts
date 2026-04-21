import { readMatV4 } from "@/codecs/NVMatlab"
import type { NVTractData } from "@/NVTypes"

export const extensions = ["TT"]

/**
 * Read DSI-Studio TinyTrack (.tt / .tt.gz) format.
 * https://dsi-studio.labsolver.org/doc/cli_data.html
 *
 * The file is a MATLAB V4 container with three required fields:
 *   - trans_to_mni: 4x4 affine (column-major, 16 floats)
 *   - voxel_size: 3 floats
 *   - track: delta-encoded streamline data
 *
 * Track encoding: each streamline starts with a uint32 byte count,
 * followed by the first point as 3 x int32, then subsequent points
 * as 3 x int8 deltas. All coordinates are scaled by 1/32 to get
 * voxel coordinates, then transformed by trans_to_mni to mm space.
 */
export async function read(buffer: ArrayBufferLike): Promise<NVTractData> {
  const mat = await readMatV4(buffer as ArrayBuffer)
  if (!("trans_to_mni" in mat)) {
    throw new Error("TT format file must have 'trans_to_mni'")
  }
  if (!("voxel_size" in mat)) {
    throw new Error("TT format file must have 'voxel_size'")
  }
  if (!("track" in mat)) {
    throw new Error("TT format file must have 'track'")
  }

  // Build row-major 4x4 transform matrix.
  // The original gl-matrix code does fromValues(m[0..15]) then transpose,
  // which makes m[0..3] the first row of the transform. Use indices directly.
  const m = mat.trans_to_mni
  const t0 = m[0],
    t1 = m[1],
    t2 = m[2],
    t3 = m[3]
  const t4 = m[4],
    t5 = m[5],
    t6 = m[6],
    t7 = m[7]
  const t8 = m[8],
    t9 = m[9],
    t10 = m[10],
    t11 = m[11]

  // Parse delta-encoded track data
  const track = mat.track
  const dv = new DataView(track.buffer, track.byteOffset, track.byteLength)
  const trackLen = track.length

  // First pass: count streamlines and total vertices
  let nStreamlines = 0
  let totalVerts = 0
  let i = 0
  while (i < trackLen) {
    const byteCount = dv.getUint32(i, true)
    const nPts = byteCount / 3 // each point after the first is 3 int8 deltas
    totalVerts += nPts
    nStreamlines++
    i += byteCount + 13 // 4 (uint32 size) + 12 (first point as 3xint32) - 3 (first point counted in nPts)
  }

  // Allocate output arrays
  const vertices = new Float32Array(totalVerts * 3)
  const offsets = new Uint32Array(nStreamlines + 1) // fence-post

  // Second pass: decode streamlines
  i = 0
  let streamIdx = 0
  let vertIdx = 0

  while (i < trackLen) {
    offsets[streamIdx] = vertIdx / 3

    const byteCount = dv.getUint32(i, true)
    const nPts = byteCount / 3
    i += 4

    // First point: 3 x int32
    let x = dv.getInt32(i, true)
    i += 4
    let y = dv.getInt32(i, true)
    i += 4
    let z = dv.getInt32(i, true)
    i += 4

    vertices[vertIdx++] = x
    vertices[vertIdx++] = y
    vertices[vertIdx++] = z

    // Subsequent points: 3 x int8 deltas
    for (let j = 2; j <= nPts; j++) {
      x += dv.getInt8(i++)
      y += dv.getInt8(i++)
      z += dv.getInt8(i++)
      vertices[vertIdx++] = x
      vertices[vertIdx++] = y
      vertices[vertIdx++] = z
    }

    streamIdx++
  }

  // Final fence-post offset
  offsets[streamIdx] = vertIdx / 3

  // Scale from encoded units to voxel space (divide by 32)
  for (let k = 0; k < vertIdx; k++) {
    vertices[k] /= 32.0
  }

  // Transform from voxel space to MNI mm space using trans_to_mni
  let v = 0
  for (let k = 0; k < vertIdx / 3; k++) {
    const vx = vertices[v]
    const vy = vertices[v + 1]
    const vz = vertices[v + 2]
    vertices[v] = vx * t0 + vy * t1 + vz * t2 + t3
    vertices[v + 1] = vx * t4 + vy * t5 + vz * t6 + t7
    vertices[v + 2] = vx * t8 + vy * t9 + vz * t10 + t11
    v += 3
  }

  return {
    vertices,
    offsets,
    dpv: {},
    dps: {},
    groups: {},
    dpvMeta: {},
    dpsMeta: {},
  }
}
