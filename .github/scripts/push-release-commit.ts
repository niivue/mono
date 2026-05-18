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
  throw new Error('Failed to push release commit and tags')
}
