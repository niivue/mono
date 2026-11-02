// Runs the full-suite-metal e2e job on this Mac for a PR, then reports it.
//
// The CI job waits for a macOS runner, which can take longer than the suite.
// This runs the same steps on a local GPU in a throwaway worktree at the PR
// head, posts a `local-metal` commit status on that head, and on success adds
// the skip-metal label. CI skips its Metal run only when both are present, so
// a later push (a new head without the status) runs Metal again.
//
// Usage: bun .github/scripts/local-metal.ts <pr-number> [--no-label]

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  cmd: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' })
  return r.status === 0
}

function out(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

const repo = out('gh', [
  'repo',
  'view',
  '--json',
  'nameWithOwner',
  '-q',
  '.nameWithOwner',
])
const sha = out('gh', [
  'pr',
  'view',
  pr,
  '--json',
  'headRefOid',
  '-q',
  '.headRefOid',
])
const host = out('hostname', ['-s'])

function status(state: 'pending' | 'success' | 'failure', description: string) {
  out('gh', [
    'api',
    `repos/${repo}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    'context=local-metal',
    '-f',
    `description=${description} (${host})`.slice(0, 140),
  ])
}

// The PR's own test:e2e:metal, so a PR that changes the exclusions is run with them.
// shortcut: a head older than that script gets the exclusions as of its
// introduction (issue #453); drop the fallback once open PRs have merged main.
function e2eArgs(): string[] {
  const pkg = JSON.parse(readFileSync(join(niivue, 'package.json'), 'utf8'))
  return pkg.scripts?.['test:e2e:metal']
    ? ['run', 'test:e2e:metal']
    : [
        'x',
        'playwright',
        'test',
        '--grep-invert',
        'keeps its modulation|no plane seams',
      ]
}

const dir = mkdtempSync(join(tmpdir(), `niivue-metal-${pr}-`))
const niivue = join(dir, 'packages/niivue')
// Same settings as CI: JSON report, one retry, no reuse of a dev server.
const env = { ...process.env, CI: '1', PLAYWRIGHT_CHROMIUM_CHANNEL: 'chromium' }
let ok = false
const started = Date.now()
try {
  if (!run('git', ['fetch', 'origin', `pull/${pr}/head`]))
    throw new Error('fetch failed')
  if (!run('git', ['worktree', 'add', '--detach', dir, sha]))
    throw new Error('worktree failed')
  status('pending', `running at ${sha.slice(0, 8)}`)
  ok =
    run('git', ['lfs', 'pull'], dir) &&
    run('bun', ['install', '--frozen-lockfile'], dir) &&
    run('bunx', ['playwright', 'install', 'chromium'], niivue) &&
    run('bunx', ['nx', 'build', 'uikit'], dir, env) &&
    run('bun', e2eArgs(), niivue, env) &&
    run(
      'bun',
      [
        '.github/scripts/check-no-skipped-tests.ts',
        'packages/niivue/test-results/results.json',
      ],
      dir,
    )
} catch (e) {
  console.error(`local-metal: ${(e as Error).message}`)
} finally {
  const minutes = ((Date.now() - started) / 60_000).toFixed(1)
  try {
    status(
      ok ? 'success' : 'failure',
      `full suite ${ok ? 'passed' : 'failed'} in ${minutes} min`,
    )
    if (ok && addLabel)
      run('gh', ['pr', 'edit', pr, '--add-label', 'skip-metal'])
  } finally {
    if (ok) {
      run('git', ['worktree', 'remove', '--force', dir])
      rmSync(dir, { recursive: true, force: true })
    } else {
      // Kept for the Playwright report; remove with: git worktree remove --force <dir>
      console.error(`local-metal: worktree kept at ${dir}`)
    }
  }
}
console.log(
  `local-metal: PR #${pr} at ${sha.slice(0, 8)} ${ok ? 'PASSED' : 'FAILED'}`,
)
process.exit(ok ? 0 : 1)
