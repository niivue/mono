import { maybeDecompress } from '@/codecs/NVGz'
import { log } from '@/logger'
import type { MZ3 } from '@/NVTypes'
import { read as readASC } from './asc'

export const extensions = ['SRF']
export const type = 'mz3'

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 35 && bytes[1] === 33 && bytes[2] === 97) {
    // .srf also used for freesurfer "#!ascii version"
    return readASC(buffer)
  }
  buffer = await maybeDecompress(buffer)
  const reader = new DataView(buffer)
  const ver = reader.getFloat32(0, true)
  const nVert = reader.getUint32(8, true)
  const nTri = reader.getUint32(12, true)
  const oriX = reader.getFloat32(16, true)
  const oriY = reader.getFloat32(20, true)
  const oriZ = reader.getFloat32(24, true)
  const positions = new Float32Array(nVert * 3)
  let pos = 28
  let j = 1 // BrainVoyager X is Talairach Y
  for (let i = 0; i < nVert; i++) {
    positions[j] = -reader.getFloat32(pos, true) + oriX
    j += 3
    pos += 4
  }
  j = 2 // BrainVoyager Y is Talairach Z
  for (let i = 0; i < nVert; i++) {
    positions[j] = -reader.getFloat32(pos, true) + oriY
    j += 3
    pos += 4
  }
  j = 0 // BrainVoyager Z is Talairach X
  for (let i = 0; i < nVert; i++) {
    positions[j] = -reader.getFloat32(pos, true) + oriZ
    j += 3
    pos += 4
  }
  pos = 28 + 4 * 6 * nVert
  const rVex = reader.getFloat32(pos, true)
  const gVex = reader.getFloat32(pos + 4, true)
  const bVex = reader.getFloat32(pos + 8, true)
  const rCave = reader.getFloat32(pos + 16, true)
  const gCave = reader.getFloat32(pos + 20, true)
  const bCave = reader.getFloat32(pos + 24, true)
  pos += 8 * 4
  const colors = new Float32Array(nVert * 3)
  const colorsIdx = new Uint32Array(buffer, pos, nVert)
  j = 0
  for (let i = 0; i < nVert; i++) {
    const c = colorsIdx[i]
    if (c > 1056964608) {
      colors[j + 0] = ((c >> 16) & 0xff) / 255
      colors[j + 1] = ((c >> 8) & 0xff) / 255
      colors[j + 2] = (c & 0xff) / 255
    }
    if (c === 0) {
      colors[j + 0] = rVex
      colors[j + 1] = gVex
      colors[j + 2] = bVex
    }
    if (c === 1) {
      colors[j + 0] = rCave
      colors[j + 1] = gCave
      colors[j + 2] = bCave
    }
    j += 3
  }
  pos += nVert * 4
  for (let i = 0; i < nVert; i++) {
    const nNearest = reader.getUint32(pos, true)
    pos += 4 + 4 * nNearest
  }
  const indices = new Uint32Array(nTri * 3)
  for (let i = 0; i < nTri * 3; i++) {
    indices[i] = reader.getInt32(pos, true)
    pos += 4
  }
  if (ver !== 4) {
    log.warn('Not valid SRF')
  }
  return {
    positions,
    indices,
    colors,
  }
}
