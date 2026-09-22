import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

type NodeKind = 'project' | 'file' | 'symbol'
type EdgeKind = 'depends_on' | 'contains' | 'imports' | 'tests' | 'documents'

interface GraphNode {
  id: string
  kind: NodeKind
  name: string
  path?: string
  project?: string
  summary?: string
  tags?: string[]
  targets?: string[]
  symbolKind?: string
}

interface GraphEdge {
  source: string
  target: string
  kind: EdgeKind
}

interface RepoGraph {
  schemaVersion: 1
  revision: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

interface NxGraph {
  graph: {
    nodes: Record<
      string,
      {
        data: {
          root?: string
          tags?: string[]
          targets?: Record<string, unknown>
        }
      }
    >
    dependencies: Record<string, Array<{ target: string }>>
  }
}

const root = path.resolve(import.meta.dir, '..')
const outputDir = path.join(root, '.repo-graph')
const outputPath = path.join(outputDir, 'graph.json')

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `${command} exited ${result.status}`,
    )
  }
  return result.stdout.trim()
}

function nodeId(kind: NodeKind, value: string): string {
  return `${kind}:${value}`
}

function normalize(file: string): string {
  return file.split(path.sep).join('/')
}

function projectForFile(
  file: string,
  projects: Array<{ name: string; root: string }>,
): { name: string; root: string } | undefined {
  return projects
    .filter(
      ({ root: projectRoot }) =>
        file === projectRoot || file.startsWith(`${projectRoot}/`),
    )
    .sort((a, b) => b.root.length - a.root.length)[0]
}

function cleanSummary(raw: string): string | undefined {
  const text = raw
    .replace(/\{@link\s+([^}]+)\}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 0 ? text : undefined
}

function fileSummary(file: string, text: string): string | undefined {
  if (/\b(README|AGENTS|CLAUDE)\.md$/.test(file)) {
    const heading = text.match(/^#\s+(.+)$/m)?.[1]
    return heading ? `Documentation: ${heading}` : 'Documentation'
  }
  if (/\.html$/.test(file)) {
    const title = text.match(/<title>([^<]+)<\/title>/i)?.[1]
    return title ? cleanSummary(title) : undefined
  }
  const block = text.match(/^\s*\/\*\*?\s*\n?\s*\*?\s*([^@\n][^\n]*)/)
  if (block?.[1]) return cleanSummary(block[1])
  // Most files here open with a `//` comment, not a block comment. Take the
  // first top-of-file line-comment paragraph as the summary.
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\/\/\s?(.*)$/)
    if (!m) break
    if (m[1] === undefined || m[1].trim().length === 0) break
    lines.push(m[1])
    if (lines.join(' ').length > 160) break
  }
  return lines.length > 0 ? cleanSummary(lines.join(' ')) : undefined
}

function exportedSymbols(file: string, text: string): GraphNode[] {
  if (!/\.(?:ts|tsx)$/.test(file)) return []
  const symbols: GraphNode[] = []
  const pattern =
    /(?:^|\n)export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  for (const match of text.matchAll(pattern)) {
    const symbolKind = match[1]
    const name = match[2]
    if (!symbolKind || !name) continue
    symbols.push({
      id: nodeId('symbol', `${file}#${name}`),
      kind: 'symbol',
      name,
      path: file,
      symbolKind,
    })
  }
  return symbols
}

function importSpecifiers(file: string, text: string): string[] {
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file)) return []
  const imports = new Set<string>()
  // `from '...'` covers import/export-from; `import('...')` dynamic imports;
  // `import '...'` side-effect imports. Vite query suffixes (`?raw`,
  // `?worker&inline`) are stripped so the underlying file resolves.
  const pattern = /(?:from\s+|import\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm
  for (const match of text.matchAll(pattern)) {
    const specifier = match[2]?.replace(/\?.*$/, '')
    if (specifier) imports.add(specifier)
  }
  return [...imports]
}

function resolveImport(
  source: string,
  specifier: string,
  tracked: Set<string>,
  projectRoot: string | undefined,
): string | undefined {
  // `@/x` is the workspace-wide tsconfig alias for `<projectRoot>/src/x`.
  const base = specifier.startsWith('@/')
    ? projectRoot
      ? normalize(path.posix.join(projectRoot, 'src', specifier.slice(2)))
      : undefined
    : specifier.startsWith('.')
      ? normalize(
          path.posix.normalize(
            path.posix.join(path.posix.dirname(source), specifier),
          ),
        )
      : undefined
  if (!base) return undefined
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]
  return candidates.find((candidate) => tracked.has(candidate))
}

/** Map npm package names (from each project's package.json) to Nx projects. */
async function packageNameMap(
  projects: Array<{ name: string; root: string }>,
): Promise<Map<string, string>> {
  const byPackageName = new Map<string, string>()
  for (const { name, root: projectRoot } of projects) {
    try {
      const pkg = JSON.parse(
        await readFile(path.join(root, projectRoot, 'package.json'), 'utf8'),
      ) as { name?: string }
      if (pkg.name) byPackageName.set(pkg.name, name)
    } catch {
      // Not every project ships a package.json (e.g. Python projects).
    }
  }
  return byPackageName
}

function workspaceImport(
  specifier: string,
  byPackageName: Map<string, string>,
): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('@/')) return undefined
  // The package name is the first segment (two for scoped packages), so
  // `@niivue/niivue/webgl2` resolves to `@niivue/niivue`.
  const parts = specifier.split('/')
  const prefixLength = specifier.startsWith('@') ? 2 : 1
  const name = parts.slice(0, prefixLength).join('/')
  return byPackageName.get(name)
}

function sourceForTest(file: string, tracked: Set<string>): string | undefined {
  const source = file.replace(/\.(?:test|spec)(?=\.[^.]+$)/, '')
  return source !== file && tracked.has(source) ? source : undefined
}

async function buildGraph(): Promise<RepoGraph> {
  const nx = JSON.parse(run('bunx', ['nx', 'graph', '--print'])) as NxGraph
  const files = run('git', ['ls-files']).split('\n').filter(Boolean).sort()
  const tracked = new Set(files)
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const projects = Object.entries(nx.graph.nodes)
    .map(([name, value]) => ({ name, root: normalize(value.data.root ?? '') }))
    .filter(({ root: projectRoot }) => projectRoot.length > 0)

  for (const [name, value] of Object.entries(nx.graph.nodes).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    nodes.push({
      id: nodeId('project', name),
      kind: 'project',
      name,
      path: value.data.root,
      tags: [...(value.data.tags ?? [])].sort(),
      targets: Object.keys(value.data.targets ?? {}).sort(),
    })
  }
  for (const [source, dependencies] of Object.entries(nx.graph.dependencies)) {
    for (const dependency of dependencies) {
      edges.push({
        source: nodeId('project', source),
        target: nodeId('project', dependency.target),
        kind: 'depends_on',
      })
    }
  }

  const byPackageName = await packageNameMap(projects)

  for (const file of files) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|toml|md|wgsl|html)$/.test(file))
      continue
    const text = await readFile(path.join(root, file), 'utf8')
    const project = projectForFile(file, projects)
    const fileNode: GraphNode = {
      id: nodeId('file', file),
      kind: 'file',
      name: path.posix.basename(file),
      path: file,
      project: project?.name,
      summary: fileSummary(file, text),
    }
    nodes.push(fileNode)
    if (project) {
      edges.push({
        source: nodeId('project', project.name),
        target: fileNode.id,
        kind: 'contains',
      })
    }
    for (const symbol of exportedSymbols(file, text)) {
      symbol.project = project?.name
      nodes.push(symbol)
      edges.push({ source: fileNode.id, target: symbol.id, kind: 'contains' })
    }
    const importedProjects = new Set<string>()
    for (const specifier of importSpecifiers(file, text)) {
      const target = resolveImport(file, specifier, tracked, project?.root)
      if (target) {
        edges.push({
          source: fileNode.id,
          target: nodeId('file', target),
          kind: 'imports',
        })
        continue
      }
      // A workspace package import links the file to the target PROJECT —
      // which file backs the subpath is a package-exports question the graph
      // doesn't need to answer for routing.
      const targetProject = workspaceImport(specifier, byPackageName)
      if (targetProject && targetProject !== project?.name) {
        importedProjects.add(targetProject)
      }
    }
    for (const targetProject of importedProjects) {
      edges.push({
        source: fileNode.id,
        target: nodeId('project', targetProject),
        kind: 'imports',
      })
    }
    const tested = sourceForTest(file, tracked)
    if (tested) {
      edges.push({
        source: fileNode.id,
        target: nodeId('file', tested),
        kind: 'tests',
      })
    }
    if (/\b(?:README|AGENTS|CLAUDE)\.md$/.test(file) && project) {
      edges.push({
        source: fileNode.id,
        target: nodeId('project', project.name),
        kind: 'documents',
      })
    }
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id))
  edges.sort((a, b) =>
    `${a.source}\0${a.kind}\0${a.target}`.localeCompare(
      `${b.source}\0${b.kind}\0${b.target}`,
    ),
  )
  return {
    schemaVersion: 1,
    revision: run('git', ['rev-parse', 'HEAD']),
    nodes,
    edges,
  }
}

function optionNumber(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`)
  }
  return parsed
}

function nodeText(node: GraphNode): string {
  return [node.id, node.name, node.path, node.project, node.summary]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function queryGraph(graph: RepoGraph, query: string): RepoGraph {
  const depth = optionNumber('depth', 1)
  const maxNodes = optionNumber('max-nodes', 30)
  const needle = query.toLowerCase()
  // A multi-word query is an AND over terms: every term must appear somewhere
  // in the node's text. The whole phrase still gets the exact-match ladder.
  const terms = needle.split(/\s+/).filter(Boolean)
  const scores = new Map<string, number>()
  for (const node of graph.nodes) {
    const id = node.id.toLowerCase()
    const name = node.name.toLowerCase()
    const nodePath = node.path?.toLowerCase() ?? ''
    const text = nodeText(node)
    const score =
      (node.kind === 'project' && name === needle) || nodePath === needle
        ? 130
        : id === needle
          ? 120
          : name === needle
            ? 100
            : [id, name, nodePath].some((value) => value.endsWith(needle))
              ? 80
              : text.includes(needle)
                ? 50
                : terms.length > 1 && terms.every((term) => text.includes(term))
                  ? 40
                  : 0
    if (score > 0) scores.set(node.id, score)
  }
  const ranked = [...scores.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )
  const bestScore = ranked[0]?.[1] ?? 0
  const exact = ranked.filter(([, score]) =>
    bestScore >= 120 ? score === bestScore : score === 100,
  )
  // An exact project/file/symbol query should start from that node rather than
  // spending the entire budget on incidental path matches. Fuzzy queries keep
  // several seeds, but reserve most of the budget for their graph neighbors.
  const seeds =
    exact.length > 0 ? exact : ranked.slice(0, Math.min(8, maxNodes))
  const selected = new Set(seeds.map(([id]) => id))
  let frontier = new Set(selected)
  for (let hop = 0; hop < depth && selected.size < maxNodes; hop++) {
    const next = new Map<string, number>()
    for (const edge of graph.edges) {
      const neighbor = frontier.has(edge.source)
        ? edge.target
        : frontier.has(edge.target)
          ? edge.source
          : undefined
      if (neighbor && !selected.has(neighbor)) {
        const priority =
          edge.kind === 'tests'
            ? 0
            : edge.kind === 'imports' || edge.kind === 'depends_on'
              ? 1
              : edge.kind === 'documents'
                ? 2
                : 3
        next.set(neighbor, Math.min(priority, next.get(neighbor) ?? priority))
      }
    }
    for (const [id] of [...next].sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    )) {
      if (selected.size >= maxNodes) break
      selected.add(id)
    }
    frontier = new Set(next.keys())
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => selected.has(node.id)),
    edges: graph.edges.filter(
      (edge) => selected.has(edge.source) && selected.has(edge.target),
    ),
  }
}

function printMarkdown(graph: RepoGraph, query: string): void {
  console.log(`# Repository context: ${query}`)
  console.log(`\nRevision: ${graph.revision.slice(0, 12)}`)
  console.log(`Nodes: ${graph.nodes.length}; edges: ${graph.edges.length}`)
  for (const kind of ['project', 'file', 'symbol'] as const) {
    const nodes = graph.nodes.filter((node) => node.kind === kind)
    if (nodes.length === 0) continue
    console.log(`\n## ${kind}s`)
    for (const node of nodes) {
      // File and symbol IDs already carry the path; repeating it as a detail
      // just doubles the line. Projects keep their root path.
      const details = [
        node.kind === 'project' ? node.path : undefined,
        node.project,
        node.symbolKind,
        node.summary,
      ]
        .filter(Boolean)
        .join(' | ')
      console.log(`- ${node.id}${details ? ` | ${details}` : ''}`)
    }
  }
  if (graph.edges.length > 0) {
    console.log('\n## relationships')
    for (const edge of graph.edges) {
      console.log(`- ${edge.source} --${edge.kind}--> ${edge.target}`)
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'build') {
    const graph = await buildGraph()
    await mkdir(outputDir, { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(graph, null, 2)}\n`)
    console.log(
      `Wrote ${normalize(path.relative(root, outputPath))}: ` +
        `${graph.nodes.length} nodes, ${graph.edges.length} edges`,
    )
    return
  }
  if (command === 'query') {
    const query = process.argv[3]
    if (!query || query.startsWith('--')) {
      throw new Error(
        'Usage: bun run graph:query <term> [--depth=N] [--max-nodes=N] [--json]',
      )
    }
    let graph: RepoGraph
    try {
      graph = JSON.parse(await readFile(outputPath, 'utf8')) as RepoGraph
    } catch {
      throw new Error(
        'Knowledge graph not found; run bun run graph:build first',
      )
    }
    try {
      const head = run('git', ['rev-parse', 'HEAD'])
      if (head !== graph.revision) {
        console.log(
          `WARNING: graph built at ${graph.revision.slice(0, 12)}, HEAD is ` +
            `${head.slice(0, 12)} - run bun run graph:build to refresh\n`,
        )
      }
    } catch {
      // No git available; the revision check is best-effort.
    }
    const result = queryGraph(graph, query)
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      printMarkdown(result, query)
    }
    return
  }
  throw new Error('Usage: bun nx-tools/repo-graph.ts <build|query>')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
