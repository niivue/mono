import type { NVSlideAttribution } from '@niivue/niivue'

const FIELDS = [
  'title',
  'url',
  'license',
  'credit',
  'citation',
  'modified',
] as const

/**
 * A caller's (or a file's) attribution as the manifest keeps it: string fields
 * only, rendered as text; `url` only when http(s). Undefined when nothing is left.
 */
export function cleanAttribution(
  a: NVSlideAttribution | undefined,
): NVSlideAttribution | undefined {
  if (!a || typeof a !== 'object') return undefined
  const out: NVSlideAttribution = {}
  for (const k of FIELDS) {
    const v = a[k]
    if (typeof v === 'string' && v) out[k] = v
  }
  if (out.url && !/^https?:\/\//i.test(out.url)) delete out.url
  return Object.keys(out).length ? out : undefined
}
