// Builds the gallery from packages/niivue/examples: the section cards in
// examples/index.html give the order, grouping and link text, and the
// repository knowledge graph (nx-tools/repo-graph.ts) gives each page's
// summary and the scripts it loads. The demo apps listed on the Pages site's
// own index (.github/pages/index.html) follow, under that page's headings.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const EXAMPLES_DIR = 'packages/niivue/examples'
export const PAGES_INDEX = '.github/pages/index.html'

// Pages left out of the gallery.
const HIDDEN = new Set<string>()

type GalleryFile = { name: string; code: string }

export type GalleryExample = {
  slug: string
  title: string
  section: string
  summary: string
  /** Page path relative to the examples site, e.g. `examples/vox.clip.html`. */
  page: string
  /** The page's HTML file in the repository. */
  source: string
  files: GalleryFile[]
}

type GraphNode = { id: string; kind: string; path?: string; summary?: string }
type GraphEdge = { source: string; target: string; kind: string }
type Graph = { nodes: GraphNode[]; edges: GraphEdge[] }

export function buildGraph(repoRoot: string): Graph {
  const run = spawnSync('bun', ['run', 'graph:build'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (run.status !== 0) {
    throw new Error(`graph:build failed:\n${run.stderr || run.stdout}`)
  }
  return JSON.parse(
    readFileSync(path.join(repoRoot, '.repo-graph/graph.json'), 'utf8'),
  )
}

/** Section title and `./page.html` links, in index.html order. */
function readSections(
  indexHtml: string,
): { section: string; page: string; title: string }[] {
  const out: { section: string; page: string; title: string }[] = []
  for (const card of indexHtml.matchAll(
    /<section class="card">([\s\S]*?)<\/section>/g,
  )) {
    const section = card[1].match(/<h1>([^<]+)<\/h1>/)?.[1].trim() ?? ''
    for (const link of card[1].matchAll(
      /<a href="\.\/([^"?]+\.html(?:\?[^"]*)?)"[^>]*>([\s\S]*?)<\/a>/g,
    )) {
      // Link text may hold markup, e.g. <code>perfFrame</code>.
      const title = link[2].replace(/<[^>]+>/g, '').trim()
      out.push({ section, page: link[1], title })
    }
  }
  return out
}

// The example pages import the library source through Vite; show the
// published package name a reader would use instead.
function asPackageImports(code: string): string {
  return code.replace(
    /(['"])(?:\.\.\/)+src\/index(?:\.webgpu|\.webgl2)?\.ts\1/g,
    (m) => {
      const entry = m.match(/index(\.webgpu|\.webgl2)?\.ts/)?.[1]
      return `'@niivue/niivue${entry ? `/${entry.slice(1)}` : ''}'`
    },
  )
}

function inlineModuleScripts(html: string): string {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/\bsrc=/.test(m[1]) && m[2].trim())
    .map((m) => dedent(m[2]))
    .join('\n\n')
}

function dedent(code: string): string {
  const lines = code.replace(/^\n+|\s+$/g, '').split('\n')
  const indent = Math.min(
    ...lines
      .filter((l) => l.trim())
      .map((l) => l.match(/^ */)?.[0].length ?? 0),
  )
  return lines.map((l) => l.slice(indent)).join('\n')
}

// Page titles mostly read "NiiVue - Basic"; keep only what adds to the link text.
function cleanSummary(summary: string | undefined, title: string): string {
  const s = (summary ?? '').replace(/^NiiVue\s*[-:\u2014]?\s*/i, '').trim()
  return s && s.toLowerCase() !== title.toLowerCase() ? s : ''
}

export function collectGallery(
  repoRoot: string,
  graph: Graph,
): GalleryExample[] {
  const dir = path.join(repoRoot, EXAMPLES_DIR)
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const imports = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (e.kind !== 'imports') continue
    imports.set(e.source, [...(imports.get(e.source) ?? []), e.target])
  }
  const seen = new Set<string>()
  const examples: GalleryExample[] = []
  for (const { section, page, title } of readSections(
    readFileSync(path.join(dir, 'index.html'), 'utf8'),
  )) {
    if (seen.has(page) || HIDDEN.has(page)) continue
    seen.add(page)
    // A query string picks a variant of one page (cinematic.html?sample=...).
    const [file, query] = page.split('?')
    const id = `file:${EXAMPLES_DIR}/${file}`
    const node = nodes.get(id)
    const html = readFileSync(path.join(dir, file), 'utf8')
    const files: GalleryFile[] = []
    const inline = inlineModuleScripts(html)
    if (inline) files.push({ name: file, code: asPackageImports(inline) })
    // Scripts the page loads that live beside it (not the library itself).
    const local = (imports.get(id) ?? [])
      .map((t) => nodes.get(t)?.path)
      .filter((p): p is string => !!p?.startsWith(`${EXAMPLES_DIR}/`))
    for (const p of local) {
      files.push({
        name: path.basename(p),
        code: asPackageImports(readFileSync(path.join(repoRoot, p), 'utf8')),
      })
    }
    examples.push({
      slug: [file.replace(/\.html$/, ''), query?.replace(/^[^=]*=/, '')]
        .filter(Boolean)
        .join('-')
        .replace(/[^a-zA-Z0-9-]+/g, '-'),
      title,
      section,
      summary: cleanSummary(node?.summary, title),
      page: `examples/${page}`,
      source: `${EXAMPLES_DIR}/${file}`,
      files,
    })
  }
  return groupSingletons([...examples, ...collectApps(repoRoot, nodes)])
}

// A section with one example becomes part of a final 'Other' section.
function groupSingletons(all: GalleryExample[]): GalleryExample[] {
  const counts = new Map<string, number>()
  for (const e of all) counts.set(e.section, (counts.get(e.section) ?? 0) + 1)
  const lone = (e: GalleryExample) => counts.get(e.section) === 1
  return [
    ...all.filter((e) => !lone(e)),
    ...all.filter(lone).map((e) => {
      // Keep the lost heading when the title alone is vague ('Minimal').
      const word = e.section.split(' ')[0].toLowerCase()
      const title = e.title.toLowerCase().includes(word)
        ? e.title
        : `${e.title} (${e.section})`
      return { ...e, title, section: 'Other' }
    }),
  ]
}

// Pages-index headings as gallery sections; DANDI joins the examples'
// own Streaming section.
const APP_SECTIONS: Record<string, string> = {
  'Streaming Demos': 'Streaming',
  'Web Component Demos': 'Web Components',
  'Extension Demos': 'Extensions',
}

// Demo apps from the Pages index: each <h1> heads a list of links to built
// app pages (`<app>/<page>.html`, built from apps/<app>/<page>.html). Links
// into examples/ are already in the gallery.
function collectApps(
  repoRoot: string,
  nodes: Map<string, GraphNode>,
): GalleryExample[] {
  const html = readFileSync(path.join(repoRoot, PAGES_INDEX), 'utf8')
  const apps: GalleryExample[] = []
  for (const block of html.split(/<h1>/).slice(1)) {
    const heading = block.slice(0, block.indexOf('</h1>')).trim()
    const section = APP_SECTIONS[heading] ?? heading
    for (const li of block.matchAll(
      /<a\s+href="\.\/([^"]+\.html)"[^>]*>([\s\S]*?)<\/a\s*>([\s\S]*?)<\/li>/g,
    )) {
      const page = li[1]
      if (page.startsWith('examples/')) continue
      const source = `apps/${page}`
      const pageHtml = readFileSync(path.join(repoRoot, source), 'utf8')
      const script = pageHtml.match(
        /<script\b[^>]*\bsrc="\/?([^"]+\.[jt]s)"/,
      )?.[1]
      const scriptPath = script && path.join(path.dirname(source), script)
      const text = (t: string) =>
        t
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      const title = text(li[2])
      apps.push({
        slug: page
          .replace(/(\/index)?\.html$/, '')
          .replace(/[^a-zA-Z0-9-]+/g, '-'),
        title,
        section,
        summary:
          text(li[3]).replace(/^\u2014\s*/, '') ||
          cleanSummary(nodes.get(`file:${source}`)?.summary, title),
        page,
        source,
        files: scriptPath
          ? [
              {
                name: path.basename(scriptPath),
                code: readFileSync(path.join(repoRoot, scriptPath), 'utf8'),
              },
            ]
          : [],
      })
    }
  }
  return apps
}
