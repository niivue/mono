import { makeLabelLut } from '@/cmap/NVCmaps'
import { log } from '@/logger'
import type { LUT } from '@/NVTypes'

export const extensions = ['ANNOT']

type LayerReadResult = {
  values: Float32Array
  nFrame4D: number
  colormapLabel?: LUT | null
}

const TAG_OLD_COLORTABLE = 1

/**
 * Read a FreeSurfer annotation (`.annot`, big-endian): each vertex's packed
 * RGB label, then a colour table naming each structure. Values become the
 * table index of each vertex's structure, with the table as the label
 * colormap, as NiiVue 0.x's `readANNOT` did. A file without the colour table
 * is refused: its packed colours alone name no structures.
 */
export function read(buffer: ArrayBuffer, nVert: number): LayerReadResult {
  const view = new DataView(buffer)
  const nVertex = view.getUint32(0, false)
  if (nVertex !== nVert) {
    throw new Error(`ANNOT has ${nVertex} vertices but the mesh has ${nVert}`)
  }
  if (buffer.byteLength < 4 + 8 * nVertex) {
    throw new Error('ANNOT file smaller than its vertex count')
  }
  // Vertex index, packed colour pairs.
  const rgb = new Uint32Array(nVertex)
  let pos = 4
  for (let i = 0; i < nVertex; i++, pos += 8) {
    rgb[view.getUint32(pos, false)] = view.getUint32(pos + 4, false)
  }
  const tag = pos + 4 <= buffer.byteLength ? view.getInt32(pos, false) : 0
  const version = tag === TAG_OLD_COLORTABLE ? view.getInt32(pos + 4, false) : 0
  // Only the current colour table (tag 1, negative version) is readable.
  if (tag !== TAG_OLD_COLORTABLE || version > 0) {
    throw new Error('ANNOT has no readable colour table')
  }
  const maxStruct = view.getInt32(pos + 8, false)
  const nameLen = view.getInt32(pos + 12, false)
  pos += 16 + nameLen
  const nEntries = view.getInt32(pos, false)
  pos += 4
  const cm = {
    R: Array<number>(maxStruct).fill(0),
    G: Array<number>(maxStruct).fill(0),
    B: Array<number>(maxStruct).fill(0),
    A: Array<number>(maxStruct).fill(0),
    I: Array<number>(maxStruct).fill(0),
    labels: Array<string>(maxStruct).fill(''),
  }
  // Packed colour (R + G<<8 + B<<16, as written per vertex) -> structure.
  const structOf = new Map<number, number>()
  for (let e = 0; e < nEntries; e++) {
    const struct = view.getInt32(pos, false)
    const labelLen = view.getInt32(pos + 4, false)
    const label = new TextDecoder()
      .decode(new Uint8Array(buffer, pos + 8, labelLen))
      .replace(/\0.*$/s, '')
    pos += 8 + labelLen
    const [r, g, b, a] = [0, 4, 8, 12].map((o) => view.getInt32(pos + o, false))
    pos += 16
    if (struct < 0 || struct >= maxStruct) {
      log.warn('ANNOT colour table entry out of range')
      continue
    }
    cm.R[struct] = r
    cm.G[struct] = g
    cm.B[struct] = b
    // The fourth channel is transparency (FreeSurfer RGBT): alpha = 255 - T.
    cm.A[struct] = 255 - a
    cm.labels[struct] = label
    structOf.set(r + (g << 8) + (b << 16), struct)
  }
  for (let i = 0; i < maxStruct; i++) cm.I[i] = i
  const values = new Float32Array(nVertex)
  let unmatched = 0
  for (let i = 0; i < nVertex; i++) {
    const struct = structOf.get(rgb[i] & 0xffffff)
    if (struct === undefined) unmatched++
    else values[i] = struct
  }
  if (unmatched > 0) {
    log.warn(
      `ANNOT: ${unmatched} of ${nVertex} vertex colours match no structure`,
    )
  }
  return { values, nFrame4D: 1, colormapLabel: makeLabelLut(cm) }
}
