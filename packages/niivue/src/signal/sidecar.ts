import type { SignalSidecar } from '@/NVTypes'

/**
 * Derive the sibling `.json` sidecar path for a signal data file by stripping
 * the data extension and appending `.json`. Handles the double extensions
 * (`.tsv.gz`, `.nii.gz`) that NiiVue signals use.
 */
export function siblingJsonUrl(dataPath: string): string {
  const lower = dataPath.toLowerCase()
  for (const suffix of ['.tsv.gz', '.tsv', '.nii.gz', '.nii']) {
    if (lower.endsWith(suffix)) {
      return `${dataPath.slice(0, dataPath.length - suffix.length)}.json`
    }
  }
  const dot = dataPath.lastIndexOf('.')
  return dot >= 0 ? `${dataPath.slice(0, dot)}.json` : `${dataPath}.json`
}

function firstNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (Array.isArray(v) && typeof v[0] === 'number') return v[0]
  return undefined
}

function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return undefined
}

/**
 * Normalize a parsed BIDS JSON object into a {@link SignalSidecar}.
 *
 * Note: `SpectrometerFrequency` is the authoritative MRS field and the only one
 * used for spectroscopy detection. `ImagingFrequency` is present in essentially
 * every MR sidecar (including plain fMRI), so it is deliberately NOT treated as
 * an MRS marker here; a ppm fallback to it can be added once a file is already
 * known to be spectroscopy.
 */
export function parseSidecar(json: unknown): SignalSidecar {
  const out: SignalSidecar = {}
  if (!json || typeof json !== 'object') return out
  const j = json as Record<string, unknown>
  // physio
  if (Array.isArray(j.Columns)) {
    out.columns = j.Columns.filter((c): c is string => typeof c === 'string')
  }
  const fs = firstNumber(j.SamplingFrequency)
  if (fs !== undefined) out.samplingFrequency = fs
  const st = firstNumber(j.StartTime)
  if (st !== undefined) out.startTime = st
  // spectroscopy (MRS)
  const sf = firstNumber(j.SpectrometerFrequency)
  if (sf !== undefined) out.spectrometerFrequency = sf
  const nuc = firstString(j.ResonantNucleus)
  if (nuc !== undefined) out.resonantNucleus = nuc
  const dwell = firstNumber(j.DwellTime)
  if (dwell !== undefined) out.dwellTime = dwell
  return out
}

/** True when the sidecar carries MRS-defining fields (used for NIfTI routing). */
export function hasMrsFields(s: SignalSidecar): boolean {
  return (
    s.spectrometerFrequency !== undefined || s.resonantNucleus !== undefined
  )
}

/**
 * Fetch and parse the sibling `.json` sidecar for a URL-loaded signal. Returns
 * an empty sidecar when none is present or it cannot be read (404 / sandbox
 * tolerant).
 */
export async function fetchSidecar(dataUrl: string): Promise<SignalSidecar> {
  try {
    const resp = await fetch(siblingJsonUrl(dataUrl))
    if (!resp.ok) return {}
    return parseSidecar(await resp.json())
  } catch {
    return {}
  }
}
