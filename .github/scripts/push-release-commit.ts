#!/usr/bin/env bun
// Push the release commit and tags back to main.
//
// Usage: bun .github/scripts/push-release-commit.ts

const result = Bun.spawnSync(
  ['git', 'push', '--follow-tags', 'origin', 'HEAD:main'],
  {
    stdout: 'inherit',
    stderr: 'inherit',
  },
)

if (result.exitCode !== 0) {
  // The usual cause is main advancing while the release was being prepared,
  // which git rejects as a non-fast-forward push. The release commit was
  // computed against the old tip, so it cannot simply be rebased. Nothing
  // reached the remote, so the run is safe to redo from the new tip: the
  // next push to main triggers an automatic RC run, and a manual stable
  // release can be re-run from the Actions tab.
  throw new Error(
    'Failed to push release commit and tags. If main advanced during this run, rerun the release from the new tip; nothing was pushed or published.',
  )
}
