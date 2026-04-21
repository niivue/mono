import * as NVCmaps from '@/cmap/NVCmaps'
import * as NVLoader from '@/NVLoader'
import type { NVTractData, NVTractOptions, TractScalarMeta } from '@/NVTypes'

type TractReader = {
  extensions?: string[]
  read: (buffer: ArrayBufferLike) => Promise<NVTractData>
}

const modules = import.meta.glob<TractReader>('./readers/*.ts', {
  eager: true,
})
const readerByExt = NVLoader.buildExtensionMap(modules)

export function tractExtensions(): string[] {
  return Array.from(readerByExt.keys()).sort()
}

export function isTractExtension(ext: string): boolean {
  return readerByExt.has(ext.toUpperCase())
}

export function getTractReader(ext: string): TractReader | undefined {
  return readerByExt.get(ext.toUpperCase())
}

/** Compute global_min/global_max for a scalar array. */
export function computeScalarMeta(arr: Float32Array): TractScalarMeta {
  let mn = Infinity,
    mx = -Infinity
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    if (!Number.isFinite(v)) continue
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  return {
    globalMin: Number.isFinite(mn) ? mn : 0,
    globalMax: Number.isFinite(mx) ? mx : 0,
  }
}

/** Populate dpvMeta/dpsMeta from all scalar arrays in tractData. */
export function computeAllScalarMeta(data: NVTractData): void {
  for (const [name, arr] of Object.entries(data.dpv)) {
    data.dpvMeta[name] = computeScalarMeta(arr)
  }
  for (const [name, arr] of Object.entries(data.dps)) {
    data.dpsMeta[name] = computeScalarMeta(arr)
  }
}

export const defaultTractOptions: NVTractOptions = {
  fiberRadius: 0.5,
  fiberSides: 7,
  minLength: 0,
  decimation: 1,
  colormap: 'warm',
  colormapNegative: '',
  colorBy: '',
  calMin: 0,
  calMax: 0,
  calMinNeg: 0,
  calMaxNeg: 0,
  fixedColor: [255, 255, 255, 255],
  groupColors: null,
}

export type TessellationResult = {
  positions: Float32Array
  indices: Uint32Array
  colors: Uint32Array
}

/** Look up the scalar array for a given colorBy string. */
function getScalarArray(
  data: NVTractData,
  colorBy: string,
): Float32Array | null {
  if (colorBy.startsWith('dpv:')) return data.dpv[colorBy.slice(4)] ?? null
  if (colorBy.startsWith('dps:')) return data.dps[colorBy.slice(4)] ?? null
  return null
}

/**
 * Tessellate streamlines into cylinder mesh geometry.
 * Pure function: source data + options in, GPU-ready buffers out.
 */
export function tessellate(
  data: NVTractData,
  options: NVTractOptions,
): TessellationResult {
  cachedLuts = null // invalidate LUT cache for fresh options

  // Auto-compute cal_min/cal_max from scalar data when both are 0.
  // Persist the computed values so subsequent option changes (e.g. cal_min slider)
  // operate relative to the actual data range rather than a stale cal_max of 0.
  if (options.colorBy !== '' && options.calMin === 0 && options.calMax === 0) {
    const arr = getScalarArray(data, options.colorBy)
    if (arr) {
      let mn = Infinity,
        mx = -Infinity
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i]
        if (!Number.isFinite(v)) continue
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      if (Number.isFinite(mn) && Number.isFinite(mx)) {
        options.calMin = mn
        options.calMax = mx
      }
    }
  }

  const { vertices, offsets } = data
  const { fiberRadius, fiberSides, minLength, decimation, groupColors } =
    options

  // When groupColors is active, build a per-streamline color map and filter by group membership
  let groupColorMap: Map<number, number> | null = null
  if (groupColors && Object.keys(groupColors).length > 0) {
    groupColorMap = new Map()
    for (const [groupName, rgba] of Object.entries(groupColors)) {
      const members = data.groups[groupName]
      if (!members) continue
      const packed =
        (rgba[3] << 24) | (rgba[2] << 16) | (rgba[1] << 8) | rgba[0]
      for (let i = 0; i < members.length; i++) {
        groupColorMap.set(members[i], packed)
      }
    }
  }

  // Count eligible streamlines and total vertices after filtering
  const nStreamlines = offsets.length - 1
  let totalLineVerts = 0
  const eligible: number[] = []
  for (let s = 0; s < nStreamlines; s++) {
    // Group filtering: skip streamlines not in any visible group
    if (groupColorMap && !groupColorMap.has(s)) continue
    if (decimation > 1 && s % decimation !== 0) continue
    const start = offsets[s]
    const end = offsets[s + 1]
    const nPts = end - start
    if (nPts < 2) continue
    // Compute streamline length
    if (minLength > 0) {
      let len = 0
      for (let i = start + 1; i < end; i++) {
        const dx = vertices[i * 3] - vertices[(i - 1) * 3]
        const dy = vertices[i * 3 + 1] - vertices[(i - 1) * 3 + 1]
        const dz = vertices[i * 3 + 2] - vertices[(i - 1) * 3 + 2]
        len += Math.sqrt(dx * dx + dy * dy + dz * dz)
      }
      if (len < minLength) continue
    }
    eligible.push(s)
    totalLineVerts += nPts
  }

  // Ensure at least one streamline is shown (high decimation can filter all)
  if (eligible.length === 0 && nStreamlines > 0) {
    for (let s = 0; s < nStreamlines; s++) {
      if (groupColorMap && !groupColorMap.has(s)) continue
      const nPts = offsets[s + 1] - offsets[s]
      if (nPts >= 2) {
        eligible.push(s)
        totalLineVerts += nPts
        break
      }
    }
  }

  if (totalLineVerts === 0) {
    return {
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      colors: new Uint32Array(0),
    }
  }

  // Allocate: each centerline vertex → fiberSides ring vertices
  // Each segment (nPts-1 per streamline) → 2 * fiberSides triangles
  const totalRingVerts = totalLineVerts * fiberSides
  const positions = new Float32Array(totalRingVerts * 3)
  const colors = new Uint32Array(totalRingVerts)
  let totalTriangles = 0
  for (const s of eligible) {
    const nPts = offsets[s + 1] - offsets[s]
    totalTriangles += (nPts - 1) * fiberSides * 2
  }
  const indices = new Uint32Array(totalTriangles * 3)

  let vertOffset = 0
  let idxOffset = 0

  // Precompute sin/cos for ring
  const ringCos = new Float32Array(fiberSides)
  const ringSin = new Float32Array(fiberSides)
  for (let j = 0; j < fiberSides; j++) {
    const angle = (j / fiberSides) * Math.PI * 2
    ringCos[j] = Math.cos(angle)
    ringSin[j] = Math.sin(angle)
  }

  // Reusable vectors
  const v1 = new Float32Array(3)
  const v2 = new Float32Array(3)
  const v3 = new Float32Array(3)
  const prevV2 = new Float32Array(3)

  for (const s of eligible) {
    const start = offsets[s]
    const end = offsets[s + 1]
    const nPts = end - start

    // Reset frame for each streamline
    prevV2[0] = 0
    prevV2[1] = 0
    prevV2[2] = 0

    for (let p = 0; p < nPts; p++) {
      const ci = start + p
      const cx = vertices[ci * 3]
      const cy = vertices[ci * 3 + 1]
      const cz = vertices[ci * 3 + 2]

      // Compute tangent (v1) — forward difference for first, backward for last, central otherwise
      if (p === 0) {
        const ni = ci + 1
        v1[0] = vertices[ni * 3] - cx
        v1[1] = vertices[ni * 3 + 1] - cy
        v1[2] = vertices[ni * 3 + 2] - cz
      } else if (p === nPts - 1) {
        const pi = ci - 1
        v1[0] = cx - vertices[pi * 3]
        v1[1] = cy - vertices[pi * 3 + 1]
        v1[2] = cz - vertices[pi * 3 + 2]
      } else {
        const ni = ci + 1
        const pi = ci - 1
        v1[0] = vertices[ni * 3] - vertices[pi * 3]
        v1[1] = vertices[ni * 3 + 1] - vertices[pi * 3 + 1]
        v1[2] = vertices[ni * 3 + 2] - vertices[pi * 3 + 2]
      }
      // Normalize v1
      let len = Math.sqrt(v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2])
      if (len > 0) {
        v1[0] /= len
        v1[1] /= len
        v1[2] /= len
      }

      // Compute perpendicular frame (anti-twist Frenet approach)
      if (p > 0) {
        // Anti-twist: project prevV2 onto plane perpendicular to v1
        // D = prevV2 cross v1, then v2 = v1 cross D
        const dx = prevV2[1] * v1[2] - prevV2[2] * v1[1]
        const dy = prevV2[2] * v1[0] - prevV2[0] * v1[2]
        const dz = prevV2[0] * v1[1] - prevV2[1] * v1[0]
        v2[0] = v1[1] * dz - v1[2] * dy
        v2[1] = v1[2] * dx - v1[0] * dz
        v2[2] = v1[0] * dy - v1[1] * dx
        len = Math.sqrt(v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2])
        if (len > 1e-6) {
          v2[0] /= len
          v2[1] /= len
          v2[2] /= len
        }
      }
      if (p === 0 || len <= 1e-6) {
        // Fresh frame: pick arbitrary perpendicular to tangent
        if (Math.abs(v1[2]) < 0.9) {
          v2[0] = -v1[1]
          v2[1] = v1[0]
          v2[2] = 0
        } else {
          v2[0] = 0
          v2[1] = -v1[2]
          v2[2] = v1[1]
        }
        len = Math.sqrt(v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2])
        if (len > 0) {
          v2[0] /= len
          v2[1] /= len
          v2[2] /= len
        }
      }
      prevV2[0] = v2[0]
      prevV2[1] = v2[1]
      prevV2[2] = v2[2]

      // v3 = v1 cross v2
      v3[0] = v1[1] * v2[2] - v1[2] * v2[1]
      v3[1] = v1[2] * v2[0] - v1[0] * v2[2]
      v3[2] = v1[0] * v2[1] - v1[1] * v2[0]

      // Compute vertex color for this centerline point
      const rgba32 = groupColorMap
        ? (groupColorMap.get(s) as number)
        : computeVertexColor(data, options, s, ci, start, v1)

      // Generate ring vertices
      const ringBase = vertOffset
      for (let j = 0; j < fiberSides; j++) {
        const c = ringCos[j]
        const sn = ringSin[j]
        const ox = fiberRadius * (c * v2[0] + sn * v3[0])
        const oy = fiberRadius * (c * v2[1] + sn * v3[1])
        const oz = fiberRadius * (c * v2[2] + sn * v3[2])
        const vi = vertOffset * 3
        positions[vi] = cx + ox
        positions[vi + 1] = cy + oy
        positions[vi + 2] = cz + oz
        colors[vertOffset] = rgba32
        vertOffset++
      }

      // Generate triangles between this ring and previous ring
      if (p > 0) {
        const prevRing = ringBase - fiberSides
        for (let j = 0; j < fiberSides; j++) {
          const j1 = (j + 1) % fiberSides
          // Triangle 1
          indices[idxOffset++] = prevRing + j
          indices[idxOffset++] = ringBase + j
          indices[idxOffset++] = ringBase + j1
          // Triangle 2
          indices[idxOffset++] = prevRing + j
          indices[idxOffset++] = ringBase + j1
          indices[idxOffset++] = prevRing + j1
        }
      }
    }
  }

  return { positions, indices, colors }
}

/** Cached LUT state to avoid re-building every vertex. */
type CachedLuts = {
  colorBy: string
  colormap: string
  colormapNegative: string
  lut: Uint8ClampedArray
  lutNeg: Uint8ClampedArray | null
  scalarArray: Float32Array | null
  isPerVertex: boolean
}

let cachedLuts: CachedLuts | null = null

/**
 * Build or reuse cached LUTs and scalar arrays for the current options.
 */
function ensureLuts(data: NVTractData, options: NVTractOptions): CachedLuts {
  if (
    cachedLuts &&
    cachedLuts.colorBy === options.colorBy &&
    cachedLuts.colormap === options.colormap &&
    cachedLuts.colormapNegative === options.colormapNegative
  ) {
    return cachedLuts
  }

  const lut = NVCmaps.lutrgba8(options.colormap)
  const lutNeg = options.colormapNegative
    ? NVCmaps.lutrgba8(options.colormapNegative)
    : null

  let scalarArray: Float32Array | null = null
  let isPerVertex = false

  if (options.colorBy.startsWith('dpv:')) {
    const name = options.colorBy.slice(4)
    scalarArray = data.dpv[name] ?? null
    isPerVertex = true
  } else if (options.colorBy.startsWith('dps:')) {
    const name = options.colorBy.slice(4)
    scalarArray = data.dps[name] ?? null
    isPerVertex = false
  }

  cachedLuts = {
    colorBy: options.colorBy,
    colormap: options.colormap,
    colormapNegative: options.colormapNegative,
    lut,
    lutNeg,
    scalarArray,
    isPerVertex,
  }
  return cachedLuts
}

/**
 * Compute packed ABGR color for a single centerline vertex.
 * Supports direction-based coloring (colorBy='') and scalar coloring
 * via dpv (per-vertex) or dps (per-streamline) scalars.
 */
function computeVertexColor(
  data: NVTractData,
  options: NVTractOptions,
  streamlineIndex: number,
  vertexIndex: number,
  _streamlineStart: number,
  tangent: Float32Array,
): number {
  // Local direction-based coloring: RGB = |tangent|
  if (options.colorBy === '' || options.colorBy === 'local') {
    const r = Math.round(Math.abs(tangent[0]) * 255)
    const g = Math.round(Math.abs(tangent[1]) * 255)
    const b = Math.round(Math.abs(tangent[2]) * 255)
    return (255 << 24) | (b << 16) | (g << 8) | r
  }

  // Global direction: color from start-to-end direction, uniform per streamline
  if (options.colorBy === 'global') {
    const offsets = data.offsets
    const verts = data.vertices
    const si = offsets[streamlineIndex] * 3
    const ei = (offsets[streamlineIndex + 1] - 1) * 3
    let dx = verts[ei] - verts[si]
    let dy = verts[ei + 1] - verts[si + 1]
    let dz = verts[ei + 2] - verts[si + 2]
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len > 0) {
      dx /= len
      dy /= len
      dz /= len
    }
    const r = Math.round(Math.abs(dx) * 255)
    const g = Math.round(Math.abs(dy) * 255)
    const b = Math.round(Math.abs(dz) * 255)
    return (255 << 24) | (b << 16) | (g << 8) | r
  }

  // Fixed color: use options.fixedColor for all vertices
  if (options.colorBy === 'fixed') {
    const [r, g, b, a] = options.fixedColor
    return (a << 24) | (b << 16) | (g << 8) | r
  }

  // Scalar coloring
  const luts = ensureLuts(data, options)
  if (!luts.scalarArray) return 0xffffffff // fallback white if scalar not found

  const value = luts.isPerVertex
    ? (luts.scalarArray[vertexIndex] ?? 0)
    : (luts.scalarArray[streamlineIndex] ?? 0)

  if (!Number.isFinite(value)) return 0x00000000 // transparent for NaN

  // Determine which LUT and calibration range to use
  const absVal = Math.abs(value)
  const isNeg = value < 0 && luts.lutNeg
  const activeLut = isNeg ? (luts.lutNeg as Uint8ClampedArray) : luts.lut
  const calMin = isNeg ? options.calMinNeg || options.calMin : options.calMin
  const calMax = isNeg ? options.calMaxNeg || options.calMax : options.calMax

  // Below threshold → transparent
  if (calMin > 0 && absVal < calMin) return 0x00000000

  const range = calMax - calMin
  const f = range > 0 ? Math.max(0, Math.min(1, (absVal - calMin) / range)) : 0
  const nColors = activeLut.length / 4
  const idx = Math.min(nColors - 1, Math.floor(f * (nColors - 1))) * 4

  const r = activeLut[idx]
  const g = activeLut[idx + 1]
  const b = activeLut[idx + 2]
  const a = activeLut[idx + 3]
  return (a << 24) | (b << 16) | (g << 8) | r
}
