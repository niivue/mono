/**
 * A matcap is applied by URL, but a URL is a poor thing to save in a
 * document. A dev server hands an imported JPG out as a page path
 * (`/src/assets/matcaps/Cortex.jpg`) that 404s anywhere else, and a production
 * build inlines it as a data URL that bloats every document. A matcap the
 * instance knows by name is therefore saved by that name and looked up again
 * on load.
 */

import { log } from '@/logger'

/** The instance default: its first matcap, or none. */
export function defaultMatcap(
  matcaps: Record<string, string> | undefined,
): string {
  return Object.values(matcaps ?? {})[0] ?? ''
}

/** The name to save for `url`: its key in `matcaps`, or `url` unchanged. */
export function matcapToName(
  url: string,
  matcaps: Record<string, string> | undefined,
): string {
  if (!url || !matcaps) return url
  for (const [name, value] of Object.entries(matcaps)) {
    if (value === url) return name
  }
  return url
}

/**
 * The URL to apply for a saved matcap: a name's URL in `matcaps`, or `saved`
 * unchanged. Names match case-insensitively.
 *
 * A document saved before matcaps were saved by name holds the dev server's
 * path to NiiVue's own asset (`/src/assets/matcaps/Cortex.jpg`), which 404s
 * anywhere else, so a same-origin path into `assets/matcaps/` is matched by
 * its file name. A URL with a scheme or host (`https://cdn.org/...`,
 * `//cdn.org/...`) is another server's image even under that path, so it is
 * kept, as is any other URL: if it does not load, the renderer draws the
 * default matcap. A bare name this instance does not know
 * cannot be fetched at all, so it is the instance default (its first matcap,
 * or none), with a warning naming the known matcaps.
 */
export function matcapFromName(
  saved: string,
  matcaps: Record<string, string> | undefined,
): string {
  if (!saved) return saved
  const entries = Object.entries(matcaps ?? {})
  const lookup = (name: string): string | undefined => {
    const lower = name.toLowerCase()
    for (const [key, value] of entries) {
      if (key.toLowerCase() === lower) return value
    }
    return undefined
  }
  const byName = lookup(saved)
  if (byName !== undefined) return byName
  if (!/[/\\.:?#]/.test(saved)) {
    log.warn(
      `Unknown matcap '${saved}', using the default. Known: ${entries.map(([key]) => key).join(', ') || 'none'}`,
    )
    return defaultMatcap(matcaps)
  }
  const path = saved.split(/[?#]/)[0].replace(/\\/g, '/')
  const sameOrigin = !/^([a-z][a-z\d+.-]*:|\/\/)/i.test(path)
  if (sameOrigin && /(^|\/)assets\/matcaps\/[^/]+$/.test(path)) {
    const stem = (path.split('/').pop() ?? '').replace(/\.[^.]*$/, '')
    const builtIn = stem ? lookup(stem) : undefined
    if (builtIn !== undefined) return builtIn
  }
  return saved
}
