import type { Series } from '@niivue/dcm2niix'
import type NiiVue from '@niivue/niivue'
import type { VolumeFrameSource } from '@niivue/niivue'
import {
  isOverlayPlane,
  isPart,
  outputEcho,
  rankOutputs,
} from './dcm2niixOutputs'
import { retrieveInstanceUrlFromImageId } from './dicomWadoRs'
import { split4D } from './frames4D'
import { idcS3Files, isIdcProxyUrl } from './idcS3'
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
  // A just-saved SEG/RTSS keeps a local `dicomfile:` imageId (OHIF registers
  // the written dataset): it is on the data source too, under its UIDs.
  const root = (ds as { wadoRoot?: unknown }).wadoRoot
  for (const inst of ds.instances ?? []) {
    const id = inst.imageId
    const url =
      (typeof id === 'string' ? retrieveInstanceUrlFromImageId(id) : null) ??
      (typeof root === 'string' && inst.SOPInstanceUID
        ? retrieveInstanceUrlFromImageId(
            `${root}/studies/${inst.StudyInstanceUID}/series/${inst.SeriesInstanceUID}/instances/${inst.SOPInstanceUID}`,
          )
        : null)
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
  const refs = instanceRefs(ds)
  // An IDC series comes whole from its public S3 objects (idcS3.ts).
  const series = ds.SeriesInstanceUID as string | undefined
  const fetching = (loaded: number, total: number) =>
    onProgress?.('fetching', loaded, total)
  if (series && refs[0] && isIdcProxyUrl(refs[0].url)) {
    const files = await idcS3Files(series, refs.length, {
      signal,
      concurrency,
      onProgress: fetching,
    })
    if (files) return files
  }
  return reconstructInstanceFiles(refs, {
    headers,
    signal,
    concurrency,
    onProgress: fetching,
  })
}

export interface DicomConversion {
  /** The output to show, picked by rankOutputs. */
  image: File
  /** Names the outputs not shown and/or warns of a partial conversion. */
  note?: string
  /** Slice -> source frame of `image`, for measurement identity. */
  sliceFrames?: SliceFrames
  /** A 4D series: `image` is frame 0, frames come from here (frames4D.ts). */
  frames?: VolumeFrameSource
  /** dcm2niix's sidecar for `image` (a SEG's names its segments). */
  json?: Record<string, unknown>
  /**
   * The other outputs mapped to the display set's instances (orthogonal
   * localizers in one series): a cornerstone stack scrolls through them all.
   */
  alternates?: Array<{
    image: File
    sliceFrames?: SliceFrames
    overlayPlanes?: File[]
  }>
  /** `image`'s DICOM overlay planes (dcm2niix `<stem>_ROI<n>`), on its grid. */
  overlayPlanes?: File[]
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
  // Every input (instance URL + frame count): a re-made display set reuses its UID.
  // Headers too: a refreshed Authorization must not join a fetch with the old one.
  const headers = JSON.stringify(Object.entries(options.headers ?? {}).sort())
  const key = `${ds.displaySetInstanceUID ?? ''}|${headers}|${refs.map((r) => `${r.url}#${r.frames}`).join('|')}`
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

/**
 * The 4D frame group a conversion joins: its display set and inputs, so a
 * re-made display set (same UID, other instances) does not join panes still
 * showing the old data.
 */
export const frameGroupKey = (ds: OhifDisplaySet): string | undefined =>
  ds.displaySetInstanceUID &&
  `${ds.displaySetInstanceUID}|${urlDigest(instanceRefs(ds).map((r) => r.url))}`

// cyrb53 over the joined URLs: frames4D keeps every key for the session, and
// a 4D series can have thousands of instances. 32-bit FNV-1a collided (test).
function urlDigest(urls: string[]): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  const s = urls.join('|')
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${urls.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
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
  const ranked = await rankOutputs(series)
  const exitName =
    Object.entries(exitCodes).find(([, v]) => v === exitCode)?.[0] ?? 'unknown'
  if (!ranked[0])
    throw new Error(
      `dcm2niix produced no image (exit ${exitCode} ${exitName}): ${log.slice(-5).join(' | ')}`,
    )
  const notes: string[] = []
  if (exitCode !== exitCodes.ok) {
    // The last line is often a summary; the cause is the last error/warning.
    const cause = log.findLast((l) => /error|warn/i.test(l)) ?? log.at(-1) ?? ''
    notes.push(`dcm2niix exit ${exitCode} (${exitName}): ${cause}`)
  }
  const mapped = await Promise.all(
    ranked.map(async (o) => {
      const sf = buildSliceFrames(
        await o.image.slice(0, 348).arrayBuffer(),
        ds.instances ?? [],
        { echo: outputEcho(o), part: isPart(o) },
      )
      // Only an output holding an acquired frame has a place in the stack: not
      // a resampled _Tilt/_Eq one, nor an image without orientation.
      return { o, sf, isMapped: Boolean(sf?.frames.some(Boolean)) }
    }),
  )
  // The policy pick when oriented (frames sharing one position, a 4D cine or
  // surview, stay unmapped but win on size); past orientation-less summary
  // pages, the first mapped output, else the first oriented one, as
  // cornerstone opens a surview. Every mapped output, multi-frame ones too,
  // joins the stack (outputStack.ts).
  const top = mapped[0]
  const pick = top?.sf
    ? top
    : (mapped.find((m) => m.isMapped) ?? mapped.find((m) => m.sf) ?? top)
  if (!pick) throw new Error('dcm2niix produced no image')
  const shown = pick.o
  const sliceFrames = pick.sf
  const others = mapped.filter((m) => m !== pick).map((m) => m.o)
  // Mapped outputs only: a pick without orientation means none is mapped.
  const alternates = mapped
    // Another echo or image part shares the slices: the stack would swap
    // volumes on every wheel step. It stays named, as before.
    .filter(
      (m) =>
        m !== pick &&
        m.isMapped &&
        outputEcho(m.o) === outputEcho(shown) &&
        isPart(m.o) === isPart(shown),
    )
    .map((m) => ({
      image: m.o.image,
      sliceFrames: m.sf,
      ...overlayPlanesOf(series, m.o.stem),
    }))
  // Outputs the stack does not reach are named.
  const unshown = others.filter(
    (o) => !alternates.some((a) => a.image === o.image),
  )
  if (unshown.length > 0)
    notes.unshift(
      `Showing ${shown.stem}; also converted: ${unshown.map((s) => s.stem).join(', ')}.`,
    )
  const split = await split4D(shown.image, frameGroupKey(ds))
  return {
    image: split?.image ?? shown.image,
    ...(split && { frames: split.frames }),
    json: shown.json,
    note: notes.length > 0 ? notes.join(' ') : undefined,
    sliceFrames,
    ...(alternates.length > 0 ? { alternates } : {}),
    ...overlayPlanesOf(series, shown.stem),
  }
}

function overlayPlanesOf(series: Series[], stem: string) {
  const planes = series
    .filter((s) => isOverlayPlane(s) && s.stem.startsWith(`${stem}_ROI`))
    .map((s) => s.image)
  return planes.length > 0 ? { overlayPlanes: planes } : {}
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
      frameSource: converted.frames,
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
