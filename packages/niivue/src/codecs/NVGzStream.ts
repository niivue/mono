/**
 * NVGzStream.ts
 *
 * Read just the PREFIX of a stream and stop early. Paired with the native
 * `DecompressionStream` at the call site, this reads a NIfTI header (or the first
 * few 4D frames) of a multi-GB gzip volume without inflating — or trying to
 * allocate — the entire >2 GiB output (which exceeds V8's ~2 GiB ArrayBuffer cap).
 *
 * The common belief that `DecompressionStream` "must read the whole file" is only
 * true for `DecompressionStream` + `Response.arrayBuffer()` (which drains the
 * stream). Pulling the decompressed output incrementally and `cancel()`-ing once
 * enough bytes are in hand stops both the inflate AND the underlying fetch/download
 * — which is exactly what {@link readFirstBytes} does. (nifti-reader-js's own
 * `decompressHeaderAsync` uses the same technique; no fflate needed.)
 *
 * `readFirstBytes` takes an already-decompressed stream so it is pure stream logic
 * with no `DecompressionStream` dependency — keeping it unit-testable under the Bun
 * harness, which has no `DecompressionStream`. Callers wrap it:
 *   `readFirstBytes(compressed.pipeThrough(new DecompressionStream('gzip')), n)`.
 */

/**
 * Pull from `stream` until at least `minBytes` have been read, then cancel it
 * (which also aborts the upstream source — e.g. a fetch body piped through a
 * `DecompressionStream` — so the rest of the file is never downloaded/inflated).
 * Returns the concatenated bytes as a fresh, exactly-sized `Uint8Array` at
 * `byteOffset` 0 (so `.buffer` IS the data — callers parse `.buffer` directly):
 * exactly `minBytes` (the trailing chunk is trimmed), or fewer if the stream ends
 * first. A read error (e.g. invalid gzip from the piped decompressor) propagates so
 * the caller can fall back to a full load.
 */
export async function readFirstBytes(
  stream: ReadableStream<Uint8Array>,
  minBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < minBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  // Allocate exactly what was asked for (the last chunk usually overshoots
  // minBytes); trimming avoids holding an oversized buffer on the near-cap path.
  const outLen = Math.min(total, minBytes)
  const out = new Uint8Array(outLen)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= outLen) break
    const take = Math.min(chunk.length, outLen - offset)
    out.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return out
}
