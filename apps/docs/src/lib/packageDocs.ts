// Config-time helpers for the per-package docs in packages/<dir>/docs: the
// content ids they get, and the sidebar's Packages section.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { StarlightUserConfig } from '@astrojs/starlight/types'
import { PACKAGES, UNLISTED_PACKAGES } from '../sidebar'

type SidebarItem = NonNullable<StarlightUserConfig['sidebar']>[number]

const PAGE = /^[^_].*\.mdx?$/
const MANIFESTS = ['package.json', 'pyproject.toml', 'Package.swift']

/**
 * A docs file's content id, from its path under packages/: niivue's pages
 * keep their own paths (niivue/docs/guide/x.mdx is guide/x), every other
 * package's go under packages/<dir>/ (nv-react/docs/index.mdx is
 * packages/nv-react).
 */
export function docsId(entry: string): string {
  const [dir, , ...rest] = entry.split('/')
  const page = rest
    .join('/')
    .replace(/\.mdx?$/, '')
    .replace(/(^|\/)index$/, '')
  const prefix = dir === 'niivue' ? '' : `packages/${dir}`
  return [prefix, page].filter(Boolean).join('/').toLowerCase()
}

const isIndex = (file: string) => /^index\.mdx?$/.test(file)

/**
 * A package's page ids in sidebar order: the overview first, then by
 * `sidebar.order` in the page's frontmatter, then by file name. Starlight's `autogenerate` cannot list
 * them: it matches pages by their path under src/content/docs.
 */
function pageIds(dir: string, docsDir: string): string[] {
  return readdirSync(docsDir, { recursive: true, encoding: 'utf8' })
    .filter((file) => PAGE.test(path.basename(file)))
    .map((file) => {
      const text = readFileSync(path.join(docsDir, file), 'utf8')
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
      const order = /^\s+order:\s*(-?\d+)/m.exec(frontmatter)?.[1]
      return {
        id: docsId(`${dir}/docs/${file}`),
        order: order === undefined ? Number.POSITIVE_INFINITY : Number(order),
        file,
      }
    })
    .sort(
      (a, b) =>
        Number(isIndex(b.file)) - Number(isIndex(a.file)) ||
        a.order - b.order ||
        a.file.localeCompare(b.file),
    )
    .map((page) => page.id)
}

/**
 * The sidebar's Packages section: a link for a one-page package, a collapsed
 * group for a larger one. Fails when a package folder is missing from
 * PACKAGES, or a listed package has no docs/index page.
 */
export function packagesSection(packagesDir: string): SidebarItem {
  const listed = new Set(PACKAGES.map((p) => p.dir))
  const problems: string[] = []
  for (const dir of readdirSync(packagesDir)) {
    const isPackage = MANIFESTS.some((m) =>
      existsSync(path.join(packagesDir, dir, m)),
    )
    if (isPackage && !listed.has(dir) && !UNLISTED_PACKAGES.includes(dir))
      problems.push(`packages/${dir} is not in PACKAGES (src/sidebar.ts)`)
  }
  const items: SidebarItem[] = [
    { label: 'All packages', link: '/packages/' },
    { label: 'niivue', link: '/guide/' },
  ]
  for (const { dir, label } of PACKAGES) {
    const docsDir = path.join(packagesDir, dir, 'docs')
    const hasIndex = ['index.md', 'index.mdx'].some((f) =>
      existsSync(path.join(docsDir, f)),
    )
    if (!hasIndex) {
      problems.push(`packages/${dir}/docs/index.mdx is missing`)
      continue
    }
    const pages = pageIds(dir, docsDir)
    items.push(
      pages.length > 1
        ? { label, collapsed: true, items: pages }
        : { label, link: `/packages/${dir}/` },
    )
  }
  if (problems.length > 0)
    throw new Error(`Package docs:\n  ${problems.join('\n  ')}`)
  return { label: 'Packages', items }
}
