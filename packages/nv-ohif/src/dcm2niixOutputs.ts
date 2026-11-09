import type { Series } from '@niivue/dcm2niix'

// Which dcm2niix output a viewport shows when one series converts to several
// (multi-echo, magnitude + phase, scout + acquisition, ...). Order: acquired
// ORIGINAL/PRIMARY images, the base stem over phase/real/imaginary parts, the
// lowest echo, the most voxels, then the stem. _Tilt/_Eq (gantry-tilt and
// equidistant resamples) get no preference (owner), so the voxel key may pick one.

const PART_SUFFIX = /_(ph|real|imaginary)(_|$)/
// dcm2niix sidecars spell the parts both ways (P/R/I and PHASE/REAL/IMAGINARY).
const PART_TYPES = ['P', 'PHASE', 'R', 'REAL', 'I', 'IMAGINARY']

// Voxel count from an uncompressed NIfTI-1 header (we convert with -z n);
// 0 when unknown, so such outputs rank last on this key.
export async function niftiVoxels(file: File): Promise<number> {
  const view = new DataView(await file.slice(0, 56).arrayBuffer())
  if (view.byteLength < 56) return 0
  const le = view.getInt32(0, true) === 348
  if (!le && view.getInt32(0, false) !== 348) return 0
  const rank = view.getInt16(40, le)
  if (rank < 1 || rank > 7) return 0
  let n = 1
  for (let i = 1; i <= rank; i++)
    n *= Math.max(1, view.getInt16(40 + 2 * i, le))
  return n
}

function isOriginalPrimary(s: Series): boolean {
  const type = s.json?.ImageType
  return (
    Array.isArray(type) && type.includes('ORIGINAL') && type.includes('PRIMARY')
  )
}

/** A phase/real/imaginary ImageType (sidecar or DICOM). */
export const isPartType = (type: unknown): boolean =>
  Array.isArray(type) && type.some((t) => PART_TYPES.includes(t))

// The sidecar's ImageType, as dcm2niix itself uses; the stem (which includes the
// protocol name) only without a sidecar.
export function isPart(s: Series): boolean {
  const type = s.json?.ImageType
  return Array.isArray(type) ? isPartType(type) : PART_SUFFIX.test(s.stem)
}

/** The output's echo; undefined for a single-echo series. */
export function outputEcho(s: Series): number | undefined {
  const e = s.json?.EchoNumber
  if (typeof e === 'number') return e
  // dcm2niix names echoes _e<N> even when the sidecar omits EchoNumber.
  const n = /_e(\d+)/.exec(s.stem)?.[1]
  return n === undefined ? undefined : Number(n)
}

/** NIfTI image outputs, best first by the policy above. */
export async function rankOutputs(series: Series[]): Promise<Series[]> {
  const ranked = await Promise.all(
    series
      .filter((s) => /\.nii(\.gz)?$/i.test(s.image.name))
      .map(async (s) => ({
        s,
        key: [
          isOriginalPrimary(s) ? 0 : 1,
          isPart(s) ? 1 : 0,
          outputEcho(s) ?? 1,
          -(await niftiVoxels(s.image)),
        ],
      })),
  )
  ranked.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      const d = (a.key[i] ?? 0) - (b.key[i] ?? 0)
      if (d !== 0) return d
    }
    return a.s.stem < b.s.stem ? -1 : a.s.stem > b.s.stem ? 1 : 0
  })
  return ranked.map((r) => r.s)
}
