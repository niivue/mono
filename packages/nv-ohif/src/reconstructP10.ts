import { parseMultipartRelated } from '@niivue/nv-ext-tile/dicom'

// Fetch DICOM Part-10 files for dcm2niix from a DICOMweb data source: WADO-RS
// RetrieveInstance when the server allows it, else reconstruct each instance from
// `/metadata` (dicom+json) plus its per-frame pixel bulkdata, which every DICOMweb
// server serves (static S3/CloudFront stores reject RetrieveInstance with 403).
// dcm2niix then does the DICOM->NIfTI orientation/affine work.

const EXPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2.1'
// Arbitrary ImplementationClassUID under a NiiVue-owned root; identifies the writer.
const IMPLEMENTATION_CLASS_UID = '1.2.826.0.1.3680043.9.7433.1.1'

// Minimal dicom+json shapes (tag -> element). Values/bulkdata are optional per VR.
interface JsonElement {
  // Optional: some DICOMweb servers omit `vr` on certain elements. sanitizeDataset
  // drops those (dcmjs can't write an element without a VR).
  vr?: string
  Value?: unknown[]
  BulkDataURI?: string
  InlineBinary?: string
}
type JsonDataset = Record<string, JsonElement>

function firstValue<T = unknown>(el: JsonElement | undefined): T | undefined {
  return el?.Value?.[0] as T | undefined
}

/**
 * Copy a dicom+json dataset, dropping the file-meta group and PixelData, and
 * recursively dropping any element that has no materialized `Value` (BulkDataURI /
 * InlineBinary references, incl. those nested in sequences). dcmjs' binary writer
 * needs an ArrayBuffer value for OB/OW/UN elements; unmaterialized bulk/icon
 * binaries would make it throw, and dcm2niix doesn't need them for orientation.
 */
function sanitizeDataset(source: JsonDataset): JsonDataset {
  const out: JsonDataset = {}
  for (const [tag, el] of Object.entries(source)) {
    if (tag.startsWith('0002') || tag === '7FE00010') continue
    // Some servers omit `vr` on certain elements (e.g. AvailableTransferSyntaxUID);
    // dcmjs then treats them as binary UN and throws. Drop them — none are needed
    // for dcm2niix's geometry.
    if (typeof el.vr !== 'string' || el.vr.length !== 2) continue
    // Overlay Data (60xx,3000) inline is an image dcm2niix converts (_ROI<n>).
    // ponytail: inline only; a BulkDataURI overlay is dropped (fetch it if a server sends one).
    if (isOverlayData(tag) && typeof el.InlineBinary === 'string') {
      // Malformed base64 drops the overlay, as before, not the series.
      try {
        out[tag] = { vr: el.vr, Value: [decodeBase64(el.InlineBinary)] }
      } catch {}
      continue
    }
    if (el.Value === undefined) continue
    if (el.vr === 'SQ' && Array.isArray(el.Value)) {
      out[tag] = {
        ...el,
        Value: el.Value.map((item) =>
          item && typeof item === 'object'
            ? sanitizeDataset(item as JsonDataset)
            : item,
        ),
      }
      continue
    }
    out[tag] = el
  }
  return out
}

// Even groups 6000-601E (PS3.5 7.6).
const isOverlayData = (tag: string) => /^60[01][02468ACE]3000$/i.test(tag)

function decodeBase64(text: string): ArrayBuffer {
  const bin = atob(text)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/** Series `/metadata` URL derived from an instance URL. */
export function seriesMetadataUrl(instanceUrl: string): string | null {
  const seriesBase = instanceUrl.split('/instances/')[0]
  return seriesBase ? `${seriesBase}/metadata` : null
}

/** SOP Instance UID embedded in an instance URL. */
export function sopFromInstanceUrl(instanceUrl: string): string | null {
  return instanceUrl.split('/instances/')[1]?.split(/[/?#]/)[0] ?? null
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * Assemble a DICOM Part-10 byte buffer from an instance's dicom+json metadata and
 * its frames' pixel bytes (frame 1 first), written under `transferSyntaxUID`
 * (default Explicit VR Little Endian). The file-meta group is rebuilt.
 *
 * `DicomDict` is passed in (dcmjs, dynamically imported by the caller) to keep this
 * module free of a static dcmjs import.
 */
// Uncompressed (native) transfer syntaxes: Implicit VR LE, Explicit VR LE/BE.
const UNCOMPRESSED_SYNTAXES = new Set([
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.1',
  '1.2.840.10008.1.2.2',
])

export function assemblePart10(
  DicomDict: DcmjsDicomDictCtor,
  metadata: JsonDataset,
  frames: Uint8Array[],
  transferSyntaxUID?: string,
): ArrayBuffer {
  const dataset = sanitizeDataset(metadata)
  const syntax = transferSyntaxUID || EXPLICIT_VR_LITTLE_ENDIAN

  // slice(): standalone ArrayBuffers (a fetched frame may be a view into a larger
  // buffer, which dcmjs' DataView-based writer rejects).
  if (UNCOMPRESSED_SYNTAXES.has(syntax)) {
    const bitsAllocated = firstValue<number>(metadata['00280100']) ?? 16
    dataset['7FE00010'] = {
      vr: bitsAllocated > 8 ? 'OW' : 'OB',
      Value: [concat(frames).slice().buffer],
    }
  } else {
    // Compressed pixels stay encapsulated: OB, one Value per frame. dcmjs writes
    // the Basic Offset Table (one offset per Value) + fragment items, and dcm2niix
    // decodes it (it bundles JPEG/JPEG-LS/JPEG2000 decoders).
    dataset['7FE00010'] = {
      vr: 'OB',
      Value: frames.map((f) => f.slice().buffer),
    }
  }

  const meta: JsonDataset = {
    '00020010': { vr: 'UI', Value: [syntax] },
    '00020002': { vr: 'UI', Value: [firstValue(metadata['00080016'])] },
    '00020003': { vr: 'UI', Value: [firstValue(metadata['00080018'])] },
    '00020012': { vr: 'UI', Value: [IMPLEMENTATION_CLASS_UID] },
  }

  const dicomDict = new DicomDict(meta)
  dicomDict.dict = dataset
  return dicomDict.write({
    // Some DICOMweb servers emit non-conformant values (e.g. a backslash-joined
    // multi-value CS exceeding the VR's max length). dcm2niix reads leniently.
    allowInvalidVRLength: true,
    // Write each compressed frame as ONE fragment. dcmjs otherwise splits frames
    // into 20 KB fragments, and dcm2niix only decodes single-fragment frames
    // ("Compressed image stored as N fragments").
    fragmentMultiframe: false,
  })
}

// dcmjs `data.DicomDict` shape we depend on (no upstream .d.ts).
interface DcmjsDicomDict {
  meta: JsonDataset
  dict: JsonDataset
  write(options?: {
    allowInvalidVRLength?: boolean
    fragmentMultiframe?: boolean
  }): ArrayBuffer
}
export type DcmjsDicomDictCtor = new (meta: JsonDataset) => DcmjsDicomDict

async function loadDicomDictCtor(): Promise<DcmjsDicomDictCtor> {
  const mod = await import('dcmjs')
  const dcmjs = (mod.default ?? mod) as {
    data: { DicomDict: DcmjsDicomDictCtor }
  }
  return dcmjs.data.DicomDict
}

interface FrameFetch {
  bytes: Uint8Array
  transferSyntaxUID: string | null
}

/** The transfer-syntax parameter from the response or a multipart part header. */
function transferSyntaxOf(
  contentType: string,
  buffer: ArrayBuffer,
): string | null {
  const fromResp = /transfer-syntax=([0-9.]+)/i.exec(contentType)?.[1]
  if (fromResp) return fromResp
  // Fall back to the first part's Content-Type header (e.g. `image/jls;
  // transfer-syntax=1.2.840.10008.1.2.4.80`), which lives near the start.
  const head = new TextDecoder('latin1').decode(
    new Uint8Array(buffer).slice(0, 1024),
  )
  return /transfer-syntax=([0-9.]+)/i.exec(head)?.[1] ?? null
}

/**
 * An uncompressed instance's whole pixel data in one request, from its
 * absolute BulkDataURI (IDC's proxy serves a 2674-frame SEG's 88 MB in ~5 s,
 * where per-frame requests take minutes). Undefined when not applicable; null
 * when refused or not the expected size (the server will not serve bulk). The
 * caller fetches frames instead.
 */
async function fetchBulkPixels(
  metadata: JsonDataset,
  instanceUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | null | undefined> {
  const uri = (metadata['7FE00010'] as { BulkDataURI?: unknown } | undefined)
    ?.BulkDataURI
  const syntax = firstValue<string>(metadata['00020010'])
  if (
    typeof uri !== 'string' ||
    !/^https?:/.test(uri) ||
    !syntax ||
    !UNCOMPRESSED_SYNTAXES.has(syntax)
  )
    return undefined
  const n = (tag: string) => Number(firstValue(metadata[tag])) || 1
  const expected = Math.ceil(
    (n('00280010') *
      n('00280011') *
      n('00280008') *
      n('00280002') *
      n('00280100')) /
      8,
  )
  try {
    // The server's credentials go only to its own origin (as the WSI bulk
    // policy): a bulk object elsewhere is fetched without them.
    const sameOrigin = new URL(uri).origin === new URL(instanceUrl).origin
    const resp = await fetch(uri, {
      headers: {
        Accept: 'application/octet-stream',
        ...(sameOrigin ? headers : {}),
      },
      signal,
    })
    if (!resp.ok) {
      await resp.body?.cancel()
      return null
    }
    const contentType = resp.headers.get('content-type') ?? ''
    const buffer = await resp.arrayBuffer()
    const parts = parseMultipartRelated(buffer, contentType)
    const bytes = parts.length === 0 ? new Uint8Array(buffer) : concat(parts)
    // An odd-length value is padded to even length (PS3.5 7.1.1).
    return bytes.length === expected + (expected % 2) ||
      bytes.length === expected
      ? bytes
      : null
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function fetchFrame(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<FrameFetch> {
  const resp = await fetch(url, {
    headers: {
      Accept: 'multipart/related; type="application/octet-stream"',
      ...headers,
    },
    signal,
  })
  if (!resp.ok) {
    await resp.body?.cancel() // an unread body keeps downloading
    throw new Error(`frame fetch failed (${resp.status} ${resp.statusText})`)
  }
  const contentType = resp.headers.get('content-type') ?? ''
  const buffer = await resp.arrayBuffer()
  const transferSyntaxUID = transferSyntaxOf(contentType, buffer)
  const parts = parseMultipartRelated(buffer, contentType)
  // Frame bulkdata may arrive multipart or raw; concatenate.
  const bytes = parts.length === 0 ? new Uint8Array(buffer) : concat(parts)
  return { bytes, transferSyntaxUID }
}

/** The instance's P10 bytes via WADO-RS RetrieveInstance; null when refused. */
async function retrieveInstance(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        // transfer-syntax=*: the stored syntax, no server-side transcoding.
        Accept:
          'multipart/related; type="application/dicom"; transfer-syntax=*',
        ...headers,
      },
      signal,
    })
    if (!resp.ok) {
      await resp.body?.cancel()
      return null
    }
    const buffer = await resp.arrayBuffer()
    const p10 = parseMultipartRelated(
      buffer,
      resp.headers.get('content-type') ?? '',
    )[0]
    // A static host may answer 200 with an HTML error page: check the magic.
    if (!p10 || new TextDecoder().decode(p10.subarray(128, 132)) !== 'DICM')
      return null
    // Parts are ArrayBuffer-backed (slices or the response buffer itself).
    return p10 as Uint8Array<ArrayBuffer>
  } catch {
    // Network/CORS failure: reconstruct instead; an abort still rejects.
    signal?.throwIfAborted()
    return null
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  )
  return out
}

// Bounds in-flight work across nested pools (instances, then their frames).
function limiter(n: number): <R>(fn: () => Promise<R>) => Promise<R> {
  let active = 0
  const waiting: Array<() => void> = []
  return async (fn) => {
    while (active >= n) await new Promise<void>((r) => waiting.push(r))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/** A WADO-RS instance URL (`.../instances/<sop>`) and its frame count. */
export interface InstanceRef {
  url: string
  frames: number
}

export interface ReconstructOptions {
  headers?: Record<string, string>
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
  concurrency?: number
}

/**
 * P10 `File`s for `instances`: RetrieveInstance, probed on the first instance,
 * else reconstruction from one shared series-metadata fetch plus frames 1..N per
 * instance. Progress counts frames.
 */
export async function reconstructInstanceFiles(
  instances: InstanceRef[],
  options: ReconstructOptions = {},
): Promise<File[]> {
  const { headers = {}, onProgress, signal, concurrency = 6 } = options
  const first = instances[0]
  if (!first) return []
  let total = instances.reduce((n, inst) => n + inst.frames, 0)
  let done = 0
  const progress = (frames: number) => {
    done += frames
    onProgress?.(done, total)
  }

  type Series = [DcmjsDicomDictCtor, Map<string, JsonDataset>]
  const loadSeries = async (): Promise<Series> => {
    const metadataUrl = seriesMetadataUrl(first.url)
    if (!metadataUrl) throw new Error('Could not derive series metadata URL')
    const [DicomDict, metaResp] = await Promise.all([
      loadDicomDictCtor(),
      fetch(metadataUrl, {
        headers: { Accept: 'application/dicom+json', ...headers },
        signal,
      }),
    ])
    if (!metaResp.ok) {
      await metaResp.body?.cancel()
      throw new Error(`series metadata fetch failed (${metaResp.status})`)
    }
    const metaJson = (await metaResp.json()) as JsonDataset | JsonDataset[]
    const metaBySop = new Map<string, JsonDataset>()
    for (const m of Array.isArray(metaJson) ? metaJson : [metaJson]) {
      const sop = firstValue<string>(m['00080018'])
      if (sop) metaBySop.set(sop, m)
    }
    return [DicomDict, metaBySop]
  }
  let series: Promise<Series> | undefined

  // One bound for every request, so frames nested in instances stay within it.
  const limit = limiter(concurrency)
  let canRetrieve = true
  // A server that refuses one bulk request is not asked again (as RetrieveInstance).
  let canBulk = true
  const instanceFile = async (inst: InstanceRef): Promise<File | null> => {
    const sop = sopFromInstanceUrl(inst.url)
    const name = `${sop}.dcm`
    const retrieved = canRetrieve
      ? await limit(() => retrieveInstance(inst.url, headers, signal))
      : null
    if (retrieved) {
      progress(inst.frames)
      return new File([retrieved], name, { type: 'application/dicom' })
    }
    canRetrieve = false
    series ??= loadSeries()
    const [DicomDict, metaBySop] = await series
    const metadata = sop ? metaBySop.get(sop) : undefined
    if (!metadata) {
      progress(inst.frames)
      return null
    }
    // OHIF may lack NumberOfFrames (static servers); the metadata has it.
    const count = Number(firstValue(metadata['00280008'])) || inst.frames
    total += count - inst.frames
    const bulk =
      canBulk &&
      (await limit(() => fetchBulkPixels(metadata, inst.url, headers, signal)))
    if (bulk === null) canBulk = false
    if (bulk) {
      progress(count)
      // DICOMweb serves uncompressed bulk data little endian (PS3.18 8.7.3.3),
      // whatever the stored syntax.
      return new File(
        [
          assemblePart10(
            DicomDict,
            metadata,
            [bulk],
            EXPLICIT_VR_LITTLE_ENDIAN,
          ),
        ],
        name,
        {
          type: 'application/dicom',
        },
      )
    }
    const frameNumbers = Array.from({ length: count }, (_, i) => i + 1)
    const frames = await mapPool(frameNumbers, concurrency, async (n) => {
      const frame = await limit(() =>
        fetchFrame(`${inst.url}/frames/${n}`, headers, signal),
      )
      progress(1)
      return frame
    })
    const p10 = assemblePart10(
      DicomDict,
      metadata,
      frames.map((f) => f.bytes),
      frames[0]?.transferSyntaxUID ?? undefined,
    )
    return new File([p10], name, { type: 'application/dicom' })
  }

  // Probe alone, so a refusing server costs one request, not `concurrency`.
  const firstFile = await instanceFile(first)
  const rest = await mapPool(instances.slice(1), concurrency, instanceFile)
  const files = [firstFile, ...rest].filter((f): f is File => f !== null)
  // Surface a partial series (instances skipped for missing metadata) so a
  // converted-with-missing-slices volume isn't silent.
  if (files.length < instances.length) {
    console.warn(
      `[nv-ohif] reconstructed ${files.length} of ${instances.length} DICOM instances ` +
        `(${instances.length - files.length} skipped for missing metadata); ` +
        'the converted volume may be missing slices.',
    )
  }
  return files
}
