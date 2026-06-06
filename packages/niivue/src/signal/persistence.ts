import type {
  NVSignal,
  NVSignalDisplay,
  NVSignalRaw,
  SignalKind,
} from '@/NVTypes'

/** Serialized form of an NVSignal for the NVD document (CBOR-friendly). */
export type SerializedSignal = {
  id: string
  name: string
  url?: string
  kind: SignalKind
  display: NVSignalDisplay
  attachedToId?: string
  // physio: each column's Float32 samples stored as raw bytes
  columns?: Uint8Array[]
  columnLabels?: string[]
  samplingFrequency?: number | null
  startTime?: number
  // spectroscopy
  fid?: Uint8Array
  nPoints?: number
  nTransients?: number
  dwell?: number
  spectrometerFreq?: number | null
  nucleus?: string
}

function f32ToBytes(arr: Float32Array): Uint8Array {
  // A view (no copy) is sufficient: cbor-x encodes synchronously, so the
  // backing buffer is read before anything could mutate it.
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
}

/** Copy raw bytes into a fresh, aligned Float32Array. */
function bytesToF32(u8: Uint8Array): Float32Array {
  const copy = new Uint8Array(u8.byteLength)
  copy.set(u8)
  return new Float32Array(copy.buffer)
}

/** Convert an NVSignal into its serialized document entry. */
export function serializeSignal(s: NVSignal): SerializedSignal {
  const out: SerializedSignal = {
    id: s.id,
    name: s.name,
    url: s.url,
    kind: s.kind,
    display: { ...s.display },
    attachedToId: s.attachedToId,
  }
  if (s.raw.kind === 'physio') {
    out.columns = s.raw.columns.map(f32ToBytes)
    out.columnLabels = [...s.raw.columnLabels]
    out.samplingFrequency = s.raw.samplingFrequency
    out.startTime = s.raw.startTime
  } else {
    out.fid = f32ToBytes(s.raw.fid)
    out.nPoints = s.raw.nPoints
    out.nTransients = s.raw.nTransients
    out.dwell = s.raw.dwell
    out.spectrometerFreq = s.raw.spectrometerFreq
    out.nucleus = s.raw.nucleus
  }
  return out
}

/** Rebuild an NVSignal from its serialized document entry. */
export function reconstructSignal(doc: SerializedSignal): NVSignal {
  let raw: NVSignalRaw
  if (doc.kind === 'spectroscopy') {
    raw = {
      kind: 'spectroscopy',
      fid: doc.fid ? bytesToF32(doc.fid) : new Float32Array(0),
      nPoints: doc.nPoints ?? 0,
      nTransients: doc.nTransients ?? 0,
      dwell: doc.dwell ?? 0,
      spectrometerFreq: doc.spectrometerFreq ?? null,
      nucleus: doc.nucleus ?? '1H',
    }
  } else {
    raw = {
      kind: 'physio',
      columns: (doc.columns ?? []).map(bytesToF32),
      columnLabels: doc.columnLabels ?? [],
      samplingFrequency: doc.samplingFrequency ?? null,
      startTime: doc.startTime ?? 0,
    }
  }
  return {
    id: doc.id,
    name: doc.name,
    url: doc.url,
    kind: doc.kind,
    raw,
    display: { ...doc.display },
    attachedToId: doc.attachedToId,
  }
}
