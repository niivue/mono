import type NiiVue from '@niivue/niivue'
import { isPart, outputEcho, rankOutputs } from './dcm2niixOutputs'
import { retrieveInstanceUrlFromImageId } from './dicomWadoRs'
import { updateNiivueViewport } from './niivueRegistry'
import type { OhifDisplaySet } from './ohif-types'
import { type InstanceRef, reconstructInstanceFiles } from './reconstructP10'
import { sharedTask } from './sharedTask'
import { buildSliceFrames, type SliceFrames } from './sliceFrames'
import { petSuvFactor, scaleNifti } from './suv'

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
async function fetchDicomInstanceFiles(
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
  /** Slice -> source frame of `image`, for measurement identity. */
  sliceFrames?: SliceFrames
  /** dcm2niix's sidecar for `image` (a SEG's names its segments). */
  json?: Record<string, unknown>
  /**
   * The other single-slice outputs when `image` is one too (orthogonal
   * localizers in one series): a cornerstone stack scrolls through them all.
   */
  alternates?: Array<{ image: File; sliceFrames?: SliceFrames }>
}

/**
 * Convert a DICOMweb display set via dcm2niix and pick the output to show by
 * policy (rankOutputs). Null when there is nothing to fetch; rejects when no
 * image converted (with dcm2niix's log tail), on fetch failure, or on abort.
 * Viewports showing the same display set share one fetch + conversion
 * (sharedTask); `signal` releases this caller's hold.
 */
export function convertDisplaySetToNifti(
  ds: OhifDisplaySet,
  options: DicomConvertOptions = {},
): Promise<DicomConversion | null> {
  const refs = instanceRefs(ds)
  if (refs.length === 0) return Promise.resolve(null)
  const key = `${ds.displaySetInstanceUID ?? ''}|${refs[0]?.url}|${refs.length}`
  return sharedTask(
    key,
    (signal, onProgress) =>
      convertUnshared(ds, { ...options, signal, onProgress }),
    options,
  ).then((c) => c && inSuv(c, petSuvFactor(ds)))
}

// PET in SUVbw, as OHIF scales it for cornerstone (window presets, readouts).
// Applied per call, outside the shared conversion: the petSUV panel edits the
// instances' weight/dose in place, and a reload must not reuse the old factor.
async function inSuv(
  c: DicomConversion,
  suv: number | undefined,
): Promise<DicomConversion> {
  if (!suv) return c
  const scale = async <T extends { image: File }>(o: T) => ({
    ...o,
    image: await scaleNifti(o.image, suv),
  })
  return {
    ...(await scale(c)),
    ...(c.alternates && {
      alternates: await Promise.all(c.alternates.map(scale)),
    }),
  }
}

async function convertUnshared(
  ds: OhifDisplaySet,
  options: DicomConvertOptions,
): Promise<DicomConversion | null> {
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
  if (exitCode !== exitCodes.ok) {
    // The last line is often a summary; the cause is the last error/warning.
    const cause = log.findLast((l) => /error|warn/i.test(l)) ?? log.at(-1) ?? ''
    notes.push(`dcm2niix exit ${exitCode} (${exitName}): ${cause}`)
  }
  const frameMap = async (o: (typeof outputs)[number]) =>
    buildSliceFrames(
      await o.image.slice(0, 348).arrayBuffer(),
      ds.instances ?? [],
      { echo: outputEcho(o), part: isPart(o) },
    )
  const sliceFrames = await frameMap(shown)
  const alternates =
    sliceFrames?.frames.length === 1
      ? (
          await Promise.all(
            others.map(async (o) => ({
              image: o.image,
              sliceFrames: await frameMap(o),
            })),
          )
        ).filter((o) => o.sliceFrames?.frames.length === 1)
      : []
  // Outputs the stack does not reach are named.
  const unshown = others.filter(
    (o) => !alternates.some((a) => a.image === o.image),
  )
  if (unshown.length > 0)
    notes.unshift(
      `Showing ${shown.stem}; also converted: ${unshown.map((s) => s.stem).join(', ')}.`,
    )
  return {
    image: shown.image,
    json: shown.json,
    note: notes.length > 0 ? notes.join(' ') : undefined,
    sliceFrames,
    ...(alternates.length > 0 ? { alternates } : {}),
  }
}

/**
 * Load `converted` into `nv`, publishing its slice map only once that volume
 * shows: until then (or after a failed load, which keeps the old volume) a
 * measurement must not take this series' DICOM identity. False when
 * `cancelled()`: before the swap-in, nothing is installed.
 */
export async function loadConversion(
  nv: Pick<NiiVue, 'prepareVolume' | 'loadVolumes'>,
  viewportId: string,
  converted: DicomConversion,
  spec:
    | {
        calMin?: number
        calMax?: number
        colormap?: string
        isColormapInverted?: boolean
      }
    | undefined,
  cancelled: () => boolean,
): Promise<boolean> {
  // The converted file's own name (.nii) lets NiiVue sniff the format.
  const { image } = converted
  try {
    const volume = await nv.prepareVolume({
      url: image,
      name: image.name,
      ...spec,
    })
    // A swapped-away load must not replace the newer base.
    if (cancelled()) return false
    await nv.loadVolumes([volume])
  } catch (err) {
    if (!cancelled())
      updateNiivueViewport(viewportId, { sliceFrames: undefined })
    throw err
  }
  if (cancelled()) return false
  updateNiivueViewport(viewportId, { sliceFrames: converted.sliceFrames })
  return true
}
