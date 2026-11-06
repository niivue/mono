import { maybeDecompress } from '@/codecs/NVGz'
import { log } from '@/logger'
import type { MZ3 } from '@/NVTypes'

export const extensions = ['NV']
export const type = 'mz3'

function nextDataLine(
  lines: string[],
  startIdx: number,
): { line: string | null; idx: number } {
  let idx = startIdx
  while (idx < lines.length) {
    const line = lines[idx++].trim()
    if (!line) continue
    if (line.startsWith('#') || line.startsWith('//') || line.startsWith('%'))
      continue
    return { line, idx }
  }
  return { line: null, idx }
}

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  log.warn('NV mesh format may have inconsistent triangle winding.')
  buffer = await maybeDecompress(buffer)
  const enc = new TextDecoder('utf-8')
  const txt = enc.decode(buffer)
  const lines = txt.split(/\r?\n/)
  let idx = 0
  // Fields of the next data line; a missing line or short row is invalid.
  function nextFields(minFields = 1): string[] {
    const result = nextDataLine(lines, idx)
    idx = result.idx
    const items = result.line?.split(/\s+/)
    if (!items || items.length < minFields) {
      throw new Error('Not a valid NV mesh file')
    }
    return items
  }
  const nvert = parseInt(nextFields()[0], 10)
  if (!Number.isFinite(nvert) || nvert < 1) {
    throw new Error('Not a valid NV mesh file')
  }
  const positions = new Float32Array(nvert * 3)
  let v = 0
  for (let i = 0; i < nvert; i++) {
    const items = nextFields(3)
    positions[v] = parseFloat(items[0])
    positions[v + 1] = parseFloat(items[1])
    positions[v + 2] = parseFloat(items[2])
    v += 3
  }
  const ntri = parseInt(nextFields()[0], 10)
  if (!Number.isFinite(ntri) || ntri < 0) {
    throw new Error('Not a valid NV mesh file')
  }
  if (ntri < 1) {
    log.warn('NV mesh has no faces')
  }
  const rawIndices = new Int32Array(ntri * 3)
  let minIdx = Number.POSITIVE_INFINITY
  for (let i = 0; i < ntri; i++) {
    const items = nextFields(3)
    const a = parseInt(items[0], 10)
    const b = parseInt(items[1], 10)
    const c = parseInt(items[2], 10)
    rawIndices[i * 3] = a
    rawIndices[i * 3 + 1] = b
    rawIndices[i * 3 + 2] = c
    if (a < minIdx) minIdx = a
    if (b < minIdx) minIdx = b
    if (c < minIdx) minIdx = c
  }
  const offset = minIdx === 0 ? 0 : 1
  const indices = new Uint32Array(ntri * 3)
  for (let i = 0; i < ntri; i++) {
    const a = rawIndices[i * 3] - offset
    const b = rawIndices[i * 3 + 1] - offset
    const c = rawIndices[i * 3 + 2] - offset
    const t = i * 3
    indices[t] = c
    indices[t + 1] = b
    indices[t + 2] = a
  }
  return { positions, indices }
}
