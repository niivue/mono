import type { OhifDisplaySet } from './ohif-types'
import {
  framesUrlFromImageId,
  reconstructInstanceFiles,
} from './reconstructP10'

// Phase 2 DICOM bridge: turn a DICOMweb display set into a NIfTI volume, then load
// it with NiiVue. We reconstruct original-style DICOM Part-10 files from what any
// DICOMweb server exposes (`/metadata` + per-frame pixels) and convert them with the
// `@niivue/dcm2niix` WebAssembly build. dcm2niix owns the DICOM->NIfTI orientation/
// affine work, so we don't hand-roll LPS->RAS.
//
// Reconstruction (rather than WADO-RS RetrieveInstance) is deliberate: it works
// against static/CloudFront demo servers too, which return 403 for the full-instance
// P10 resource. dcm2niix is dynamically imported so its WASM only loads on a DICOM
// series.

export interface DicomConvertOptions {
  /** Extra request headers (e.g. an Authorization header from OHIF's auth service). */
  headers?: Record<string, string>
  /** Called as instances are fetched, then once more when conversion starts. */
  onProgress?: (
    phase: 'fetching' | 'converting',
    loaded: number,
    total: number,
  ) => void
  signal?: AbortSignal
  /** Max concurrent instance fetches. Default 6. */
  concurrency?: number
}

/** Ordered, de-duplicated per-instance frame pixel URLs for a display set. */
function instanceFramesUrls(ds: OhifDisplaySet): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const inst of ds.instances ?? []) {
    const id = inst.imageId
    const url = typeof id === 'string' ? framesUrlFromImageId(id) : null
    if (url && !seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }
  return urls
}

/**
 * Fetch every instance of a DICOMweb display set as a reconstructed DICOM P10 File.
 * Fetches run with bounded concurrency; progress is reported per instance.
 */
export async function fetchDicomInstanceFiles(
  ds: OhifDisplaySet,
  options: DicomConvertOptions = {},
): Promise<File[]> {
  const { headers, onProgress, signal, concurrency } = options
  const framesUrls = instanceFramesUrls(ds)
  if (framesUrls.length === 0) return []
  return reconstructInstanceFiles(framesUrls, {
    headers,
    signal,
    concurrency,
    onProgress: (loaded, total) => onProgress?.('fetching', loaded, total),
  })
}

/**
 * Convert a DICOMweb display set to a single NIfTI File via dcm2niix. Returns the
 * primary NIfTI output (largest `.nii`/`.nii.gz`), or null if nothing converted.
 * dcm2niix is dynamically imported so its WASM only loads on a DICOM series.
 */
export async function convertDisplaySetToNifti(
  ds: OhifDisplaySet,
  options: DicomConvertOptions = {},
): Promise<File | null> {
  const files = await fetchDicomInstanceFiles(ds, options)
  if (files.length === 0) return null

  options.onProgress?.('converting', 0, 1)
  const { convert, exitCodes } = await import('@niivue/dcm2niix')
  // convert() owns the worker (terminated afterwards) and resolves for any exit
  // code; keep the previous contract of rejecting unless dcm2niix succeeds.
  const {
    files: outputs,
    exitCode,
    log,
  } = await convert(files, {
    signal: options.signal,
  })
  if (exitCode !== exitCodes.ok)
    throw new Error(
      `dcm2niix exit code ${exitCode}: ${log.slice(-3).join(' | ')}`,
    )
  const nifti = outputs
    .filter((f) => /\.nii(\.gz)?$/i.test(f.name))
    .sort((a, b) => b.size - a.size)
  // dcm2niix legitimately splits some series into several NIfTI outputs
  // (multi-echo, multiple orientations, scout + acquisition). We show only the
  // largest as the primary volume; surface the rest so a wrong/partial pick is
  // diagnosable instead of silently discarded. (Loading/selecting among the
  // split volumes is a follow-up.)
  if (nifti.length > 1) {
    console.warn(
      `[nv-ohif] dcm2niix produced ${nifti.length} NIfTI volumes for this series; ` +
        `showing the largest ("${nifti[0]?.name}"). Others not shown: ` +
        nifti
          .slice(1)
          .map((f) => f.name)
          .join(', '),
    )
  }
  return nifti[0] ?? null
}
