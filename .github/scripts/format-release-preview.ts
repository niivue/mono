#!/usr/bin/env bun
// Parse `nx release --dry-run` output into a markdown block for a PR comment.
//
// Usage: bun .github/scripts/format-release-preview.ts <dry-run-log>

const MARKER = '<!-- nx-release-preview -->'

const logPath = Bun.argv[2]
if (!logPath) {
  Bun.stderr.write('usage: format-release-preview.ts <dry-run-log>\n')
  process.exit(2)
}

const file = Bun.file(logPath)
if (!(await file.exists())) {
  Bun.stderr.write(`format-release-preview: cannot read ${logPath}\n`)
  process.exit(1)
}

const raw = await file.text()
const ESC = String.fromCharCode(27)
const ansi = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const clean = raw.replace(ansi, '')
const lines = clean.split('\n')

type Bump = { project: string; from: string; to: string; specifier: string }

const partials = new Map<string, Partial<Bump>>()
const mergeBump = (project: string, patch: Partial<Bump>) => {
  partials.set(project, { ...(partials.get(project) ?? { project }), ...patch })
}

const projectStart = / NX {3}Running release version for project:\s+(\S+)/
const fromPattern =
  /^(\S+)\s+.*(?:Resolved the current version as\s+(\S+)|Falling back to the version\s+(\S+)\s+in manifest)/
const specifierPattern = /^(\S+)\s+.*Resolved the specifier as\s+"(\w+)"/
// A project can emit multiple "New version X written" lines during one run
// (once from a dependency bump, again from commits). We keep the last.
const newVersionPattern = /^(\S+)\s+.*New version\s+(\S+)\s+written/

type ChangelogEntry = { project: string; body: string }
const changelogs: ChangelogEntry[] = []
const previewHeader =
  / NX {3}Previewing an entry in .*CHANGELOG\.md for\s+(\S+)@(\S+)/

let activeProject: string | null = null

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]

  const header = line.match(previewHeader)
  if (header) {
    const project = header[1]
    const body: string[] = []
    let started = false
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (l.startsWith('+')) {
        started = true
        body.push(l.replace(/^\+\s?/, ''))
      } else if (started) {
        break
      }
    }
    if (body.length > 0) {
      changelogs.push({ project, body: body.join('\n').trim() })
    }
    continue
  }

  const startMatch = line.match(projectStart)
  if (startMatch) {
    activeProject = startMatch[1]
    continue
  }
  if (!activeProject) continue

  const fromMatch = line.match(fromPattern)
  if (fromMatch && fromMatch[1] === activeProject) {
    const from = fromMatch[2] ?? fromMatch[3]
    if (from) mergeBump(activeProject, { from })
    continue
  }

  const specMatch = line.match(specifierPattern)
  if (specMatch && specMatch[1] === activeProject) {
    mergeBump(activeProject, { specifier: specMatch[2] })
    continue
  }

  const newMatch = line.match(newVersionPattern)
  if (newMatch && newMatch[1] === activeProject) {
    mergeBump(activeProject, { to: newMatch[2] })
  }
}

const isComplete = (b: Partial<Bump>): b is Bump =>
  typeof b.project === 'string' &&
  typeof b.from === 'string' &&
  typeof b.to === 'string' &&
  typeof b.specifier === 'string'

const bumps = [...partials.values()]
  .filter(isComplete)
  .filter((b) => b.from !== b.to)

const out: string[] = []
out.push(MARKER)
out.push('## Nx Release Preview')
out.push('')

if (bumps.length === 0) {
  out.push('_No packages will be released by this PR._')
  out.push('')
  out.push(
    'This usually means no conventional commits since the last tag touched a released package, or all commits are non-releasing types (`chore`, `docs`, etc.).',
  )
} else {
  out.push(`If merged, \`nx release\` will tag **${bumps.length}** package(s):`)
  out.push('')
  out.push('| Package | Bump | From | To |')
  out.push('| --- | --- | --- | --- |')
  for (const b of bumps) {
    out.push(`| \`${b.project}\` | ${b.specifier} | ${b.from} | **${b.to}** |`)
  }
  out.push('')

  if (changelogs.length > 0) {
    out.push('<details><summary>Changelog preview</summary>')
    out.push('')
    for (const c of changelogs) {
      out.push(`### ${c.project}`)
      out.push('')
      out.push(c.body)
      out.push('')
    }
    out.push('</details>')
    out.push('')
  }
}

out.push('---')
out.push(
  '_Dry-run preview only. Versions and tags are created when a maintainer runs the `Release` workflow manually._',
)

await Bun.write(Bun.stdout, `${out.join('\n')}\n`)
