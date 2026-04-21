import { decompress } from '@/codecs/NVGz'
import { log } from '@/logger'
import type { LUT } from '@/NVTypes'

export const extensions = ['SMP']

export type LayerReadResult = {
  values: Float32Array
  nFrame4D: number
  colormapLabel?: LUT | null
}

/**
 * Read BrainVoyager Statistical Map (SMP) format.
 * https://support.brainvoyager.com/brainvoyager/automation-development/84-file-formats/40-the-format-of-smp-files
 */
export async function read(
  buffer: ArrayBuffer,
  nVert: number,
): Promise<LayerReadResult> {
  let reader = new DataView(buffer)
  let vers = reader.getUint16(0, true)
  if (vers > 5) {
    // Likely gzip-compressed
    const raw = await decompress(new Uint8Array(buffer))
    reader = new DataView(raw.buffer as ArrayBuffer)
    vers = reader.getUint16(0, true)
    buffer = raw.buffer as ArrayBuffer
  }
  if (vers > 5) {
    throw new Error(`Unsupported BrainVoyager SMP version ${vers}`)
  }
  const nvert = reader.getUint32(2, true)
  if (nvert !== nVert) {
    log.warn(`SMP file has ${nvert} vertices, background mesh has ${nVert}`)
  }
  const nMaps = reader.getUint16(6, true)
  const len = buffer.byteLength
  const scalars = new Float32Array(nvert * nMaps)
  let pos = 9

  function readStr(): string {
    const startPos = pos
    while (pos < len && reader.getUint8(pos) !== 0) {
      pos++
    }
    pos++ // skip null termination
    return new TextDecoder().decode(buffer.slice(startPos, pos - 1))
  }

  // Read SRF filename
  readStr()

  for (let i = 0; i < nMaps; i++) {
    // mapType
    const mapType = reader.getUint32(pos, true)
    pos += 4
    // Read additional values for lag maps
    if (vers >= 3 && mapType === 3) {
      pos += 16 // nLags(4) + mnLag(4) + mxLag(4) + ccOverlay(4)
    }
    pos += 4 // clusterSize
    pos += 1 // clusterCheck
    pos += 4 // critThresh
    pos += 4 // maxThresh
    if (vers >= 4) {
      pos += 4 // includeValuesGreaterThreshMax
    }
    pos += 4 // df1
    pos += 4 // df2
    if (vers >= 5) {
      pos += 4 // posNegFlag
    }
    pos += 4 // cortexBonferroni
    if (vers >= 2) {
      pos += 3 // posMinRGB
      pos += 3 // posMaxRGB
      if (vers >= 4) {
        pos += 3 // negMinRGB
        pos += 3 // negMaxRGB
      }
      pos += 1 // enableSMPColor
      if (vers >= 4) {
        readStr() // LUT name
      }
      pos += 4 // colorAlpha
    }
    readStr() // map name
    const scalarsNew = new Float32Array(buffer, pos, nvert)
    scalars.set(scalarsNew, i * nvert)
    pos += nvert * 4
  }
  return { values: scalars, nFrame4D: nMaps }
}
