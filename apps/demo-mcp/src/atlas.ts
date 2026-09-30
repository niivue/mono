/**
 * The AAL atlas as `list_regions` and `go_to_region` need it.
 *
 * The core carries only the spoken-name table; the volume and its labels
 * are the page's. This one fetches NiiVue's copy of AAL from
 * `@niivue/dev-images`, reads it with `nifti-reader-js` and NiiVue's own
 * `nii2volume`, and answers the four questions in `AtlasLike` from the
 * voxel grid. The atlas is in MNI space, so a point on the loaded scan is
 * looked up by its world position rather than its index: the two grids
 * need not match.
 */
import { type NVImage, nii2volume } from '@niivue/niivue'
import { SPOKEN_NAMES } from '@niivue/nv-mcp'
import type { AtlasLike, AtlasRegion } from '@niivue/nv-mcp/browser'
import * as nifti from 'nifti-reader-js'

export const ATLAS = {
  name: 'AAL',
  volume: '/volumes/aal.nii.gz',
  labels: '/volumes/aal.json',
} as const

type Vec3 = [number, number, number]

/** The parts of a loaded volume a voxel read goes through. */
interface Grid {
  img: ArrayLike<number>
  dims: Vec3
  start: number[]
  step: number[]
  matRAS: ArrayLike<number>
  inverse: number[]
}

/** Fetches the atlas and its label table. Rejects in words when either is unreachable. */
export async function loadAtlas(): Promise<AtlasLike> {
  const [image, table] = await Promise.all([
    fetchVolume(ATLAS.volume),
    fetch(ATLAS.labels).then((response) => {
      if (!response.ok) throw new Error(`atlas labels: ${response.status}`)
      return response.json() as Promise<{ labels: string[] }>
    }),
  ])
  const grid = gridOf(image)
  const names = table.labels.map(
    (label) => SPOKEN_NAMES[label] ?? label.replaceAll('_', ' '),
  )

  const valueAt = (mm: readonly number[]): number => {
    const vox = toVox(grid, mm)
    return vox ? voxelValue(grid, vox) : 0
  }
  let regions: AtlasRegion[] | null = null

  return {
    valueAt,
    regionAt: (mm) => regionName(names, valueAt(mm)),
    regions() {
      // One pass over the whole volume, kept: the atlas never changes.
      regions ??= labelStats(grid).flatMap((stat) => {
        const label = table.labels[stat.value]
        const name = regionName(names, stat.value)
        if (!label || !name) return []
        return [
          {
            value: stat.value,
            label,
            name,
            centroid: toMm(grid, stat.centroid),
            voxels: stat.voxels,
          },
        ]
      })
      return regions
    },
    nearestIn(value, mm) {
      const from = applyAffine(grid.inverse, mm)
      const vox = nearestVoxel(grid, value, from)
      return vox ? toMm(grid, vox) : null
    },
  }
}

/**
 * Parses a NIfTI volume without handing it to a viewer.
 *
 * NiiVue 1.0 loads volumes only into a view; `nii2volume` is its exported
 * way to build one from a parsed header and image, which is what the atlas
 * needs: the affine and the RAS index NiiVue works out, never a texture.
 */
async function fetchVolume(url: string): Promise<NVImage> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`atlas volume: ${response.status}`)
  let data = await response.arrayBuffer()
  if (nifti.isCompressed(data)) data = nifti.decompress(data) as ArrayBuffer
  const hdr = nifti.readHeader(data)
  if (!hdr) throw new Error('atlas volume is not NIfTI')
  return nii2volume(hdr, nifti.readImage(hdr, data), url)
}

function gridOf(image: NVImage): Grid {
  const { img, dimsRAS, img2RASstart, img2RASstep, matRAS } = image
  if (!img || !dimsRAS || !img2RASstart || !img2RASstep || !matRAS) {
    throw new Error('atlas volume has no voxels')
  }
  const inverse = invert4(matRAS)
  if (!inverse) throw new Error('atlas affine cannot be inverted')
  return {
    img,
    dims: [dimsRAS[1], dimsRAS[2], dimsRAS[3]],
    start: img2RASstart,
    step: img2RASstep,
    matRAS,
    inverse,
  }
}

/** The raw value at RAS voxel indices; the atlas is integer labels, so no scaling applies. */
function voxelValue(grid: Grid, [x, y, z]: Vec3): number {
  const { start, step } = grid
  const raw =
    grid.img[
      start[0] + x * step[0] + start[1] + y * step[1] + start[2] + z * step[2]
    ]
  return raw === undefined || Number.isNaN(raw) ? 0 : raw
}

/** World millimetres for a RAS voxel index. `matRAS` is row-major, so the translation sits at 3, 7 and 11. */
function toMm(grid: Grid, vox: readonly number[]): Vec3 {
  return applyAffine(grid.matRAS, vox)
}

/** The RAS voxel index of a world point, rounded, or null when it falls outside the grid. */
function toVox(grid: Grid, mm: readonly number[]): Vec3 | null {
  const at = applyAffine(grid.inverse, mm)
  const vox: Vec3 = [Math.round(at[0]), Math.round(at[1]), Math.round(at[2])]
  for (let axis = 0; axis < 3; axis++) {
    if (vox[axis] < 0 || vox[axis] >= grid.dims[axis]) return null
  }
  return vox
}

function applyAffine(m: ArrayLike<number>, p: readonly number[]): Vec3 {
  const [x, y, z] = p
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ]
}

/** The name for a label value, or null for background and anything unlabelled. */
function regionName(names: readonly string[], value: number): string | null {
  if (!Number.isInteger(value) || value <= 0 || value >= names.length) {
    return null
  }
  return names[value]
}

interface LabelStats {
  value: number
  voxels: number
  /** The mean RAS voxel index along each axis. */
  centroid: Vec3
}

/** Counts every label's voxels and averages where they are, in one pass over the RAS grid. */
function labelStats(grid: Grid): LabelStats[] {
  const [nx, ny, nz] = grid.dims
  const count = new Map<number, number>()
  const sum = new Map<number, Vec3>()
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const value = voxelValue(grid, [x, y, z])
        if (!(value > 0)) continue
        const total = sum.get(value)
        if (total) {
          total[0] += x
          total[1] += y
          total[2] += z
          count.set(value, (count.get(value) ?? 0) + 1)
        } else {
          sum.set(value, [x, y, z])
          count.set(value, 1)
        }
      }
    }
  }
  return [...count.keys()]
    .sort((a, b) => a - b)
    .map((value) => {
      const n = count.get(value) ?? 1
      const total = sum.get(value) ?? [0, 0, 0]
      return {
        value,
        voxels: n,
        centroid: [total[0] / n, total[1] / n, total[2] / n],
      }
    })
}

/**
 * The voxel carrying `value` nearest to `from`, or null when none does. A
 * full scan, since a region can be any shape: it is only asked for when a
 * centroid has missed, which a navigation can afford.
 */
function nearestVoxel(
  grid: Grid,
  value: number,
  from: readonly number[],
): Vec3 | null {
  const [nx, ny, nz] = grid.dims
  let best: Vec3 | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (voxelValue(grid, [x, y, z]) !== value) continue
        const distance =
          (x - from[0]) ** 2 + (y - from[1]) ** 2 + (z - from[2]) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          best = [x, y, z]
        }
      }
    }
  }
  return best
}

/** gl-matrix's `mat4.invert`, written out. Works in either storage order: the inverse of a transpose is the transpose of the inverse. */
function invert4(a: ArrayLike<number>): number[] | null {
  const [
    a00,
    a01,
    a02,
    a03,
    a10,
    a11,
    a12,
    a13,
    a20,
    a21,
    a22,
    a23,
    a30,
    a31,
    a32,
    a33,
  ] = Array.from(a)
  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32
  const det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return null
  const d = 1 / det
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]
}
