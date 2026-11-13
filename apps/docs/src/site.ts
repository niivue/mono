// Server-side site settings. Client scripts get these through data attributes.

export const repoUrl = 'https://github.com/niivue/mono'

// Demos load their images, and the gallery embeds the example pages, from the
// published examples site. Point this at a local `bun run dev` server in
// packages/niivue (http://localhost:5273/) to try unpublished examples.
export const examplesBase =
  process.env.DOCS_EXAMPLES_BASE ?? 'https://niivue.github.io/mono/'

/** `path` under the site's base, e.g. `withBase('gallery/')`. */
export function withBase(path = ''): string {
  return import.meta.env.BASE_URL + path
}

/** The absolute URL of the docs root for the request `url` (the `site` origin in a build). */
export function docsUrl(url: URL): URL {
  return new URL(withBase(), url)
}

/** A file in the repository's main branch, as raw text. */
export function rawRepoUrl(path: string): string {
  return `https://raw.githubusercontent.com/niivue/mono/main/${path}`
}
