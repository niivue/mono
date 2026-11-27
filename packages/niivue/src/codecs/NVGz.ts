/**
 * NVGz.ts
 *
 * Handles gzip compression and decompression using the Web Streams API.
 */
import { log } from '@/logger'

export async function compress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('gzip')
  const writer = stream.writable.getWriter()
  writer
    .write(new Uint8Array(data))
    .catch((e) => log.error('NVGz compress write error', e))
  const closePromise = writer
    .close()
    .catch((e) => log.error('NVGz compress close error', e))
  const response = new Response(stream.readable)
  const result = new Uint8Array(await response.arrayBuffer())
  await closePromise
  return result
}

/** Decompress if gzip, otherwise return as-is. */
export async function maybeDecompress(
  buffer: ArrayBuffer | ArrayBufferLike,
  maxBytes = Infinity,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const raw = await decompress(new Uint8Array(buffer), maxBytes)
    if (raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength)
      return raw.buffer as ArrayBuffer
    return raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ) as ArrayBuffer
  }
  return buffer as ArrayBuffer
}

/**
 * Inflate gzip/zlib/raw-deflate. Throws once the output passes `maxBytes`,
 * cancelling the stream so a decompression bomb stops at the cap instead of
 * exhausting memory.
 */
export async function decompress(
  data: Uint8Array,
  maxBytes = Infinity,
): Promise<Uint8Array> {
  const format =
    data[0] === 31 && data[1] === 139 && data[2] === 8
      ? 'gzip'
      : data[0] === 120 &&
          (data[1] === 1 ||
            data[1] === 94 ||
            data[1] === 156 ||
            data[1] === 218)
        ? 'deflate'
        : 'deflate-raw'
  // Feed bounded input slices so the decompressor, which inflates a whole write
  // before the reader sees any of it, overshoots the cap by at most a slice or
  // two of inflation (deflate peaks near 1032:1). Uncapped: one slice.
  const step = Number.isFinite(maxBytes)
    ? Math.min(65536, Math.max(1024, Math.floor(maxBytes / 1032)))
    : Math.max(1, data.byteLength)
  let pos = 0
  const reader = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      pull(controller) {
        if (pos >= data.byteLength) return controller.close()
        // slice copies: a SharedArrayBuffer view cannot be enqueued
        controller.enqueue(data.slice(pos, pos + step))
        pos += step
      },
    },
    { highWaterMark: 0 },
  )
    .pipeThrough(new DecompressionStream(format))
    .getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new RangeError(`NVGz: inflated data exceeds ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  if (chunks.length === 1) return chunks[0]
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}
