// Helpers for bun tests that drive a real NiiVue controller with no canvas
// attached (see scripts/bunTestPreload.ts for the browser stand-ins).
import { spyOn } from 'bun:test'

/** A `file://` URL for a file under packages/dev-images/images. */
export function devImageUrl(path: string): string {
  return new URL(`../../../dev-images/images/${path}`, import.meta.url).href
}

/** A document file for `loadDocument`, from serialized bytes or JSON text. */
export function documentFile(
  data: Uint8Array | string,
  name = 'doc.nvd',
): File {
  // A copy: the File constructor wants an ArrayBuffer-backed view.
  return new File(
    [typeof data === 'string' ? data : new Uint8Array(data)],
    name,
  )
}

/** Parse the JSON form of a document (`serializeDocument({ format: 'json' })`). */
export function parseJsonDocument(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** The message a promise rejects with, or '' when it resolves. */
export function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => '',
    (e: Error) => e.message,
  )
}

/**
 * Collect `console.warn` output (NiiVue's `log.warn`) without printing it.
 * Call `restore()` when done; each entry is the call's arguments joined by
 * spaces.
 */
export function captureWarnings(): {
  messages: string[]
  restore: () => void
} {
  return captureConsole('warn')
}

/** As `captureWarnings`, for `console.error` (NiiVue's `log.error`). */
export function captureErrors(): {
  messages: string[]
  restore: () => void
} {
  return captureConsole('error')
}

function captureConsole(method: 'warn' | 'error'): {
  messages: string[]
  restore: () => void
} {
  const messages: string[] = []
  const spy = spyOn(console, method).mockImplementation((...args) => {
    messages.push(args.map(String).join(' '))
  })
  return { messages, restore: () => spy.mockRestore() }
}

/**
 * Serve packages/dev-images/images (plus any in-memory `routes`) over real
 * HTTP on a free port. Use it where a test needs HTTP semantics, such as a
 * 404 for a missing file: Bun's fetch of a missing `file://` URL resolves
 * `ok` and fails only when the body is read. `requests` lists every path
 * asked for, in order. The server is unref'd, so it never keeps the test
 * process alive; `stop()` closes it early.
 */
export function serveDevImages(
  routes: Record<string, string | Uint8Array<ArrayBuffer>> = {},
): {
  url: (path: string) => string
  requests: string[]
  stop: () => void
} {
  const root = new URL('../../../dev-images/images', import.meta.url).pathname
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname)
      requests.push(path)
      const body = routes[path]
      if (body !== undefined) return new Response(body)
      const file = Bun.file(root + path)
      return (await file.exists())
        ? new Response(file)
        : new Response('not found', { status: 404 })
    },
  })
  server.unref()
  return {
    url: (path) => new URL(path, server.url).href,
    requests,
    stop: () => void server.stop(true),
  }
}

/** NIfTI-1 datatype codes `niftiBytes` writes. */
const NIFTI_TYPES = {
  uint8: { code: 2, bits: 8, set: 'setUint8' },
  int16: { code: 4, bits: 16, set: 'setInt16' },
  uint16: { code: 512, bits: 16, set: 'setUint16' },
} as const

/**
 * A single-file NIfTI-1 image (`.nii`, uncompressed) with an identity-scaled
 * sform. `dims` is [nx, ny, nz] or [nx, ny, nz, nt]; `voxel(i)` gives the
 * value at linear index i across every frame.
 */
export function niftiBytes(options: {
  dims: readonly number[]
  datatype: keyof typeof NIFTI_TYPES
  voxel: (i: number) => number
  pixDims?: readonly [number, number, number]
  intentCode?: number
}): Uint8Array<ArrayBuffer> {
  const { dims, datatype, voxel, pixDims = [1, 1, 1], intentCode = 0 } = options
  const type = NIFTI_TYPES[datatype]
  const bytesPerVoxel = type.bits / 8
  const count = dims.reduce((a, b) => a * b, 1)
  const offset = 352
  const bytes = new Uint8Array(offset + count * bytesPerVoxel)
  const dv = new DataView(bytes.buffer)
  dv.setInt32(0, 348, true)
  const dim = [dims.length, ...dims]
  while (dim.length < 8) dim.push(1)
  for (const [i, d] of dim.entries()) dv.setInt16(40 + i * 2, d, true)
  dv.setInt16(68, intentCode, true)
  dv.setInt16(70, type.code, true)
  dv.setInt16(72, type.bits, true)
  for (const [i, p] of [1, ...pixDims, 1, 1, 1, 1].entries())
    dv.setFloat32(76 + i * 4, p, true)
  dv.setFloat32(108, offset, true)
  dv.setFloat32(112, 1, true) // scl_slope
  dv.setInt16(254, 1, true) // sform_code
  dv.setFloat32(280, pixDims[0], true)
  dv.setFloat32(300, pixDims[1], true)
  dv.setFloat32(320, pixDims[2], true)
  bytes.set([0x6e, 0x2b, 0x31, 0], 344) // 'n+1\0'
  for (let i = 0; i < count; i++)
    dv[type.set](offset + i * bytesPerVoxel, voxel(i), true)
  return bytes
}
