// Builds the gallery from packages/niivue/examples: the section cards in
// examples/index.html give the order, grouping and link text, and the
// repository knowledge graph (nx-tools/repo-graph.ts) gives each page's
// summary and the scripts it loads.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const EXAMPLES_DIR = 'packages/niivue/examples'

// Pages left out of the gallery. allen.atlas.html reads its default dataset
// from imsc.allencell.org, which sends no CORS header, so it shows nothing on
// the published site.
const HIDDEN = new Set(['allen.atlas.html'])

export type GalleryFile = { name: string; code: string }

export type GalleryExample = {
  slug: string
  title: string
  section: string
  summary: string
  /** Page path relative to the examples site, e.g. `examples/vox.clip.html`. */
  page: string
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
      /<a href="\.\/([^"]+\.html)"[^>]*>([^<]+)<\/a>/g,
    )) {
      out.push({ section, page: link[1], title: link[2].trim() })
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
  const s = (summary ?? '').replace(/^NiiVue\s*[-:]?\s*/i, '').trim()
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
    const id = `file:${EXAMPLES_DIR}/${page}`
    const node = nodes.get(id)
    const html = readFileSync(path.join(dir, page), 'utf8')
    const files: GalleryFile[] = []
    const inline = inlineModuleScripts(html)
    if (inline) files.push({ name: page, code: asPackageImports(inline) })
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
      slug: page.replace(/\.html$/, '').replace(/[^a-zA-Z0-9-]+/g, '-'),
      title,
      section,
      summary: cleanSummary(node?.summary, title),
      page: `examples/${page}`,
      files,
    })
  }
  return examples
}
