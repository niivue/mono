import { log } from '@/logger'
import { LineReader } from '@/NVLoader'
import type { MZ3 } from '@/NVTypes'

export const extensions = ['ASC']
export const type = 'mz3'

/** FreeSurfer ASCII surfaces start with "#!a" ("#!ascii version of ..."). */
export function isASC(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer)
  return bytes[0] === 35 && bytes[1] === 33 && bytes[2] === 97
}

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  const lines = new LineReader(buffer)
  let line = lines.readLine() // 1st line: '#!ascii version of lh.pial'
  if (!line.startsWith('#!ascii')) {
    log.warn('Invalid ASC mesh')
  }
  line = lines.readLine() // 2nd line: signature
  let items = line.trim().split(/\s+/)
  const nvert = parseInt(items[0], 10)
  const ntri = parseInt(items[1], 10)
  if (!Number.isFinite(nvert) || !Number.isFinite(ntri)) {
    throw new Error('Invalid ASC mesh')
  }
  const positions = new Float32Array(nvert * 3)
  let j = 0
  for (let i = 0; i < nvert; i++) {
    line = lines.readLine()
    items = line.trim().split(/\s+/)
    positions[j] = parseFloat(items[0])
    positions[j + 1] = parseFloat(items[1])
    positions[j + 2] = parseFloat(items[2])
    j += 3
  }
  const indices = new Uint32Array(ntri * 3)
  j = 0
  for (let i = 0; i < ntri; i++) {
    line = lines.readLine()
    items = line.trim().split(/\s+/)
    indices[j] = parseInt(items[0], 10)
    indices[j + 1] = parseInt(items[1], 10)
    indices[j + 2] = parseInt(items[2], 10)
    j += 3
  }
  return {
    positions,
    indices,
  }
}
