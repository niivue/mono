/**
 * What a `loadDocument` URL refers to, passed to `resolveUrl` so a caller can
 * treat content (volumes, meshes) differently from decoration (the thumbnail).
 */
export type DocumentLinkKind = 'volume' | 'mesh' | 'thumbnail'

/**
 * `loadDocument`'s `resolveUrl`: returns the URL to fetch instead, or `null`
 * to skip what it refers to.
 */
export type DocumentUrlResolver = (
  url: string,
  kind: DocumentLinkKind,
) => string | null

/**
 * The document entry to load, with its link resolved, or `null` to skip it.
 *
 * Only a linked entry (a `url` and no embedded `data`) reaches `resolve`; an
 * embedded entry keeps its `url` as a label and loads as is. Without a
 * resolver every entry loads unchanged.
 *
 * Extracted as a pure function because the document-reconstruction module is
 * not unit-testable under the bun test runner (its transitive imports evaluate
 * Vite's `import.meta.glob`).
 */
export function resolveLinkedEntry<T extends { url?: string; data?: unknown }>(
  entry: T,
  kind: Exclude<DocumentLinkKind, 'thumbnail'>,
  resolve?: DocumentUrlResolver,
): T | null {
  if (!resolve || entry.data || !entry.url) return entry
  const url = resolve(entry.url, kind)
  if (url === null) return null
  return url === entry.url ? entry : { ...entry, url }
}
