// JSON encoding of an NVD document. The canonical `.nvd` is CBOR (binary, compact,
// native typed-array support); this is a human-readable/diffable/portable
// alternative that round-trips the SAME document structure. JSON has no binary
// type, so every typed array (embedded volume/mesh bytes, RLE drawing rasters,
// colormap LUTs, ...) is marshalled as base64 behind a `{ $ta, b64 }` tag and
// reconstructed to its original TypedArray on decode. JSON also has no non-finite
// numbers (JSON.stringify writes NaN and +/-Infinity as null), and the model uses
// them as ordinary values (calMinNeg/calMaxNeg default to NaN, mesh thicknessOn2D
// to Infinity, graph annotations pin at +/-Infinity), so a plain number that is
// not finite is marshalled behind a `{ $num }` tag and restored on decode. Pure +
// dependency-free, so it is unit-testable under the Bun harness (unlike
// NVDocument itself).

const TYPED_ARRAYS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
} as const

type TypedArrayName = keyof typeof TYPED_ARRAYS

function isTypedArrayName(name: string): name is TypedArrayName {
  return Object.hasOwn(TYPED_ARRAYS, name)
}

// The three non-finite doubles, keyed by the tag text a document carries.
const NON_FINITE = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
} as const

type NonFiniteName = keyof typeof NON_FINITE

function isNonFiniteName(name: string): name is NonFiniteName {
  return Object.hasOwn(NON_FINITE, name)
}

function nonFiniteName(value: number): NonFiniteName {
  if (Number.isNaN(value)) return 'NaN'
  return value > 0 ? 'Infinity' : '-Infinity'
}

// btoa/atob exist in both the browser and Bun, so this is environment-portable
// (no Buffer). Chunked so a large volume doesn't overflow the argument list.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const n = binary.length
  const bytes = new Uint8Array(n)
  for (let i = 0; i < n; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

interface TaggedTypedArray {
  $ta: TypedArrayName
  b64: string
}

function isTaggedTypedArray(v: unknown): v is TaggedTypedArray {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { $ta?: unknown }).$ta === 'string' &&
    typeof (v as { b64?: unknown }).b64 === 'string' &&
    isTypedArrayName((v as { $ta: string }).$ta)
  )
}

interface TaggedNonFinite {
  $num: NonFiniteName
}

function isTaggedNonFinite(v: unknown): v is TaggedNonFinite {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { $num?: unknown }).$num === 'string' &&
    isNonFiniteName((v as { $num: string }).$num)
  )
}

/** Serialize an NVD document object to a JSON string, tagging typed arrays
 * and non-finite numbers. Throws on a typed-array kind the decoder cannot
 * rebuild (BigInt64Array, ...) rather than emitting a tag it would not
 * recognise. */
export function encodeDocumentJSON(doc: unknown): string {
  return JSON.stringify(doc, (_key: string, value: unknown): unknown => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const name = value.constructor.name
      if (!isTypedArrayName(name)) {
        throw new Error(`documentJson: cannot encode a ${name}`)
      }
      const view = value as ArrayBufferView
      const bytes = new Uint8Array(
        view.buffer,
        view.byteOffset,
        view.byteLength,
      )
      return { $ta: name, b64: bytesToBase64(bytes) }
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { $num: nonFiniteName(value) }
    }
    return value
  })
}

/** Parse a JSON NVD document string, reconstructing tagged typed arrays and
 * non-finite numbers. A bare `null` (what an older encoder wrote for a
 * non-finite number) is left as `null`. */
export function decodeDocumentJSON(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown): unknown => {
    if (isTaggedNonFinite(value)) return NON_FINITE[value.$num]
    if (isTaggedTypedArray(value)) {
      const bytes = base64ToBytes(value.b64)
      const Ctor = TYPED_ARRAYS[value.$ta]
      if (Ctor === Uint8Array) return bytes
      // base64ToBytes always allocates a plain ArrayBuffer (offset 0).
      return new Ctor(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.byteLength / Ctor.BYTES_PER_ELEMENT,
      )
    }
    return value
  })
}

/** True when the bytes are a JSON document (first non-whitespace byte is `{`).
 * CBOR NVDs start with a map marker (>= 0xa0), never `{` (0x7b), so this cleanly
 * distinguishes the two encodings on load. */
export function looksLikeJSON(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i++) {
    const b = data[i]
    // skip leading whitespace: space, tab, LF, CR
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue
    return b === 0x7b // '{'
  }
  return false
}
