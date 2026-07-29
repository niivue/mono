/**
 * Gzip helpers built on the Web Streams API (available in all modern browsers).
 *
 * Split out of `index.ts` so it can be unit tested: `index.ts` imports
 * `@niivue/niivue`, whose module graph uses Vite's `import.meta.glob` and cannot
 * be loaded by the Bun test runner.
 */

/**
 * Gzip-compress a Uint8Array.
 *
 * Start consuming `readable` BEFORE awaiting the write/close. A CompressionStream
 * is a TransformStream whose readable side applies backpressure once its queue
 * fills; if nothing is reading, `writer.write()` / `writer.close()` never settle
 * and this hangs forever. In Chromium that happens for inputs as small as ~1 MB —
 * i.e. every real document — so the read must already be in flight. (This is the
 * same shape niivue's own `codecs/NVGz.ts` compress() uses.)
 *
 * `chunk` is a copy: a view backed by a SharedArrayBuffer (see the extension
 * context's `acquireSharedBuffer`) cannot be enqueued directly.
 */
export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('gzip')
  const chunk = new Uint8Array(data.byteLength)
  chunk.set(data)
  const compressed = new Response(stream.readable).arrayBuffer()
  const writer = stream.writable.getWriter()
  await writer.write(chunk)
  await writer.close()
  return new Uint8Array(await compressed)
}
