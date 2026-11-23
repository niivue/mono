// Pure helpers deciding how a document persists volume data: embed the bytes
// (self-contained) or link by URL (the loader refetches on open). See
// NVDocument.serialize (`SerializeOptions.linkData`) and reconstructVolume (the
// `else if (v.url)` refetch branch).
//
// INVARIANT: linking assumes the URL's content is immutable and matches the
// in-memory voxels — the decision keys off "has a fetchable URL," not off "the
// bytes are unchanged." A volume edited in place after load must NOT be linked
// (reload would refetch the original). See `SerializeOptions.linkData` for the
// full contract.

/**
 * A URL the loader can refetch on open, so the volume's bytes need not be
 * embedded. A bare/relative path (e.g. `/volumes/mni152.nii.gz`) or an
 * `http(s)://` URL is assumed reachable; ephemeral `blob:` / `data:` URLs and
 * empty/whitespace strings are not.
 */
export function isLinkableUrl(url: string | undefined): boolean {
  if (!url) return false
  const u = url.trim()
  return u !== '' && !u.startsWith('blob:') && !u.startsWith('data:')
}

/**
 * The `url` a LINKED entry (volume or mesh; data omitted, refetched on load) is
 * written with, or `null` to embed its data: links only when `linkData` is
 * requested AND the entry has a linkable URL, then through `linkUrl` when given
 * (it may rewrite the URL, or return `null` to embed). Otherwise the entry
 * embeds so the document always round-trips.
 */
export function linkedUrl(
  url: string | undefined,
  kind: 'volume' | 'mesh',
  linkData: boolean,
  linkUrl?: (url: string, kind: 'volume' | 'mesh') => string | null,
): string | null {
  if (!linkData || !url || !isLinkableUrl(url)) return null
  return linkUrl ? linkUrl(url, kind) : url
}

/**
 * A streamed/chunked volume whose voxels live only in a runtime `chunkSource`
 * closure: `img` is null and it carries a `chunkPlan` and/or `chunkSource`. Such
 * a volume cannot be embedded (no bytes in memory) nor refetched — its `url` is a
 * `streamed://<id>` placeholder, not a fetchable resource — so
 * NVDocument.serialize DROPS it rather than write a url that reload would try, and
 * fail, to fetch. A restorable volume (in-memory `img`) is never transient.
 */
export function isTransientStreamedVolume(v: {
  img: unknown
  chunkPlan?: unknown
  chunkSource?: unknown
}): boolean {
  return v.img == null && (v.chunkPlan != null || v.chunkSource != null)
}
