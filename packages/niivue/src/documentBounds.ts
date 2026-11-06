// Bound a decoded NVD document by the size of the bytes it came from. CBOR
// shared references (tags 28/29, which cbor-x `decode` honours) let one
// embedded array or object appear many times, or form a cycle, so a small file
// can decode to a structure whose rebuild copies far more than it holds.
// Pure + dependency-free, so it is unit-testable under the Bun harness (unlike
// NVDocument itself).

/**
 * Throw when walking `doc` reference by reference costs more than
 * `inputByteLength`. Each visited value costs 1 and each typed array its
 * `byteLength`. An honest document fits: every CBOR item and JSON value takes
 * at least one input byte, and embedded bytes are stored raw (CBOR) or as
 * base64 (JSON, 4/3 of their size). Keys and string lengths are not charged,
 * so the count never exceeds an honest file. A cycle or a deep chain of shared
 * objects runs out of budget instead of recursing forever.
 */
export function assertDocumentFitsInput(
  doc: unknown,
  inputByteLength: number,
): void {
  let budget = inputByteLength
  const spend = (cost: number): void => {
    budget -= cost
    if (budget < 0) {
      throw new Error(
        `Invalid NVD file: its contents expand beyond its ${inputByteLength} bytes (shared or cyclic references)`,
      )
    }
  }
  // Explicit stack: a deep (or cyclic) document must not overflow the call
  // stack. Only containers are pushed, so a long number array costs no stack.
  const stack: object[] = []
  const visit = (v: unknown): void => {
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
      spend(v.byteLength)
    } else if (typeof v === 'object' && v !== null) {
      spend(1)
      stack.push(v)
    } else {
      spend(1)
    }
  }
  visit(doc)
  while (stack.length > 0) {
    const v = stack.pop() as object
    // cbor-x decodes Sets and Maps, whose entries Object.values does not list.
    const items =
      v instanceof Map
        ? [...v.keys(), ...v.values()]
        : v instanceof Set || Array.isArray(v)
          ? v
          : Object.values(v)
    for (const item of items) visit(item)
  }
}

/**
 * Throw when the definite-length arrays and maps in CBOR `data` declare more
 * items in total than it has bytes. cbor-x allocates a declared array before
 * reading its items, so nested 5-byte headers each claiming 100M items would
 * allocate gigabytes before `assertDocumentFitsInput` can run. Every honest
 * item takes at least one byte and no two containers share one, so an honest
 * file passes. Heads are read in sequence: each is followed only by its
 * argument and, for a byte or text string, its bytes. cbor-x tags that break
 * that rule (0xdff9-0xdfff read their length their own way) or expand data
 * inside decode (51, packed prefixes) are refused; `serialize` emits neither.
 */
export function assertCborFitsInput(data: Uint8Array): void {
  const n = data.length
  let items = 0
  let pos = 0
  while (pos < n) {
    const major = data[pos] >> 5
    const info = data[pos++] & 31
    // 0-23 is the argument itself; 24-27 a 1, 2, 4 or 8 byte argument; 31 an
    // indefinite length, whose items cbor-x adds as it reads them.
    if (info > 27) continue
    let arg = info
    if (info >= 24) {
      arg = 0
      for (const end = pos + (1 << (info - 24)); pos < end; pos++) {
        arg = arg * 256 + data[pos]
      }
    }
    if (major === 2 || major === 3) pos += arg
    else if (major === 4) items += arg
    else if (major === 5) items += 2 * arg
    else if (major === 6 && (arg === 51 || arg >= 0xdff9)) {
      throw new Error(`Invalid NVD file: unsupported CBOR tag ${arg}`)
    }
    if (items > n) {
      throw new Error(
        `Invalid NVD file: its arrays declare more items than its ${n} bytes hold`,
      )
    }
  }
}

/**
 * Whether an embedded image is a typed array with at least one byte per voxel
 * its header claims. The header sizes later buffers (a drawing allocates one
 * byte per voxel), and only typed-array bytes are charged against the file: a
 * plain object (JSON) could claim any `byteLength`. One byte, not the header's
 * bit depth, since the saved image may be stored narrower.
 */
export function isEmbeddedImageComplete(dims: number[], img: unknown): boolean {
  const [, x, y, z] = dims
  return (
    ArrayBuffer.isView(img) &&
    [x, y, z].every((n) => Number.isSafeInteger(n) && n > 0) &&
    x * y * z <= img.byteLength
  )
}

/** Copy serialized bytes only after verifying that their size is real. */
export function copyDocumentBytes(bytes: Uint8Array): ArrayBuffer {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Invalid NVD file: expected a byte array')
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}
