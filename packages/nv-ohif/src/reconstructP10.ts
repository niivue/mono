import { parseMultipartRelated } from './dicomWadoRs'

// Reconstruct original-style DICOM Part-10 files from a DICOMweb data source that
// does NOT expose WADO-RS RetrieveInstance (e.g. a static S3/CloudFront store).
// Such servers still serve `/metadata` (dicom+json) and per-frame pixel bulkdata,
// which is everything needed to assemble a valid P10 with dcmjs. dcm2niix then does
// the DICOM->NIfTI orientation/affine work.
//
// This is universal: it works against any DICOMweb server (static or live), unlike
// RetrieveInstance which many static demo servers reject with 403.

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

/** Frames pixel URL (absolute) from a cornerstone `wadors:` imageId. */
export function framesUrlFromImageId(imageId: string): string | null {
  if (typeof imageId !== 'string') return null
  const raw = imageId.replace(/^(wadors|dicomweb):/i, '')
  return /^https?:\/\/.*\/frames\//i.test(raw) ? raw : null
}

/** Series `/metadata` URL derived from an instance frames URL. */
export function seriesMetadataUrlFromFramesUrl(
  framesUrl: string,
): string | null {
  const seriesBase = framesUrl.split('/instances/')[0]
  return seriesBase ? `${seriesBase}/metadata` : null
}

/** SOP Instance UID embedded in a frames/instance URL. */
export function sopFromFramesUrl(framesUrl: string): string | null {
  return framesUrl.split('/instances/')[1]?.split(/[/?#]/)[0] ?? null
}

/**
 * Assemble a DICOM Part-10 byte buffer from an instance's dicom+json metadata and
 * its raw (uncompressed) pixel bytes. The file-meta group is rebuilt; the dataset
 * is written as Explicit VR Little Endian to match the uncompressed pixels.
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
  pixelBytes: Uint8Array,
  transferSyntaxUID?: string,
): ArrayBuffer {
  const dataset = sanitizeDataset(metadata)
  const syntax = transferSyntaxUID || EXPLICIT_VR_LITTLE_ENDIAN

  // Copy the pixels into a fresh, standalone ArrayBuffer (the fetched bytes may be a
  // view into a larger buffer, which dcmjs' DataView-based writer rejects).
  const pixelBuffer = new ArrayBuffer(pixelBytes.byteLength)
  new Uint8Array(pixelBuffer).set(pixelBytes)
  if (UNCOMPRESSED_SYNTAXES.has(syntax)) {
    const bitsAllocated = firstValue<number>(metadata['00280100']) ?? 16
    dataset['7FE00010'] = {
      vr: bitsAllocated > 8 ? 'OW' : 'OB',
      Value: [pixelBuffer],
    }
  } else {
    // Compressed pixels stay encapsulated: OB with one fragment per frame. dcmjs
    // writes the Basic Offset Table + fragment items for a compressed syntax, and
    // dcm2niix decodes it (it bundles JPEG/JPEG-LS/JPEG2000 decoders).
    dataset['7FE00010'] = { vr: 'OB', Value: [pixelBuffer] }
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
export interface DcmjsDicomDict {
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
  if (!resp.ok)
    throw new Error(`frame fetch failed (${resp.status} ${resp.statusText})`)
  const contentType = resp.headers.get('content-type') ?? ''
  const buffer = await resp.arrayBuffer()
  const transferSyntaxUID = transferSyntaxOf(contentType, buffer)
  const parts = parseMultipartRelated(buffer, contentType)
  // Frame bulkdata may arrive multipart (one part per frame) or raw; concatenate.
  let bytes: Uint8Array
  if (parts.length === 0) bytes = new Uint8Array(buffer)
  else if (parts.length === 1) bytes = parts[0] ?? new Uint8Array()
  else {
    const total = parts.reduce((n, p) => n + p.length, 0)
    bytes = new Uint8Array(total)
    let o = 0
    for (const p of parts) {
      bytes.set(p, o)
      o += p.length
    }
  }
  return { bytes, transferSyntaxUID }
}

export interface ReconstructOptions {
  headers?: Record<string, string>
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
  concurrency?: number
}

/**
 * Reconstruct P10 `File`s for every instance identified by `framesUrls`, using one
 * shared series-metadata fetch plus a per-instance pixel fetch.
 */
export async function reconstructInstanceFiles(
  framesUrls: string[],
  options: ReconstructOptions = {},
): Promise<File[]> {
  const { headers = {}, onProgress, signal, concurrency = 6 } = options
  if (framesUrls.length === 0) return []

  const firstUrl = framesUrls[0]
  if (firstUrl === undefined) return []
  const metadataUrl = seriesMetadataUrlFromFramesUrl(firstUrl)
  if (!metadataUrl) throw new Error('Could not derive series metadata URL')

  const [DicomDict, metaResp] = await Promise.all([
    loadDicomDictCtor(),
    fetch(metadataUrl, {
      headers: { Accept: 'application/dicom+json', ...headers },
      signal,
    }),
  ])
  if (!metaResp.ok) {
    throw new Error(`series metadata fetch failed (${metaResp.status})`)
  }
  const metaJson = (await metaResp.json()) as JsonDataset | JsonDataset[]
  const metaList = Array.isArray(metaJson) ? metaJson : [metaJson]
  const metaBySop = new Map<string, JsonDataset>()
  for (const m of metaList) {
    const sop = firstValue<string>(m['00080018'])
    if (sop) metaBySop.set(sop, m)
  }

  const files: File[] = []
  let done = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < framesUrls.length) {
      const framesUrl = framesUrls[next++]
      if (framesUrl === undefined) break
      const sop = sopFromFramesUrl(framesUrl)
      const metadata = sop ? metaBySop.get(sop) : undefined
      if (metadata && sop) {
        const frame = await fetchFrame(framesUrl, headers, signal)
        const p10 = assemblePart10(
          DicomDict,
          metadata,
          frame.bytes,
          frame.transferSyntaxUID ?? undefined,
        )
        files.push(new File([p10], `${sop}.dcm`, { type: 'application/dicom' }))
      }
      onProgress?.(++done, framesUrls.length)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, framesUrls.length) }, () =>
      worker(),
    ),
  )
  return files
}
