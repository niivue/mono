import type { NVTractData } from '@/NVTypes'

export const extensions = ['TRACT']

/** Port of NiiVue 0.6's readTRACT; AFNI's TrackIO.h defines int,int,float[#2]. */
export async function read(buffer: ArrayBufferLike): Promise<NVTractData> {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const decoder = new TextDecoder()
  let pos = 0

  function readTag(): string {
    while (pos < bytes.length && bytes[pos] <= 32) pos++
    const end = bytes.indexOf(62, pos)
    if (bytes[pos] !== 60 || end < 0)
      throw new Error('Invalid NIML tract header')
    const tag = decoder.decode(bytes.subarray(pos, end + 1))
    pos = end + 1
    return tag
  }

  function attribute(tag: string, name: string): string | undefined {
    return new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag)?.[1]
  }

  const network = readTag()
  const count = Number(attribute(network, 'N_tracts'))
  if (
    !/^<network\s/.test(network) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > (bytes.length - pos) / 8
  )
    throw new Error('Invalid NIML tract count')

  // Bound storage by the input, not the untrusted point counts in each record.
  const vertices = new Float32Array(Math.floor(bytes.length / 4))
  const offsets = new Uint32Array(count + 1)
  // AFNI bundle tags are C ints; Float32 would merge tags above 2^24.
  const bundleTags = new Int32Array(count)
  let nValues = 0
  let nTracts = 0
  while (nTracts < count) {
    const tag = readTag()
    const form = attribute(tag, 'ni_form')
    if (
      !/^<tracts\s/.test(tag) ||
      attribute(tag, 'ni_type') !== 'TAYLOR_TRACT_DATUM' ||
      (form !== 'binary.lsbfirst' && form !== 'binary.msbfirst')
    )
      throw new Error('Unsupported NIML tract encoding')
    const littleEndian = form === 'binary.lsbfirst'
    const nBundle = Number(attribute(tag, 'ni_dimen'))
    const bundleTag = Number(attribute(tag, 'Bundle_Tag') ?? '0')
    if (
      !Number.isSafeInteger(nBundle) ||
      nBundle < 0 ||
      nBundle > count - nTracts ||
      bundleTag !== (bundleTag | 0) // int32 only; also rejects NaN and fractions
    )
      throw new Error('Invalid NIML tract bundle')

    for (let i = 0; i < nBundle; i++) {
      if (pos + 8 > bytes.length) throw new Error('Truncated NIML tract')
      const n = view.getInt32(pos + 4, littleEndian)
      pos += 8 // Skip the tract ID and coordinate count.
      if (n < 0 || n % 3 !== 0 || n > (bytes.length - pos) / 4)
        throw new Error('Invalid NIML tract point count')
      const end = pos + n * 4
      // AFNI RAI coordinates increase toward L/P/S; convert to NiiVue R/A/S.
      while (pos < end) {
        vertices[nValues++] = -view.getFloat32(pos, littleEndian)
        vertices[nValues++] = -view.getFloat32(pos + 4, littleEndian)
        vertices[nValues++] = view.getFloat32(pos + 8, littleEndian)
        pos += 12
      }
      bundleTags[nTracts++] = bundleTag
      offsets[nTracts] = nValues / 3
    }
    if (readTag() !== '</tracts>') throw new Error('Unclosed NIML tracts')
  }

  return {
    vertices: vertices.slice(0, nValues),
    offsets,
    dpv: {},
    dps: { tract: bundleTags },
    groups: {},
    dpvMeta: {},
    dpsMeta: {},
  }
}
