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
 * Whether a volume's bytes should be LINKED (omitted, refetched from `url`)
 * rather than embedded: only when `linkData` is requested AND the volume has a
 * linkable URL. Otherwise the volume embeds so the document always round-trips.
 */
export function shouldLinkVolume(
  url: string | undefined,
  linkData: boolean,
): boolean {
  return linkData && isLinkableUrl(url)
}

/**
 * A streamed/chunked volume whose voxels live only in a runtime `chunkSource`
 * closure: `img` is null and it carries a `chunkPlan` and/or `chunkSource`. Such
 * a volume cannot be embedded (no bytes in memory) nor refetched — its `url` is a
 * `streamed://<id>` renderer texture-cache key, not a fetchable resource — so
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
