// Plain Markdown versions of the guides, for agents and the "Copy page"
// button. llmstxt.org asks for them at the page URL plus `index.md` when the
// URL ends in a slash: /guide/loading/ -> /guide/loading/index.md.
import { type CollectionEntry, getCollection } from 'astro:content'
import { PACKAGES, sidebar } from '../sidebar'

type Guide = CollectionEntry<'docs'>

/** A guide's Markdown path under the site's base. */
export function markdownPath(id: string): string {
  return `${id}/index.md`
}

/** Every guide, in sidebar order. */
export async function guidesInOrder(): Promise<Guide[]> {
  const ids = sidebar.flatMap((group) =>
    group.items.filter((item) => typeof item === 'string'),
  )
  return Promise.all(ids.map(guide))
}

/** A package's docs, as listed in the sidebar's Packages section. */
export type PackageDocs = { dir: string; label: string; pages: Guide[] }

/**
 * Every listed package with its pages, in sidebar order: the overview first,
 * then by `sidebar.order`, then by id.
 */
export async function packagesInOrder(): Promise<PackageDocs[]> {
  const docs = await getCollection('docs')
  return PACKAGES.map(({ dir, label }) => {
    const root = `packages/${dir}`
    const rank = (entry: Guide) =>
      entry.id === root
        ? Number.NEGATIVE_INFINITY
        : (entry.data.sidebar.order ?? Number.POSITIVE_INFINITY)
    const pages = docs
      .filter((entry) => entry.id === root || entry.id.startsWith(`${root}/`))
      .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    return { dir, label, pages }
  }).filter((pkg) => pkg.pages.length > 0)
}

/** A package page's title with its package's label, for lists across packages. */
export function packagePageTitle(pkg: PackageDocs, page: Guide): string {
  const { title } = page.data
  return page.id === `packages/${pkg.dir}` || title.startsWith(pkg.label)
    ? title
    : `${pkg.label}: ${title}`
}

export async function guide(id: string): Promise<Guide> {
  const entry = await findGuide(id)
  if (!entry) throw new Error(`No guide ${id}`)
  return entry
}

/** The docs page for a Starlight route id, if the route is one. */
export async function findGuide(id: string): Promise<Guide | undefined> {
  // getCollection, not getEntry: getEntry warns for every route that is not
  // a docs page (the home page, the gallery).
  return (await getCollection('docs')).find((entry) => entry.id === id)
}

/**
 * The guide's MDX as plain Markdown: imports and live `<Demo>`s dropped,
 * `<Tabs>` unwrapped into labelled panels, and site links made absolute
 * against `site` (the docs root URL). Any other component would pass through
 * as written.
 */
export function guideMarkdown(entry: Guide, site: URL): string {
  const out: string[] = []
  let fence = ''
  for (const line of (entry.body ?? '').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker?.startsWith(fence)) fence = ''
      out.push(line)
    } else if (marker) {
      fence = marker
      out.push(line)
    } else if (/^import .+ from '[^']+'$/.test(line)) {
      // MDX imports mean nothing outside the site.
    } else if (/^<Demo\b[^>]*\/>$/.test(line)) {
      // A live viewer has nothing to show in text.
    } else if (/^\s*<(\/?Tabs|\/TabItem)\b[^>]*>\s*$/.test(line)) {
      // Tab panels read in order, each under its label.
    } else {
      const tab = /^\s*<TabItem label="([^"]+)"/.exec(line)
      if (tab) out.push(`**${tab[1]}**`)
      else out.push(line.replace(/\]\(\/(?!\/)/g, `](${site.href}`))
    }
  }
  const body = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const { title, description } = entry.data
  return `# ${title}\n\n${description ? `> ${description}\n\n` : ''}${body}\n`
}
