// Runs the full-suite-metal e2e job on this Mac for a PR, then reports it.
//
// The CI job waits for a macOS runner, which can take longer than the suite.
// This runs the same steps on a local GPU in a throwaway worktree at the PR
// head, posts a `local-metal` commit status on that head, and on success adds
// the skip-metal label, removing it first if it is already there so the
// `labeled` event re-runs the CI gate against the new status. CI skips its
// Metal run only when the label and a successful status on the head are both
// present, so a later push (a new head without the status) runs Metal again.
//
// Needs write access to niivue/mono (statuses and labels). It runs the PR's
// code (install scripts, tests) with your environment, so read a fork PR first.
//
// Usage: bun .github/scripts/local-metal.ts <pr-number> [--no-label]

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pinned, so a fork clone's origin or gh default repo cannot misdirect the
// fetch, the status or the label.
const REPO = 'niivue/mono'
const LABEL = 'skip-metal'

const pr = process.argv[2]
const addLabel = !process.argv.includes('--no-label')
if (!pr || !/^\d+$/.test(pr)) {
  console.error(
    'usage: bun .github/scripts/local-metal.ts <pr-number> [--no-label]',
  )
  process.exit(2)
}
if (process.platform !== 'darwin') {
  console.error(
    'local-metal: run this on a Mac (the point is a real Metal GPU)',
  )
  process.exit(2)
}

function run(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): boolean {
  console.log(`$ ${cmd.join(' ')}`)
  return (
    Bun.spawnSync(cmd, { cwd, env, stdout: 'inherit', stderr: 'inherit' })
      .exitCode === 0
  )
}

function out(cmd: string[]): string {
  const r = Bun.spawnSync(cmd)
  if (r.exitCode !== 0)
    throw new Error(`${cmd.join(' ')} failed: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

const pull = ['gh', 'pr', 'view', pr, '-R', REPO, '--json']
const sha = out([...pull, 'headRefOid', '-q', '.headRefOid'])
const host = out(['hostname', '-s'])

function status(state: 'pending' | 'success' | 'failure', description: string) {
  out([
    'gh',
    'api',
    `repos/${REPO}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    'context=local-metal',
    '-f',
    `description=${description} (${host})`.slice(0, 140),
  ])
}

const dir = mkdtempSync(join(tmpdir(), `niivue-metal-${pr}-`))
const niivue = join(dir, 'packages/niivue')
// Same settings as CI: JSON report, one retry, no reuse of a dev server.
const env = { ...process.env, CI: '1', PLAYWRIGHT_CHROMIUM_CHANNEL: 'chromium' }

// The PR's own test:e2e:metal, so a PR that changes the exclusions is run with them.
// shortcut: a head older than that script gets the exclusions as of its
// introduction (issue #453); drop the fallback once open PRs have merged main.
function e2eCommand(): string[] {
  const pkg = JSON.parse(readFileSync(join(niivue, 'package.json'), 'utf8'))
  return pkg.scripts?.['test:e2e:metal']
    ? ['bun', 'run', 'test:e2e:metal']
    : [
        'bunx',
        'playwright',
        'test',
        '--grep-invert',
        'keeps its modulation|no plane seams',
      ]
}

let ok = false
const started = Date.now()
try {
  const ref = `refs/remotes/local-metal/${pr}`
  if (
    !run([
      'git',
      'fetch',
      `https://github.com/${REPO}.git`,
      `+pull/${pr}/head:${ref}`,
    ])
  )
    throw new Error('fetch failed')
  if (!run(['git', 'worktree', 'add', '--detach', dir, sha]))
    throw new Error('worktree failed')
  status('pending', `running at ${sha.slice(0, 8)}`)
  ok =
    run(['git', 'lfs', 'pull'], dir) &&
    run(['bun', 'install', '--frozen-lockfile'], dir) &&
    run(['bunx', 'playwright', 'install', 'chromium'], niivue) &&
    run(['bunx', 'nx', 'build', 'uikit'], dir, env) &&
    run(e2eCommand(), niivue, env) &&
    run(
      [
        'bun',
        '.github/scripts/check-no-skipped-tests.ts',
        'packages/niivue/test-results/results.json',
      ],
      dir,
    )
} catch (e) {
  console.error(`local-metal: ${(e as Error).message}`)
} finally {
  // git worktree remove deletes the folder too.
  if (ok) run(['git', 'worktree', 'remove', '--force', dir])
  else console.error(`local-metal: worktree kept for the report at ${dir}`)
}

const minutes = ((Date.now() - started) / 60_000).toFixed(1)
status(
  ok ? 'success' : 'failure',
  `full suite ${ok ? 'passed' : 'failed'} in ${minutes} min`,
)
if (ok && addLabel) {
  // Re-adding a label that is already there fires no event, so take it off
  // first: the labeled event then re-runs the gate against this status.
  const labels = out([...pull, 'labels', '-q', '.labels[].name']).split('\n')
  if (labels.includes(LABEL))
    run(['gh', 'pr', 'edit', pr, '-R', REPO, '--remove-label', LABEL])
  run(['gh', 'pr', 'edit', pr, '-R', REPO, '--add-label', LABEL])
}
console.log(
  `local-metal: PR #${pr} at ${sha.slice(0, 8)} ${ok ? 'PASSED' : 'FAILED'}`,
)
process.exit(ok ? 0 : 1)
