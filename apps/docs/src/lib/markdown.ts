// Plain Markdown versions of the guides, for agents and the "Copy page"
// button. llmstxt.org asks for them at the page URL plus `index.md` when the
// URL ends in a slash: /guide/loading/ -> /guide/loading/index.md.
import { type CollectionEntry, getEntry } from 'astro:content'
import { sidebar } from '../sidebar'
import { demoSource } from './demos'

type Guide = CollectionEntry<'docs'>

// The page runs each demo with these helpers; say so where the code is read
// without the page.
const DEMO_NOTE = `// Live demo from the docs page. \`asset(path)\` resolves a sample file under https://niivue.github.io/mono/ and \`ui\` builds the demo's controls; neither is part of NiiVue.`

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

export async function guide(id: string): Promise<Guide> {
  const entry = await findGuide(id)
  if (!entry) throw new Error(`No guide ${id}`)
  return entry
}

/** The guide for a Starlight route id, if the route is one (the home page's id is ''). */
export async function findGuide(id: string): Promise<Guide | undefined> {
  return id ? getEntry('docs', id) : undefined
}

/**
 * The guide's MDX as plain Markdown: imports dropped, each `<Demo>` replaced
 * by the code it runs, and site links made absolute against `site` (the docs
 * root URL). Any other component would pass through as written.
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
    } else {
      const demo = /^<Demo name="([\w-]+)"[^>]*\/>$/.exec(line)
      if (demo) out.push('```ts', DEMO_NOTE, demoSource(demo[1]), '```')
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
