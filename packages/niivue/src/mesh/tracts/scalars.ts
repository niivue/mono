import { log } from '@/logger'
import * as NVLoader from '@/NVLoader'
import type { MeshLayerFromUrlOptions, NVTractData } from '@/NVTypes'

/** Extensions that provide per-vertex scalar data for tracts. */
const dpvExtensions = new Set(['TSF'])

/** Extensions that provide per-streamline scalar data for tracts. */
const dpsExtensions = new Set(['TXT'])

/** Check whether a file extension is a tract scalar overlay format. */
export function isTractScalarExtension(ext: string): boolean {
  const upper = ext.toUpperCase()
  return dpvExtensions.has(upper) || dpsExtensions.has(upper)
}

/**
 * Read MRtrix TSF (Track Scalar File) format — per-vertex scalars.
 * https://mrtrix.readthedocs.io/en/dev/getting_started/image_data.html#track-scalar-file-format-tsf
 *
 * Same binary layout as TCK but with one float per vertex instead of xyz triples.
 * NaN marks streamline boundaries, Infinity marks EOF.
 */
function readTSF(buffer: ArrayBuffer, nVertices: number): Float32Array {
  const len = buffer.byteLength
  if (len < 20) throw new Error('File too small to be TSF')
  const bytes = new Uint8Array(buffer)
  let pos = 0

  function readLine(): string {
    while (pos < len && bytes[pos] === 10) pos++
    const start = pos
    while (pos < len && bytes[pos] !== 10) pos++
    pos++
    return new TextDecoder().decode(buffer.slice(start, pos - 1))
  }

  const sig = readLine()
  if (!sig.includes('mrtrix track scalars')) {
    throw new Error('Not a valid TSF file')
  }

  let dataOffset = -1
  let line = ''
  while (pos < len && !line.includes('END')) {
    line = readLine()
    if (line.toLowerCase().startsWith('file:')) {
      dataOffset = parseInt(line.split(' ').pop() as string, 10)
    }
    if (
      line.toLowerCase().startsWith('datatype:') &&
      !line.endsWith('Float32LE')
    ) {
      throw new Error('Only supports TSF files with Float32LE')
    }
  }
  if (dataOffset < 20)
    throw new Error('Not a valid TSF file (missing file offset)')

  pos = dataOffset
  const reader = new DataView(buffer)
  const vals = new Float32Array(nVertices)
  let npt = 0

  while (pos + 4 <= len && npt < nVertices) {
    const v = reader.getFloat32(pos, true)
    pos += 4
    if (!Number.isFinite(v)) {
      if (!Number.isNaN(v)) break // Infinity = EOF
    } else {
      vals[npt++] = v
    }
  }

  return vals
}

/**
 * Read per-streamline scalars from a plain text file (one value per line).
 * Used by MRtrix workflows for data-per-streamline.
 */
function readTXT(buffer: ArrayBuffer, nStreamlines: number): Float32Array {
  const text = new TextDecoder('utf-8').decode(buffer)
  const lines = text.split(/\r?\n|\r/).filter((l) => l.trim().length > 0)
  const n = nStreamlines > 0 ? nStreamlines : lines.length
  const vals = new Float32Array(n)
  for (let i = 0; i < n && i < lines.length; i++) {
    const v = parseFloat(lines[i].trim())
    vals[i] = Number.isFinite(v) ? v : 0.0
  }
  return vals
}

/**
 * Load tract scalar layers (TSF, TXT) and inject into tract data.
 * TSF files add per-vertex scalars (dpv); TXT files add per-streamline scalars (dps).
 */
export async function loadTractScalars(
  tractData: NVTractData,
  layers: MeshLayerFromUrlOptions[],
): Promise<void> {
  const nVertices = tractData.vertices.length / 3
  const nStreamlines = tractData.offsets.length - 1

  for (const layer of layers) {
    const ext = NVLoader.getFileExt(layer.url).toUpperCase()
    if (!dpvExtensions.has(ext) && !dpsExtensions.has(ext)) continue

    const buffer = await NVLoader.fetchFile(layer.url)
    const fullName = NVLoader.getName(layer.url)
    const fileName = fullName.split('/').pop() ?? fullName
    // Strip the extension to get the scalar name
    const dotExt = `.${ext.toLowerCase()}`
    const name =
      layer.name ??
      (fileName.toLowerCase().endsWith(dotExt)
        ? fileName.slice(0, -dotExt.length)
        : fileName)

    if (dpvExtensions.has(ext)) {
      tractData.dpv[name] = readTSF(buffer, nVertices)
      log.debug(`Loaded tract dpv "${name}" from TSF: ${nVertices} values`)
    } else {
      tractData.dps[name] = readTXT(buffer, nStreamlines)
      log.debug(`Loaded tract dps "${name}" from TXT: ${nStreamlines} values`)
    }
  }
}
