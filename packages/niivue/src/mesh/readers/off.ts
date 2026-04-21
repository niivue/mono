import { log } from '@/logger'
import type { MZ3 } from '@/NVTypes'

export const extensions = ['OFF']
export const type = 'mz3'

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  const enc = new TextDecoder('utf-8')
  const txt = enc.decode(buffer)
  const lines = txt.split('\n')
  const pts: number[] = []
  const t: number[] = []
  let i = 0
  if (!lines[i].includes('OFF')) {
    log.warn('File does not start with OFF')
  } else {
    i++
  }
  let items = lines[i].trim().split(/\s+/)
  const num_v = parseInt(items[0], 10)
  const num_f = parseInt(items[1], 10)
  i++
  for (let j = 0; j < num_v; j++) {
    const str = lines[i]
    items = str.trim().split(/\s+/)
    pts.push(parseFloat(items[0]))
    pts.push(parseFloat(items[1]))
    pts.push(parseFloat(items[2]))
    i++
  }
  for (let j = 0; j < num_f; j++) {
    const str = lines[i]
    items = str.trim().split(/\s+/)
    const n = parseInt(items[0], 10)
    if (n !== 3) {
      log.warn('Only able to read OFF files with triangular meshes')
    }
    t.push(parseInt(items[1], 10))
    t.push(parseInt(items[2], 10))
    t.push(parseInt(items[3], 10))
    i++
  }
  const positions = new Float32Array(pts)
  const indices = new Uint32Array(t)
  return {
    positions,
    indices,
  }
}
