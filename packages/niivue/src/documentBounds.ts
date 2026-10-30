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
 * Whether an embedded image has at least one byte per voxel its header claims.
 * The header sizes later buffers (a drawing allocates one byte per voxel), and
 * only the image bytes are charged against the file. One byte, not the
 * header's bit depth, since the saved image may be stored narrower.
 */
export function isEmbeddedImageComplete(
  dims: number[],
  imgByteLength: number,
): boolean {
  const [, x, y, z] = dims
  return (
    [x, y, z].every((n) => Number.isSafeInteger(n) && n > 0) &&
    x * y * z <= imgByteLength
  )
}
