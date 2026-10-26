/**
 * A matcap is applied by URL, but a URL is a poor thing to save in a
 * document. A dev server hands an imported JPG out as a page path
 * (`/src/assets/matcaps/Cortex.jpg`) that 404s anywhere else, and a production
 * build inlines it as a data URL that bloats every document. A matcap the
 * instance knows by name is therefore saved by that name and looked up again
 * on load.
 */

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
 * unchanged. A path saved before matcaps were saved by name is matched by its
 * file name (`/src/assets/matcaps/Cortex.jpg` is `cortex`), so those documents
 * load too. Names match case-insensitively.
 */
export function matcapFromName(
  saved: string,
  matcaps: Record<string, string> | undefined,
): string {
  if (!saved || !matcaps) return saved
  const lookup = (name: string): string | undefined => {
    const lower = name.toLowerCase()
    for (const [key, value] of Object.entries(matcaps)) {
      if (key.toLowerCase() === lower) return value
    }
    return undefined
  }
  const byName = lookup(saved)
  if (byName !== undefined) return byName
  // A data or blob URL is the image itself, not a path to one.
  if (/^(data|blob):/i.test(saved)) return saved
  const file = saved.split(/[?#]/)[0].split('/').pop() ?? ''
  const stem = file.replace(/\.[^.]*$/, '')
  return (stem && lookup(stem)) || saved
}
