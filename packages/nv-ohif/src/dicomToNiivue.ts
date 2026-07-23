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
  const { Dcm2niix } = await import('@niivue/dcm2niix')
  const dcm2niix = new Dcm2niix()
  try {
    await dcm2niix.init()
    // The Dcm2niix wrapper rejects with only the worker's error message (often
    // empty for an Emscripten exit-unwind in a Worker). Log the full detail the
    // worker also posts so failures are diagnosable.
    dcm2niix.worker?.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { type?: string; message?: string; error?: string }
      if (data?.type === 'error') {
        console.error(
          '[nv-ohif] dcm2niix worker error',
          data.message,
          data.error,
        )
      }
    })
    const result = await dcm2niix.input(files).run()
    const nifti = result
      .filter((f) => /\.nii(\.gz)?$/i.test(f.name))
      .sort((a, b) => b.size - a.size)
    return nifti[0] ?? null
  } finally {
    dcm2niix.worker?.terminate()
  }
}
