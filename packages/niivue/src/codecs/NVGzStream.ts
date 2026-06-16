/**
 * NVGzStream.ts
 *
 * Streaming, EARLY-STOPPING gzip decode (fflate). The built-in
 * `DecompressionStream` + `Response.arrayBuffer()` always drains the WHOLE
 * stream, so it cannot read just the first part of a huge gz file. fflate's
 * `Gunzip` is a pure-JS streaming inflater we can feed chunk-by-chunk and stop
 * as soon as enough decompressed bytes are in hand — letting us read a NIfTI
 * header (or the first few 4D frames) of a multi-GB volume without inflating
 * (and trying to allocate) the entire >2 GiB output (which exceeds V8's ~2 GiB
 * ArrayBuffer cap). fflate is slower than the native stream, so this is only used
 * on the `limitFrames4D` partial-load path; full loads keep using NVGz.
 */
import { Gunzip } from 'fflate'

/**
 * Decompress a gzip `ReadableStream` only until at least `minBytes` of OUTPUT are
 * available, then cancel the stream (so the remainder of the file is never
 * fetched/inflated). Returns the concatenated decompressed bytes — at least
 * `minBytes`, or fewer if the stream ends first. Throws if the input is not valid
 * gzip (the caller falls back to a full load).
 */
export async function readFirstDecompressedBytes(
  stream: ReadableStream<Uint8Array>,
  minBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const gunzip = new Gunzip()
  const chunks: Uint8Array[] = []
  let total = 0
  // fflate calls `ondata` synchronously from `push()`, so `total` is up to date
  // immediately after each push and the loop can stop the moment we have enough.
  gunzip.ondata = (chunk) => {
    chunks.push(chunk)
    total += chunk.length
  }
  let error: unknown = null
  try {
    while (total < minBytes) {
      const { done, value } = await reader.read()
      if (done) {
        gunzip.push(new Uint8Array(0), true) // signal end-of-stream
        break
      }
      gunzip.push(value, false)
    }
  } catch (e) {
    error = e
  } finally {
    // Release the lock / abort the body so the rest of the file isn't downloaded.
    await reader.cancel().catch(() => {})
  }
  if (error) throw error
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
