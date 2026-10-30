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
  // Explicit stack: a deep (or cyclic) document must not overflow the call stack.
  const stack: unknown[] = [doc]
  while (stack.length > 0) {
    const v = stack.pop()
    if (ArrayBuffer.isView(v)) {
      spend(v.byteLength)
    } else if (v instanceof ArrayBuffer) {
      spend(v.byteLength)
    } else if (Array.isArray(v)) {
      spend(1)
      for (const item of v) stack.push(item)
    } else if (typeof v === 'object' && v !== null) {
      spend(1)
      for (const item of Object.values(v)) stack.push(item)
    } else {
      spend(1)
    }
  }
}
