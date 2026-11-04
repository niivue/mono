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
// code (install scripts, tests) as you, so it can read ~/.npmrc, your keychain
// and anything else you can; stripping tokens from its environment only stops
// the casual leak. The real control is reading the diff: a fork PR is refused
// unless --reviewed=<sha> names the head commit you read.
//
// Usage: bun .github/scripts/local-metal.ts <pr-number> [--no-label] [--reviewed=<sha>]

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pinned, so a fork clone's origin or gh default repo cannot misdirect the
// fetch, the status or the label.
const REPO = 'niivue/mono'
const LABEL = 'skip-metal'

const pr = process.argv[2]
const addLabel = !process.argv.includes('--no-label')
const reviewed =
  process.argv.find((a) => a.startsWith('--reviewed='))?.slice(11) ?? ''
if (!pr || !/^\d+$/.test(pr)) {
  console.error(
    'usage: bun .github/scripts/local-metal.ts <pr-number> [--no-label] [--reviewed=<sha>]',
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
const view = JSON.parse(out([...pull, 'headRefOid,isCrossRepository']))
const sha: string = view.headRefOid
// Tied to a commit, so a push after your review is not run unread.
if (
  view.isCrossRepository &&
  !(reviewed.length >= 7 && sha.startsWith(reviewed))
) {
  console.error(
    `local-metal: #${pr} is from a fork and its code runs on this machine; read the diff at ${sha.slice(0, 8)}, then pass --reviewed=${sha.slice(0, 8)}`,
  )
  process.exit(2)
}
// shortcut: assumes the dev server port from playwright.config.ts; a busy port
// would fail the suite and post a misleading public failure.
if (Bun.spawnSync(['lsof', '-ti', 'tcp:5273', '-sTCP:LISTEN']).exitCode === 0) {
  console.error('local-metal: port 5273 is in use; stop the dev server first')
  process.exit(2)
}

function status(
  state: 'pending' | 'success' | 'failure' | 'error',
  description: string,
) {
  out([
    'gh',
    'api',
    `repos/${REPO}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    'context=local-metal',
    '-f',
    `description=${description}`,
  ])
}

const dir = mkdtempSync(join(tmpdir(), `niivue-metal-${pr}-`))
const niivue = join(dir, 'packages/niivue')
// Same settings as CI: JSON report, one retry, no reuse of a dev server.
const env: Record<string, string | undefined> = {
  ...process.env,
  CI: '1',
  PLAYWRIGHT_CHROMIUM_CHANNEL: 'chromium',
}
// Keeps tokens out of the PR's environment (see the header for the limits).
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'])
  delete env[k]
const results = join(niivue, 'test-results/results.json')

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

type Final = 'success' | 'failure' | 'error'
let final: Final | undefined // unset: no public status yet
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
  final = 'error' // a setup step or a crash: the suite did not run to the end
  if (
    run(['git', 'lfs', 'pull'], dir) &&
    run(['bun', 'install', '--frozen-lockfile'], dir, env) &&
    run(['bunx', 'playwright', 'install', 'chromium'], niivue, env) &&
    run(['bunx', 'nx', 'build', 'uikit'], dir, env)
  )
    final =
      run(e2eCommand(), niivue, env) &&
      // From this checkout, not the PR's, so the PR cannot weaken the check.
      run(['bun', join(import.meta.dir, 'check-no-skipped-tests.ts'), results])
        ? 'success'
        : 'failure'
} catch (e) {
  console.error(`local-metal: ${(e as Error).message}`)
}
let ok = final === 'success'
if (ok) run(['git', 'worktree', 'remove', '--force', dir])
else console.error(`local-metal: worktree kept for the report at ${dir}`)

const minutes = ((Date.now() - started) / 60_000).toFixed(1)
const said: Record<Final, string> = {
  success: 'passed',
  failure: 'failed',
  error: 'did not finish',
}
if (final) {
  try {
    status(final, `full suite ${said[final]} in ${minutes} min`)
  } catch (e) {
    ok = false
    console.error(
      `local-metal: could not post the status: ${(e as Error).message}`,
    )
  }
}
if (ok && addLabel) {
  // Re-adding a label that is already there fires no event, so take it off
  // first: the labeled event then re-runs the gate against this status.
  const labels = out([...pull, 'labels', '-q', '.labels[].name']).split('\n')
  const edit = (flag: string) =>
    run(['gh', 'pr', 'edit', pr, '-R', REPO, flag, LABEL])
  if (
    (labels.includes(LABEL) && !edit('--remove-label')) ||
    !edit('--add-label')
  ) {
    console.error(
      `local-metal: passed, but re-adding ${LABEL} failed, so CI will still run Metal; remove and add it by hand`,
    )
    ok = false
  }
}
console.log(
  `local-metal: PR #${pr} at ${sha.slice(0, 8)} ${ok ? 'PASSED' : 'FAILED'}`,
)
process.exit(ok ? 0 : 1)
