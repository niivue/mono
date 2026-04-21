import { Zip } from '@/codecs/NVZip'
import { log } from '@/logger'
import type { NVTractData } from '@/NVTypes'

export const extensions = ['TRX']

/**
 * Decode a float16 (IEEE 754 half-precision) to float32.
 * https://stackoverflow.com/questions/5678432/decompressing-half-precision-floats-in-javascript
 */
function decodeFloat16(binary: number): number {
  const exponent = (binary & 0x7c00) >> 10
  const fraction = binary & 0x03ff
  return (
    (binary >> 15 ? -1 : 1) *
    (exponent
      ? exponent === 0x1f
        ? fraction
          ? NaN
          : Infinity
        : 2 ** (exponent - 15) * (1 + fraction / 0x400)
      : 6.103515625e-5 * (fraction / 0x400))
  )
}

/** Build a float16→float32 lookup table (64K entries, computed once). */
let float16Lut: Float32Array | null = null
function getFloat16Lut(): Float32Array {
  if (!float16Lut) {
    float16Lut = new Float32Array(65536)
    for (let i = 0; i < 65536; i++) {
      float16Lut[i] = decodeFloat16(i)
    }
  }
  return float16Lut
}

/**
 * Parse a typed array from raw bytes based on the filename's dtype suffix.
 * Returns Float32Array for all numeric types (converting as needed).
 */
function parseArray(
  fileName: string,
  data: Uint8Array,
): Float32Array | Uint32Array | null {
  if (fileName.endsWith('.float32')) {
    return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
  }
  if (fileName.endsWith('.float64')) {
    const f64 = new Float64Array(
      data.buffer,
      data.byteOffset,
      data.byteLength / 8,
    )
    return Float32Array.from(f64)
  }
  if (fileName.endsWith('.float16')) {
    const u16 = new Uint16Array(
      data.buffer,
      data.byteOffset,
      data.byteLength / 2,
    )
    const lut = getFloat16Lut()
    const out = new Float32Array(u16.length)
    for (let i = 0; i < u16.length; i++) out[i] = lut[u16[i]]
    return out
  }
  if (fileName.endsWith('.uint32')) {
    return new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4)
  }
  if (fileName.endsWith('.uint16')) {
    const u16 = new Uint16Array(
      data.buffer,
      data.byteOffset,
      data.byteLength / 2,
    )
    return Uint32Array.from(u16)
  }
  if (fileName.endsWith('.uint8')) {
    return Uint32Array.from(data)
  }
  if (fileName.endsWith('.int32')) {
    const i32 = new Int32Array(
      data.buffer,
      data.byteOffset,
      data.byteLength / 4,
    )
    return Float32Array.from(i32)
  }
  if (fileName.endsWith('.int16')) {
    const i16 = new Int16Array(
      data.buffer,
      data.byteOffset,
      data.byteLength / 2,
    )
    return Float32Array.from(i16)
  }
  if (fileName.endsWith('.int8')) {
    const i8 = new Int8Array(data.buffer, data.byteOffset, data.byteLength)
    return Float32Array.from(i8)
  }
  if (fileName.endsWith('.uint64') || fileName.endsWith('.int64')) {
    // JS lacks 64-bit ints; read lower 32 bits, warn on overflow
    const nval = data.byteLength / 8
    const u32 = new Uint32Array(data.buffer, data.byteOffset, nval * 2)
    const out = new Uint32Array(nval)
    for (let i = 0; i < nval; i++) {
      out[i] = u32[i * 2]
      if (u32[i * 2 + 1] !== 0) {
        throw new Error(
          'TRX 64-bit integer overflow: value exceeds 32-bit range',
        )
      }
    }
    return out
  }
  return null
}

/**
 * Read TRX format tractogram (ZIP-based).
 * https://github.com/tee-ar-ex/trx-spec/blob/master/specifications.md
 *
 * Coordinates are in mm space (no transform needed).
 * Supports per-vertex scalars (dpv), per-streamline properties (dps),
 * and per-group data (dpg) which is expanded to per-streamline.
 */
export async function read(buffer: ArrayBufferLike): Promise<NVTractData> {
  const zip = new Zip(buffer as ArrayBuffer)

  let vertices: Float32Array | null = null
  let rawOffsets: Uint32Array | null = null
  const dpv: Record<string, Float32Array> = {}
  const dps: Record<string, Float32Array> = {}
  const groups: { id: string; vals: Uint32Array }[] = []
  const dpgMap: Record<string, { id: string; vals: Float32Array }[]> = {}

  for (const entry of zip.entries) {
    if (entry.uncompressedSize === 0) continue

    const parts = entry.fileName.split('/')
    const fname = parts[parts.length - 1]
    if (fname.startsWith('.')) continue

    const pname = parts[parts.length - 2] ?? ''
    const dname = parts[parts.length - 3] ?? ''
    const tag = fname.split('.')[0]

    if (fname.includes('header.json')) {
      // Header is informational; we don't need it for geometry
      continue
    }

    const data = await entry.extract?.()
    if (!data) continue
    const arr = parseArray(fname, data)
    if (!arr) continue

    // Groups: my.trx/groups/name.uint32
    if (pname === 'groups') {
      groups.push({
        id: tag,
        vals: arr instanceof Uint32Array ? arr : Uint32Array.from(arr),
      })
      continue
    }

    // Data per group: my.trx/dpg/GroupName/scalar.float32
    if (dname === 'dpg') {
      const key = pname
      if (!dpgMap[key]) dpgMap[key] = []
      dpgMap[key].push({
        id: tag,
        vals: arr instanceof Float32Array ? arr : Float32Array.from(arr),
      })
      continue
    }

    // Data per vertex: my.trx/dpv/name.float32
    if (pname === 'dpv') {
      dpv[tag] = arr instanceof Float32Array ? arr : Float32Array.from(arr)
      continue
    }

    // Data per streamline: my.trx/dps/name.float32
    if (pname === 'dps') {
      dps[tag] = arr instanceof Float32Array ? arr : Float32Array.from(arr)
      continue
    }

    // Offsets: my.trx/offsets.uint64
    if (fname.startsWith('offsets.')) {
      rawOffsets = arr instanceof Uint32Array ? arr : Uint32Array.from(arr)
    }

    // Positions: my.trx/positions.3.float32
    if (fname.startsWith('positions.3.')) {
      vertices = arr instanceof Float32Array ? arr : Float32Array.from(arr)
    }
  }

  if (!vertices || !rawOffsets) {
    throw new Error('Invalid TRX file: missing positions or offsets')
  }

  // Build fence-post offsets: append final vertex count
  const nStreamlines = rawOffsets.length
  const offsets = new Uint32Array(nStreamlines + 1)
  offsets.set(rawOffsets)
  offsets[nStreamlines] = vertices.length / 3

  // Expand dpg (data per group) into dps (data per streamline)
  if (groups.length > 0 && Object.keys(dpgMap).length > 0) {
    expandDpg(dpgMap, groups, nStreamlines, dps)
  }

  // Build groups Record from the collected groups array
  const groupRecord: Record<string, Uint32Array> = {}
  for (const g of groups) {
    groupRecord[g.id] = g.vals
  }

  log.debug(
    `TRX: ${nStreamlines} streamlines, ${vertices.length / 3} vertices, ${Object.keys(dpv).length} dpv, ${Object.keys(dps).length} dps, ${groups.length} groups`,
  )
  return {
    vertices,
    offsets,
    dpv,
    dps,
    groups: groupRecord,
    dpvMeta: {},
    dpsMeta: {},
  }
}

/**
 * Expand per-group data into per-streamline data.
 * Each group has a membership array (indices of streamlines in that group).
 * For each dpg scalar tag, we create a per-streamline array where each
 * streamline gets the value from its group.
 */
function expandDpg(
  dpgMap: Record<string, { id: string; vals: Float32Array }[]>,
  groups: { id: string; vals: Uint32Array }[],
  nStreamlines: number,
  dps: Record<string, Float32Array>,
): void {
  // Collect all unique scalar tags across all groups
  const allTags = new Set<string>()
  for (const gid in dpgMap) {
    for (const entry of dpgMap[gid]) {
      allTags.add(entry.id)
    }
  }

  for (const tag of allTags) {
    const result = new Float32Array(nStreamlines).fill(NaN)

    for (const group of groups) {
      const entries = dpgMap[group.id] ?? []
      const entry = entries.find((e) => e.id === tag)
      if (!entry) continue
      // Each streamline index in the group gets the dpg value
      // dpg is typically 1 value per group, applied to all members
      const val = entry.vals[0] ?? NaN
      for (let i = 0; i < group.vals.length; i++) {
        const si = group.vals[i]
        if (si < nStreamlines) {
          result[si] = val
        }
      }
    }

    // Prefix with 'dpg:' to distinguish from native dps
    dps[`dpg:${tag}`] = result
  }
}
