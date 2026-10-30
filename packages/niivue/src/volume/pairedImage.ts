import { log } from '@/logger'

/**
 * Detached-header pairing for URL loads.
 *
 * An AFNI dataset is a `.HEAD` text header plus a `.BRIK` (or `.BRIK.gz`) data
 * file next to it. The AFNI reader needs both, so a caller that passes only the
 * `.HEAD` URL would otherwise fail with "pairedImgData not set". The original
 * NiiVue derived the data URL from the header URL; this module does the same
 * for URL (string) loads that give no explicit `urlImageData`.
 *
 * Only AFNI is paired here. The other detached formats name their data file
 * inside the header (NRRD `data file`, MetaImage `ElementDataFile`, MRtrix
 * `file:`), so it cannot be derived from the URL alone, and the rewrite has no
 * Analyze `.hdr`/`.img` reader.
 */

/** Split a URL string into its path and its `?query` / `#fragment` suffix. */
function splitUrlSuffix(url: string): { path: string; suffix: string } {
  const cut = url.search(/[?#]/)
  return cut < 0
    ? { path: url, suffix: '' }
    : { path: url.slice(0, cut), suffix: url.slice(cut) }
}

/**
 * The data-file URLs to try for a detached header URL, in order of preference,
 * or `[]` when the URL is not a detached header this module pairs.
 *
 * `x+orig.HEAD` -> `x+orig.BRIK`, `x+orig.BRIK.gz`. The extension match is
 * case-insensitive; a lowercase `.head` pairs with `.brik` and anything else
 * with AFNI's own uppercase `.BRIK`. A `?query` or `#fragment` (a signed or
 * cache-busted URL) is carried over to each candidate unchanged.
 */
export function pairedImageUrlCandidates(url: string): string[] {
  const { path, suffix } = splitUrlSuffix(url)
  const match = /\.(head)$/i.exec(path)
  if (!match) return []
  const stem = path.slice(0, match.index)
  const brik = match[1] === 'head' ? 'brik' : 'BRIK'
  return [`${stem}.${brik}${suffix}`, `${stem}.${brik}.gz${suffix}`]
}

/**
 * Whether `url` answers a GET with a success status. The body is cancelled as
 * soon as the status is known, so a large data file is not downloaded twice.
 * GET rather than HEAD: some servers reject HEAD, a presigned URL is signed for
 * one method, and a cross-origin HEAD needs a CORS preflight a GET does not.
 * An HTML page is not a data file: an SPA host or dev server can answer a
 * missing path with its index page and a 200.
 */
async function urlExists(
  url: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const controller = new AbortController()
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    const type = response.headers.get('content-type') ?? ''
    return response.ok && !type.toLowerCase().startsWith('text/html')
  } catch {
    // Network error, CORS rejection, or an invalid URL: treat as absent.
    return false
  } finally {
    controller.abort()
  }
}

/**
 * The paired image data for a volume load. An explicit `urlImageData` always
 * wins. Otherwise, for a URL whose path ends in `.HEAD`, the first candidate
 * from {@link pairedImageUrlCandidates} that exists (`.BRIK`, then `.BRIK.gz`)
 * is returned. Returns `null` when nothing applies or nothing was found; the
 * reader then reports the missing data as before.
 *
 * File loads are never probed: a dropped `File` has no siblings to fetch.
 */
export async function resolvePairedImage(
  url: string | File,
  urlImageData: string | File | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string | File | null> {
  if (urlImageData != null) return urlImageData
  if (typeof url !== 'string') return null
  const candidates = pairedImageUrlCandidates(url)
  for (const candidate of candidates) {
    if (await urlExists(candidate, fetchImpl)) return candidate
  }
  if (candidates.length > 0) {
    log.warn(
      `No paired image data found for ${url} (tried ${candidates.join(', ')}); pass urlImageData to name it explicitly`,
    )
  }
  return null
}
