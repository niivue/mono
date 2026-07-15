// JSON encoding of an NVD document. The canonical `.nvd` is CBOR (binary, compact,
// native typed-array support); this is a human-readable/diffable/portable
// alternative that round-trips the SAME document structure. JSON has no binary
// type, so every typed array (embedded volume/mesh bytes, RLE drawing rasters,
// colormap LUTs, ...) is marshalled as base64 behind a `{ $ta, b64 }` tag and
// reconstructed to its original TypedArray on decode. Pure + dependency-free, so
// it is unit-testable under the Bun harness (unlike NVDocument itself).

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
    (v as { $ta: string }).$ta in TYPED_ARRAYS
  )
}

/** Serialize an NVD document object to a JSON string, tagging typed arrays. */
export function encodeDocumentJSON(doc: unknown): string {
  return JSON.stringify(doc, (_key: string, value: unknown): unknown => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const view = value as ArrayBufferView
      const bytes = new Uint8Array(
        view.buffer,
        view.byteOffset,
        view.byteLength,
      )
      return {
        $ta: value.constructor.name as TypedArrayName,
        b64: bytesToBase64(bytes),
      }
    }
    return value
  })
}

/** Parse a JSON NVD document string, reconstructing tagged typed arrays. */
export function decodeDocumentJSON(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown): unknown => {
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
