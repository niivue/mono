// PET body-weight SUV, as OHIF's default extension scales PT for cornerstone
// (@cornerstonejs/calculate-suv); nv-ohif takes no OHIF dependency, so the
// standard case is computed here from the instance's naturalized tags.
// ponytail: no vendor quirks (Philips CNTS private factor, GE post-injection
// series time); those series stay in Bq/ml. Port calculate-suv's if they matter.

type Tags = Record<string, unknown>

const first = (v: unknown): Tags | undefined =>
  (Array.isArray(v) ? v[0] : v) as Tags | undefined

/** DICOM DA + TM (or one DT) -> seconds; NaN when malformed. */
function seconds(dt: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2}):?(\d{2}):?(\d{2}(?:\.\d+)?)/.exec(dt)
  if (!m) return Number.NaN
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  return Date.UTC(y, mo - 1, d, h, mi) / 1000 + s
}

/** SUVbw per Bq/ml for a decay-corrected BQML PET instance, else undefined. */
export function suvBwFactor(inst: Tags | undefined): number | undefined {
  const rp = first(inst?.RadiopharmaceuticalInformationSequence)
  if (!inst || !rp || inst.Units !== 'BQML') return undefined
  const weightG = Number(inst.PatientWeight) * 1000
  const dose = Number(rp.RadionuclideTotalDose)
  const halfLife = Number(rp.RadionuclideHalfLife)
  let decay = 1
  if (inst.DecayCorrection === 'START') {
    const scan = seconds(`${inst.SeriesDate}${inst.SeriesTime}`)
    const injected = seconds(
      String(
        rp.RadiopharmaceuticalStartDateTime ??
          `${inst.SeriesDate}${rp.RadiopharmaceuticalStartTime}`,
      ),
    )
    // A time-only injection before midnight would read as a later one: the
    // elapsed time is unknowable, so decline (as calculate-suv does).
    if (!(scan >= injected)) return undefined
    decay = 2 ** (-(scan - injected) / halfLife)
  } else if (inst.DecayCorrection !== 'ADMIN') return undefined
  const f = weightG / (dose * decay)
  return Number.isFinite(f) && f > 0 ? f : undefined
}

/** The SUVbw factor dicomToNiivue applies to a display set (PT only). */
export const petSuvFactor = (ds?: {
  Modality?: unknown
  instances?: ReadonlyArray<Tags>
}): number | undefined =>
  ds?.Modality === 'PT' ? suvBwFactor(ds.instances?.[0]) : undefined

/** `nii` with its scl_slope/scl_inter multiplied by `f` (header only). */
export async function scaleNifti(nii: File, f: number): Promise<File> {
  const hdr = new DataView(await nii.slice(0, 348).arrayBuffer())
  const le = hdr.getInt32(0, true) === 348
  const slope = hdr.getFloat32(112, le) || 1 // 0 means unscaled
  hdr.setFloat32(112, slope * f, le)
  hdr.setFloat32(116, hdr.getFloat32(116, le) * f, le)
  return new File([hdr.buffer, nii.slice(348)], nii.name)
}
