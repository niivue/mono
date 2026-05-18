#!/usr/bin/env bun
// Configure git identity for release commits.
//
// Usage: bun .github/scripts/configure-release-git.ts

const commands = [
  ['git', 'config', 'user.name', 'github-actions[bot]'],
  [
    'git',
    'config',
    'user.email',
    '41898282+github-actions[bot]@users.noreply.github.com',
  ],
]

for (const command of commands) {
  const result = Bun.spawnSync(command, {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${command.join(' ')}`)
  }
}
