// Pure helpers for pulling original DICOM P10 bytes (and a WSI series URL) out of
// a DICOMweb (WADO-RS) data source — the input dcm2niix needs (whole DICOM files, not decoded pixels).
//
// OHIF/cornerstone hands each instance a `wadors:` imageId that points at the
// *frame* resource, e.g.
//   wadors:https://host/dicomweb/studies/S/series/SE/instances/I/frames/1
// The full instance (header + pixel data) lives one level up, at the WADO-RS
// "retrieve instance" resource:
//   https://host/dicomweb/studies/S/series/SE/instances/I
// requested with `Accept: multipart/related; type="application/dicom"`, which
// returns the DICOM object(s) as a multipart/related body (unpacked by
// nv-ext-tile's parseMultipartRelated). These helpers derive the URLs.

/**
 * The http(s) URL a cornerstone imageId names, its loader scheme stripped. A
 * relative root (OHIF's `wadoRoot: '/dicomweb'` gives `wadors:/dicomweb/...`)
 * resolves against the document base, as the browser and cornerstone's loader
 * resolve it (a `<base>` or nested route differs from the page URL). Null for
 * anything else.
 */
export function imageIdUrl(imageId: string): string | null {
  try {
    const url = new URL(
      imageId.replace(/^(wadors|dicomweb|wadouri):/i, ''),
      globalThis.document?.baseURI ?? globalThis.location?.href,
    )
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null
  } catch {
    return null
  }
}

/**
 * Turn a cornerstone `wadors:`/`dicomweb:` frame imageId into the WADO-RS
 * retrieve-instance URL. Returns null if the id is not an http(s) DICOMweb
 * instance reference.
 */
export function retrieveInstanceUrlFromImageId(imageId: string): string | null {
  const raw = imageIdUrl(imageId)
  if (!raw) return null
  // Keep everything up to and including `/instances/<uid>`, dropping any
  // `/frames/...` (or other sub-resource) suffix.
  const m = raw.match(/^(.*\/instances\/[^/?#]+)(?:[/?#].*)?$/i)
  return m?.[1] ?? null
}

/**
 * The WADO-RS series URL (`.../studies/{s}/series/{se}`) an instance or frame
 * imageId sits under, its query (an access token) kept. Null for anything else.
 */
export function seriesUrlFromImageId(imageId: string): string | null {
  const raw = imageIdUrl(imageId)
  if (!raw) return null
  const url = new URL(raw)
  const series = /^(.*\/series\/[^/]+)\//i.exec(url.pathname)?.[1]
  if (!series) return null
  url.pathname = series
  url.hash = ''
  return url.href
}
