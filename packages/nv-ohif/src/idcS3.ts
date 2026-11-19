// Imaging Data Commons series from its public S3 buckets. IDC's DICOMweb proxy
// refuses whole-instance downloads (500) and its metadata omits a large SEG's
// per-frame functional groups, so a SEG cannot be rebuilt from it; every
// instance is also a public S3 object (CORS *), located by IDC's v3 SQL index.

const IDC_PROXY_HOST = 'proxy.imaging.datacommons.cancer.gov'
const SQL_URL = 'https://api.imaging.datacommons.cancer.gov/v3/sql'

/** Whether a WADO-RS URL is served by IDC's DICOMweb proxy. */
export function isIdcProxyUrl(url: string): boolean {
  try {
    return new URL(url).host === IDC_PROXY_HOST
  } catch {
    return false
  }
}

type Location = { bucket: string; uuid: string; count: number }

async function seriesLocation(
  seriesUid: string,
  signal?: AbortSignal,
): Promise<Location | null> {
  const res = await fetch(SQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sql: 'SELECT aws_bucket, crdc_series_uuid, instanceCount FROM index WHERE SeriesInstanceUID = ?',
      params: [seriesUid],
      max_rows: 1,
    }),
    signal,
  })
  if (!res.ok) return null
  const row = (await res.json()).rows?.[0] as
    | { aws_bucket?: string; crdc_series_uuid?: string; instanceCount?: number }
    | undefined
  // The bucket becomes a hostname: only an S3 bucket name may.
  return row?.aws_bucket &&
    /^[a-z0-9.-]{3,63}$/.test(row.aws_bucket) &&
    row.crdc_series_uuid
    ? {
        bucket: row.aws_bucket,
        uuid: row.crdc_series_uuid,
        count: Number(row.instanceCount),
      }
    : null
}

const s3 = (bucket: string) => `https://${bucket}.s3.us-east-1.amazonaws.com`

async function listKeys(
  { bucket, uuid }: Location,
  signal?: AbortSignal,
): Promise<string[]> {
  const keys: string[] = []
  let token = ''
  do {
    const q = new URLSearchParams({ 'list-type': '2', prefix: `${uuid}/` })
    if (token) q.set('continuation-token', token)
    const res = await fetch(`${s3(bucket)}/?${q}`, { signal })
    if (!res.ok) throw new Error(`S3 listing failed: HTTP ${res.status}`)
    // ponytail: regex over S3 XML; IDC keys and tokens carry no XML entities.
    const xml = await res.text()
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g))
      if (m[1]?.endsWith('.dcm')) keys.push(m[1])
    token = /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? ''
  } while (token)
  return keys
}

/**
 * Every instance of an IDC series as Part 10 files from S3, or null when IDC
 * does not index it or `expected` (the display set's instance count) is not
 * the whole series, so the caller fetches through DICOMweb instead.
 */
export async function idcS3Files(
  seriesUid: string,
  expected: number,
  options: {
    signal?: AbortSignal
    concurrency?: number
    onProgress?: (loaded: number, total: number) => void
  } = {},
): Promise<File[] | null> {
  const { signal, concurrency = 8, onProgress } = options
  // Its own abort, linked to the caller's: on the first failed GET the finally
  // cancels its siblings before the caller falls back, without aborting that
  // fallback.
  const attempt = new AbortController()
  const stop = () => attempt.abort()
  signal?.addEventListener('abort', stop, { once: true })
  const own = attempt.signal
  try {
    const at = await seriesLocation(seriesUid, own)
    if (!at || at.count !== expected) return null
    const keys = await listKeys(at, own)
    if (keys.length !== at.count) return null
    const files: File[] = new Array(keys.length)
    let next = 0
    let done = 0
    onProgress?.(0, keys.length)
    const worker = async () => {
      while (next < keys.length && !own.aborted) {
        const i = next++
        const key = keys[i] as string
        const res = await fetch(`${s3(at.bucket)}/${key}`, { signal: own })
        if (!res.ok) throw new Error(`S3 GET ${key}: HTTP ${res.status}`)
        const bytes = await res.arrayBuffer()
        files[i] = new File([bytes], key.split('/')[1] ?? key, {
          type: 'application/dicom',
        })
        onProgress?.(++done, keys.length)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, keys.length) }, worker),
    )
    signal?.throwIfAborted()
    return files
  } catch (err) {
    // A failed index or S3 request falls back to DICOMweb; an abort does not.
    signal?.throwIfAborted()
    console.warn('[nv-ohif] IDC S3 fetch failed, using DICOMweb', err)
    return null
  } finally {
    stop()
    signal?.removeEventListener('abort', stop)
  }
}
