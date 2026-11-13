/**
 * Allen mouse CCFv3 (2017) template and annotation NRRDs.
 *
 * Allen's NRRDs need three fixes the generic reader cannot infer:
 * - `space directions` are micrometres but `space units` is absent;
 * - the header says LPS with an identity matrix, but the voxel axes are PIR
 *   (posterior, inferior, right), per Allen's reference space documentation;
 * - annotation IDs are sparse uint32 (up to 614,454,277), too wide for a
 *   dense label LUT and for exact float32. They are remapped to compact uint16
 *   indices before anything converts them; `ids[compact]` is the Allen ID.
 */

import { NiiDataType } from '@/NVConstants'
import type { ColorMap, NIFTI1, NIFTI2, NVImage } from '@/NVTypes'
import { nii2volume } from '@/volume/NVVolume'
import { read as readNrrd } from '@/volume/readers/nrrd'

export const ALLEN_STRUCTURE_GRAPH_URL =
  'https://api.brain-map.org/api/v2/structure_graph_download/1.json'

export type AllenStructure = {
  id: number
  acronym: string
  name: string
  color_hex_triplet: string
  children?: AllenStructure[]
}

/** Flatten Allen's structure graph JSON (`{ msg: [root] }`) by ID. */
export function allenStructures(graph: {
  msg: AllenStructure[]
}): Map<number, AllenStructure> {
  const byId = new Map<number, AllenStructure>()
  const stack = [...graph.msg]
  while (stack.length) {
    const s = stack.pop() as AllenStructure
    byId.set(s.id, s)
    if (s.children) stack.push(...s.children)
  }
  return byId
}

/**
 * Compact indices for sparse label IDs. `ids` is sorted and starts with 0
 * (background), so compact 0 stays background.
 */
export function compactLabels(raw: Uint32Array): {
  compact: Uint16Array
  ids: Uint32Array
} {
  const seen = new Set<number>([0])
  let last = -1
  for (let i = 0; i < raw.length; i++) {
    // Labels come in long runs: one compare skips most Set lookups.
    if (raw[i] === last) continue
    last = raw[i]
    seen.add(last)
  }
  if (seen.size > 65536) throw new Error('CCF: more than 65536 labels')
  const ids = Uint32Array.from(seen).sort()
  const toCompact = new Map<number, number>()
  for (let k = 0; k < ids.length; k++) toCompact.set(ids[k], k)
  const compact = new Uint16Array(raw.length)
  let k = 0
  last = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== last) {
      last = raw[i]
      k = toCompact.get(last) as number
    }
    compact[i] = k
  }
  return { compact, ids }
}

/** Original Allen IDs for compact indices (for export or analysis). */
export function allenIds(compact: Uint16Array, ids: Uint32Array): Uint32Array {
  const out = new Uint32Array(compact.length)
  for (let i = 0; i < compact.length; i++) out[i] = ids[compact[i]]
  return out
}

/**
 * Label colormap for compact indices: ontology colour and a
 * `ACRONYM name (ID)` label, so hover and legend show the Allen ID.
 * `missing` lists IDs the ontology does not define (drawn grey).
 */
export function ccfColormap(
  ids: Uint32Array,
  structures: Map<number, AllenStructure>,
): { colormap: ColorMap; missing: number[] } {
  const n = ids.length
  const colormap: ColorMap = {
    R: [0],
    G: [0],
    B: [0],
    A: [0],
    I: [...Array(n).keys()],
    labels: [''],
  }
  const missing: number[] = []
  for (let k = 1; k < n; k++) {
    const s = structures.get(ids[k])
    if (!s) missing.push(ids[k])
    const rgb = s ? parseInt(s.color_hex_triplet, 16) : 0x808080
    colormap.R.push(rgb >> 16)
    colormap.G.push((rgb >> 8) & 255)
    colormap.B.push(rgb & 255)
    colormap.A.push(255)
    colormap.labels?.push(
      s ? `${s.acronym} ${s.name} (${ids[k]})` : `unknown (${ids[k]})`,
    )
  }
  return { colormap, missing }
}

/**
 * Replace the header's spacing and orientation with CCF's: micrometre
 * `space directions`, voxel axes PIR, origin at voxel 0 (CCF coordinates).
 */
function setCcfAffine(hdr: NIFTI1 | NIFTI2): void {
  const a = hdr.affine
  // Allen writes a diagonal matrix; its diagonal is the spacing in um.
  const mm = [0, 1, 2].map((i) => Math.abs(a[i][i]) * 0.001)
  hdr.affine = [
    [0, 0, mm[2], 0], // R = +axis 2
    [-mm[0], 0, 0, 0], // A = -axis 0
    [0, -mm[1], 0, 0], // S = -axis 1
    [0, 0, 0, 1],
  ]
  hdr.pixDims = [1, mm[0], mm[1], mm[2], ...hdr.pixDims.slice(4)]
  hdr.sform_code = 2
}

/**
 * Read an Allen CCF NRRD as an NVImage with CCF scale and orientation. A
 * uint32 annotation is returned with compact uint16 indices and `ids`, the
 * Allen ID of each index.
 */
export async function readCcfNrrd(
  buffer: ArrayBuffer,
  name: string,
): Promise<{ volume: NVImage; ids?: Uint32Array }> {
  const { hdr, img } = await readNrrd(buffer)
  setCcfAffine(hdr)
  if (hdr.datatypeCode !== NiiDataType.DT_UINT32)
    return { volume: nii2volume(hdr, img as ArrayBuffer, name) }
  const { compact, ids } = compactLabels(new Uint32Array(img as ArrayBuffer))
  hdr.datatypeCode = NiiDataType.DT_UINT16
  hdr.numBitsPerVoxel = 16
  return { volume: nii2volume(hdr, compact, name), ids }
}
