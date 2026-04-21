import { log } from '@/logger'
import type { MZ3 } from '@/NVTypes'
import { read as readASC } from './asc'

export const extensions = [
  'WHITE',
  'PIAL',
  'INFLATED',
  'SPHERE',
  'ORIG',
  'SMOOTHWM',
  'QSPHERE',
]
export const type = 'mz3'

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 35 && bytes[1] === 33 && bytes[2] === 97) {
    return readASC(buffer) // "#!ascii version"
  }
  const view = new DataView(buffer)
  const sig0 = view.getUint32(0, false)
  const sig1 = view.getUint32(4, false)
  if (sig0 !== 4294966883 || sig1 !== 1919246708) {
    log.warn(
      'Unable to recognize file type: does not appear to be FreeSurfer format.',
    )
  }
  let offset = 0
  while (view.getUint8(offset) !== 10) {
    offset++
  }
  offset += 2
  let nv = view.getUint32(offset, false)
  offset += 4
  let nf = view.getUint32(offset, false)
  offset += 4
  nv *= 3
  const positions = new Float32Array(nv)
  for (let i = 0; i < nv; i++) {
    positions[i] = view.getFloat32(offset, false)
    offset += 4
  }
  nf *= 3
  const indices = new Uint32Array(nf)
  for (let i = 0; i < nf; i++) {
    indices[i] = view.getUint32(offset, false)
    offset += 4
  }
  const head0 = view.getUint32(offset, false)
  offset += 4
  let isHeadOK = head0 === 20
  if (!isHeadOK) {
    const head1 = view.getUint32(offset, false)
    offset += 4
    const head2 = view.getUint32(offset, false)
    offset += 4
    isHeadOK = head0 === 2 && head1 === 0 && head2 === 20
  }
  if (!isHeadOK) {
    log.warn('Unknown FreeSurfer Mesh extension code.')
  } else {
    const footer = new TextDecoder().decode(buffer.slice(offset)).trim()
    const strings = footer.split('\n')
    for (let s = 0; s < strings.length; s++) {
      if (!strings[s].startsWith('cras')) {
        continue
      }
      const cras = strings[s].split('=')[1].trim()
      const translate = cras.split(' ').map(Number)
      const nvert = Math.floor(positions.length / 3)
      let i = 0
      for (let v = 0; v < nvert; v++) {
        positions[i] += translate[0]
        i++
        positions[i] += translate[1]
        i++
        positions[i] += translate[2]
        i++
      }
    }
  }
  return {
    positions,
    indices,
  }
}
