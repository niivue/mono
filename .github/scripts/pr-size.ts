#!/usr/bin/env bun
// Label pull requests whose diff to existing TypeScript/JavaScript files is
// too large to review comfortably, and clear the label once the PR shrinks.
//
// The count is additions plus deletions across files that match one of the
// COUNTED_EXTENSIONS and already exist on the base branch. Brand-new files are
// skipped entirely so that adding a test file does not eat the budget, and
// the auto-generated asset indexes are ignored.
//
// Everything is read through the GitHub REST API. The script never inspects
// a checkout, so it is safe to run from pull_request_target without touching
// the PR's code.
//
// Usage:
//   bun .github/scripts/pr-size.ts <pr-number> [--dry-run]
//
// Environment:
//   GITHUB_REPOSITORY    owner/repo (set by Actions; defaults to niivue/mono)
//   GITHUB_TOKEN         token with pull-requests: write (falls back to
//                        `gh auth token` for local runs)
//   GITHUB_STEP_SUMMARY  when set, a per-file table is appended to it
//
// --dry-run prints the count and the per-file table but does not touch
// labels or comments, so developers can check a PR before pushing more to it.

export const MAX_CHANGED_LINES = 250
export const COUNTED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]
export const IGNORED_PATHS = new Set([
  'packages/niivue/src/assets/fonts/index.ts',
  'packages/niivue/src/assets/matcaps/index.ts',
])
export const LABEL = {
  name: 'Oversized PR',
  color: 'd93f0b',
  description:
    'Over 250 changed lines in existing TS/JS files. Split into smaller PRs with meaningful, targeted changes.',
}
const COMMENT_MARKER = '<!-- pr-size-check -->'

/** The subset of the REST `pulls.listFiles` entry this script reads. */
export type PullFile = {
  filename: string
  status:
    | 'added'
    | 'removed'
    | 'modified'
    | 'renamed'
    | 'copied'
    | 'changed'
    | 'unchanged'
  additions: number
  deletions: number
}

export type CountedFile = { file: string; lines: number }

export type SizeReport = {
  files: CountedFile[]
  total: number
  tooLarge: boolean
}

/** Pure: pick the files that count and sum their changed lines. */
export const measure = (
  files: PullFile[],
  max: number = MAX_CHANGED_LINES,
): SizeReport => {
  const counted = files
    .filter((f) => f.status !== 'added')
    .filter((f) => !IGNORED_PATHS.has(f.filename))
    .filter((f) => COUNTED_EXTENSIONS.some((ext) => f.filename.endsWith(ext)))
    .map((f) => ({ file: f.filename, lines: f.additions + f.deletions }))
    .sort((a, b) => b.lines - a.lines)
  const total = counted.reduce((sum, f) => sum + f.lines, 0)
  return { files: counted, total, tooLarge: total > max }
}

const markdownTable = (files: CountedFile[]): string[] => [
  '| File | Lines changed |',
  '| --- | ---: |',
  ...files.map((f) => `| \`${f.file}\` | ${f.lines} |`),
]

/** Pure: the sticky PR comment shown while the PR is over the limit. */
export const renderComment = (
  report: SizeReport,
  max: number = MAX_CHANGED_LINES,
): string => {
  const top = report.files.slice(0, 10)
  const rest = report.files.length - top.length
  return [
    COMMENT_MARKER,
    '### This PR is too large for review',
    '',
    `It changes **${report.total}** lines across ${report.files.length} existing TypeScript/JavaScript files. ` +
      `The limit is ${max}. Please split it into smaller PRs, each with a meaningful, targeted change.`,
    '',
    'Largest files:',
    '',
    ...markdownTable(top),
    ...(rest > 0 ? [`| and ${rest} more | |`] : []),
    '',
    `Only edits to existing \`${COUNTED_EXTENSIONS.join('`, `')}\` files count. ` +
      'New files and auto-generated asset indexes are ignored. ' +
      `The label is removed automatically when the PR drops to ${max} lines or fewer.`,
  ].join('\n')
}

/** Pure: the job-summary section written on every run. */
export const renderSummary = (
  report: SizeReport,
  max: number = MAX_CHANGED_LINES,
): string =>
  [
    '## PR size check',
    '',
    `Lines changed in existing TS/JS files: ${report.total} across ${report.files.length} files (limit ${max}). ` +
      `New files are not counted. ${report.tooLarge ? `Label "${LABEL.name}" applied.` : 'Within limit.'}`,
    '',
    ...(report.files.length > 0 ? markdownTable(report.files) : []),
    '',
  ].join('\n')

// ---------------------------------------------------------------------------
// GitHub REST client: a thin fetch wrapper with Link-header pagination.
// ---------------------------------------------------------------------------

type Label = { name: string }
type Comment = { id: number; body?: string | null }

class GitHub {
  constructor(
    private readonly repo: string,
    private readonly token: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; next: string | null; status: number }> {
    const url = path.startsWith('https://')
      ? path
      : `https://api.github.com/repos/${this.repo}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`${method} ${url} -> ${res.status}: ${text}`)
    }
    const next =
      res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null
    const data =
      res.status === 204 ? (undefined as T) : ((await res.json()) as T)
    return { data, next, status: res.status }
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = []
    let url: string | null =
      `${path}${path.includes('?') ? '&' : '?'}per_page=100`
    while (url) {
      const page: { data: T[]; next: string | null } = await this.request<T[]>(
        'GET',
        url,
      )
      out.push(...page.data)
      url = page.next
    }
    return out
  }

  listFiles = (pr: number) => this.paginate<PullFile>(`/pulls/${pr}/files`)
  listLabels = (pr: number) => this.paginate<Label>(`/issues/${pr}/labels`)
  listComments = (pr: number) =>
    this.paginate<Comment>(`/issues/${pr}/comments`)

  async ensureLabel(): Promise<void> {
    try {
      await this.request('GET', `/labels/${encodeURIComponent(LABEL.name)}`)
    } catch (err) {
      if (!String(err).includes('-> 404')) throw err
      await this.request('POST', '/labels', LABEL)
    }
  }
  addLabel = (pr: number) =>
    this.request('POST', `/issues/${pr}/labels`, { labels: [LABEL.name] })
  removeLabel = (pr: number) =>
    this.request(
      'DELETE',
      `/issues/${pr}/labels/${encodeURIComponent(LABEL.name)}`,
    )
  createComment = (pr: number, body: string) =>
    this.request('POST', `/issues/${pr}/comments`, { body })
  updateComment = (id: number, body: string) =>
    this.request('PATCH', `/issues/comments/${id}`, { body })
  deleteComment = (id: number) =>
    this.request('DELETE', `/issues/comments/${id}`)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const resolveToken = (): string => {
  const fromEnv = process.env.GITHUB_TOKEN
  if (fromEnv) return fromEnv
  const result = Bun.spawnSync(['gh', 'auth', 'token'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const token = result.stdout?.toString().trim()
  if (result.exitCode === 0 && token) return token
  throw new Error('Set GITHUB_TOKEN or log in with `gh auth login`.')
}

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const prArg = args.find((a) => !a.startsWith('--'))
  const pr = Number(prArg)
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(
      `Usage: bun .github/scripts/pr-size.ts <pr-number> [--dry-run] (got ${JSON.stringify(prArg)})`,
    )
  }

  const repo = process.env.GITHUB_REPOSITORY ?? 'niivue/mono'
  const gh = new GitHub(repo, resolveToken())

  const report = measure(await gh.listFiles(pr))
  console.log(
    `${repo}#${pr}: ${report.total} lines changed across ${report.files.length} existing TS/JS files ` +
      `(limit ${MAX_CHANGED_LINES}); new files not counted`,
  )
  for (const f of report.files) {
    console.log(`  ${String(f.lines).padStart(6)}  ${f.file}`)
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    const existing = await Bun.file(summaryPath)
      .text()
      .catch(() => '')
    await Bun.write(summaryPath, existing + renderSummary(report))
  }

  if (dryRun) {
    console.log(
      report.tooLarge
        ? `dry run: would apply label "${LABEL.name}"`
        : 'dry run: within limit',
    )
    return
  }

  const hasLabel = (await gh.listLabels(pr)).some((l) => l.name === LABEL.name)
  if (report.tooLarge && !hasLabel) {
    await gh.ensureLabel()
    await gh.addLabel(pr)
    console.log(`added label "${LABEL.name}"`)
  } else if (!report.tooLarge && hasLabel) {
    await gh.removeLabel(pr)
    console.log(`removed label "${LABEL.name}"`)
  }

  const sticky = (await gh.listComments(pr)).find((c) =>
    c.body?.includes(COMMENT_MARKER),
  )
  if (report.tooLarge) {
    const body = renderComment(report)
    if (sticky) await gh.updateComment(sticky.id, body)
    else await gh.createComment(pr, body)
  } else if (sticky) {
    await gh.deleteComment(sticky.id)
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
