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
  const messages: string[] = []
  const spy = spyOn(console, 'warn').mockImplementation((...args) => {
    messages.push(args.map(String).join(' '))
  })
  return { messages, restore: () => spy.mockRestore() }
}
