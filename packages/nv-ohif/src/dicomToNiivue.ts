import { rankOutputs } from './dcm2niixOutputs'
import { retrieveInstanceUrlFromImageId } from './dicomWadoRs'
import type { OhifDisplaySet } from './ohif-types'
import { type InstanceRef, reconstructInstanceFiles } from './reconstructP10'

// Phase 2 DICOM bridge: turn a DICOMweb display set into a NIfTI volume, then load
// it with NiiVue. We fetch DICOM Part-10 files (RetrieveInstance, else reconstructed
// from `/metadata` + per-frame pixels; see reconstructP10) and convert them with the
// `@niivue/dcm2niix` WebAssembly build. dcm2niix owns the DICOM->NIfTI orientation/
// affine work, so we don't hand-roll LPS->RAS. dcm2niix is dynamically imported so
// its WASM only loads on a DICOM series.

export interface DicomConvertOptions {
  /** Extra request headers (e.g. an Authorization header from OHIF's auth service). */
  headers?: Record<string, string>
  /** Called as frames are fetched, then once more when conversion starts. */
  onProgress?: (
    phase: 'fetching' | 'converting',
    loaded: number,
    total: number,
  ) => void
  signal?: AbortSignal
  /** Max concurrent instance fetches. Default 6. */
  concurrency?: number
}

/**
 * One ref per SOP instance, in display-set order. OHIF's instance imageId is the
 * frame-1 URL (`wadors:.../instances/<sop>/frames/1`) even for a multi-frame
 * instance, so the frame count comes from NumberOfFrames.
 */
function instanceRefs(ds: OhifDisplaySet): InstanceRef[] {
  const refs = new Map<string, InstanceRef>()
  for (const inst of ds.instances ?? []) {
    const id = inst.imageId
    const url =
      typeof id === 'string' ? retrieveInstanceUrlFromImageId(id) : null
    if (url && !refs.has(url))
      refs.set(url, {
        url,
        frames: Math.max(1, Number(inst.NumberOfFrames) || 1),
      })
  }
  return [...refs.values()]
}

/**
 * Fetch every instance of a DICOMweb display set as a DICOM P10 File.
 * Fetches run with bounded concurrency; progress is reported per frame.
 */
export async function fetchDicomInstanceFiles(
  ds: OhifDisplaySet,
  options: DicomConvertOptions = {},
): Promise<File[]> {
  const { headers, onProgress, signal, concurrency } = options
  return reconstructInstanceFiles(instanceRefs(ds), {
    headers,
    signal,
    concurrency,
    onProgress: (loaded, total) => onProgress?.('fetching', loaded, total),
  })
}

export interface DicomConversion {
  /** The output to show, picked by rankOutputs. */
  image: File
  /** Names the outputs not shown and/or warns of a partial conversion. */
  note?: string
}

/**
 * Convert a DICOMweb display set via dcm2niix and pick the output to show by
 * policy (rankOutputs). Null when there is nothing to fetch; rejects when no
 * image converted (with dcm2niix's log tail), on fetch failure, or on abort.
 */
export async function convertDisplaySetToNifti(
  ds: OhifDisplaySet,
  options: DicomConvertOptions = {},
): Promise<DicomConversion | null> {
  if (instanceRefs(ds).length === 0) return null
  const files = await fetchDicomInstanceFiles(ds, options)
  if (files.length === 0) return null
  options.onProgress?.('converting', 0, 1)
  // convert() boots its worker only now. Measured in Chromium: ~10 ms warm; cold
  // adds the one-time 1.1 MB WASM download, small next to fetching a series.
  // Unlike Dcm2niix.run(), it keeps the outputs of a nonzero exit.
  const { convert, exitCodes } = await import('@niivue/dcm2niix')
  // -z n: rankOutputs reads voxel counts from the uncompressed header.
  const { series, exitCode, log } = await convert(files, {
    args: ['-z', 'n'],
    signal: options.signal,
  })
  const outputs = await rankOutputs(series)
  const [shown, ...others] = outputs
  const exitName =
    Object.entries(exitCodes).find(([, v]) => v === exitCode)?.[0] ?? 'unknown'
  if (!shown)
    throw new Error(
      `dcm2niix produced no image (exit ${exitCode} ${exitName}): ${log.slice(-5).join(' | ')}`,
    )
  const notes: string[] = []
  if (others.length > 0)
    notes.push(
      `Showing ${shown.stem}; also converted: ${others.map((s) => s.stem).join(', ')}.`,
    )
  if (exitCode !== exitCodes.ok) {
    // The last line is often a summary; the cause is the last error/warning.
    const cause = log.findLast((l) => /error|warn/i.test(l)) ?? log.at(-1) ?? ''
    notes.push(`dcm2niix exit ${exitCode} (${exitName}): ${cause}`)
  }
  return {
    image: shown.image,
    note: notes.length > 0 ? notes.join(' ') : undefined,
  }
}
