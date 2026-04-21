/**
 * NVGz.ts
 *
 * Handles gzip compression and decompression using the Web Streams API.
 */
import { log } from "@/logger"

export async function compress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip")
  const writer = stream.writable.getWriter()
  writer
    .write(new Uint8Array(data))
    .catch((e) => log.error("NVGz compress write error", e))
  const closePromise = writer
    .close()
    .catch((e) => log.error("NVGz compress close error", e))
  const response = new Response(stream.readable)
  const result = new Uint8Array(await response.arrayBuffer())
  await closePromise
  return result
}

/** Decompress if gzip, otherwise return as-is. */
export async function maybeDecompress(
  buffer: ArrayBuffer | ArrayBufferLike,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const raw = await decompress(new Uint8Array(buffer))
    return raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ) as ArrayBuffer
  }
  return buffer as ArrayBuffer
}

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
  const format =
    data[0] === 31 && data[1] === 139 && data[2] === 8
      ? "gzip"
      : data[0] === 120 &&
          (data[1] === 1 ||
            data[1] === 94 ||
            data[1] === 156 ||
            data[1] === 218)
        ? "deflate"
        : "deflate-raw"
  const stream = new DecompressionStream(format)
  const writer = stream.writable.getWriter()
  const chunk = new Uint8Array(data)
  writer.write(chunk).catch((e) => log.error("NVGz write error", e)) // Do not await this
  // Close without awaiting directly, preventing the hang issue
  const closePromise = writer
    .close()
    .catch((e) => log.error("NVGz close error", e))
  const response = new Response(stream.readable)
  const result = new Uint8Array(await response.arrayBuffer())
  await closePromise // Ensure close happens eventually
  return result
}
