import { log } from "@/logger"
import type { MZ3 } from "@/NVTypes"

export const extensions = ["DFS"]
export const type = "mz3"

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  // BrainSuite DFS format
  // http://brainsuite.org/formats/dfs/
  const reader = new DataView(buffer)
  const magic = reader.getUint32(0, true) // "DFS_"
  const LE = reader.getUint16(4, true) // "LE"
  if (magic !== 1599292996 || LE !== 17740) {
    log.warn("Not a little-endian brainsuite DFS mesh")
  }
  const hdrBytes = reader.getUint32(12, true)
  const nface = reader.getUint32(24, true)
  const nvert = reader.getUint32(28, true)
  const vcoffset = reader.getUint32(48, true)
  let pos = hdrBytes
  const indices = new Uint32Array(buffer, pos, nface * 3)
  pos += nface * 3 * 4
  const positions = new Float32Array(buffer, pos, nvert * 3)
  // Triangle winding opposite of CCW convention
  for (let i = 0; i < nvert * 3; i += 3) {
    const tmp = positions[i]
    positions[i] = positions[i + 1]
    positions[i + 1] = tmp
  }
  let colors: Float32Array | undefined
  if (vcoffset > 0 && vcoffset + nvert * 3 * 4 <= buffer.byteLength) {
    colors = new Float32Array(buffer, vcoffset, nvert * 3)
  }
  const out: MZ3 = { positions, indices }
  if (colors) {
    out.colors = colors
  }
  return out
}
