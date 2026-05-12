#!/usr/bin/env bun
// Run the TypeScript Nx release flow. In dry-run mode, append a compact
// release summary to GITHUB_STEP_SUMMARY.
//
// Usage: bun .github/scripts/run-typescript-release.ts [--rc] [--dry-run]

import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = new Set(Bun.argv.slice(2))
const isRc = args.has('--rc')
const isDryRun = args.has('--dry-run')

const ESC = String.fromCharCode(27)
const ansiPattern = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const stripAnsi = (value: string): string => value.replace(ansiPattern, '')

const releaseArgs = ['nx', 'release', '--groups', 'typescript']
if (isRc) {
  releaseArgs.push('--preid', 'rc')
}
if (isDryRun) {
  releaseArgs.push('--dry-run')
}
releaseArgs.push('--skip-publish')
if (!isDryRun) {
  releaseArgs.push('--verbose')
}

const result = Bun.spawnSync(['bunx', ...releaseArgs], {
  stdout: 'pipe',
  stderr: 'pipe',
})

const output = `${result.stdout.toString()}${result.stderr.toString()}`
Bun.write(Bun.stdout, output)

if (!isDryRun) {
  process.exit(result.exitCode)
}

const cleanOutput = stripAnsi(output)
const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) {
  const lines = ['## Nx Release Dry Run', '']

  if (result.exitCode !== 0) {
    const tempDir = mkdtempSync(join(tmpdir(), 'nx-release-'))
    const cleanLog = join(tempDir, 'dry-run.log')
    writeFileSync(cleanLog, cleanOutput)
    const tail = readFileSync(cleanLog, 'utf8')
      .split('\n')
      .slice(-80)
      .join('\n')
    lines.push(`Nx release dry run failed with exit code ${result.exitCode}.`)
    lines.push('', '```', tail, '```')
  } else {
    lines.push('| Project | Version | npm dist-tag | GitHub release |')
    lines.push('| --- | --- | --- | --- |')

    const releases = [
      ...cleanOutput.matchAll(/- project: ([^ ]+) ([0-9][^ ]*)/g),
    ]
    if (releases.length === 0) {
      lines.push('| None | None | None | None |')
    } else {
      for (const release of releases) {
        const project = release[1]
        const version = release[2]
        const isPrerelease = version.includes('-')
        lines.push(
          `| \`${project}\` | \`${version}\` | \`${
            isPrerelease ? 'next' : 'latest'
          }\` | \`${isPrerelease ? 'prerelease' : 'release'}\` |`,
        )
      }
    }
  }

  appendFileSync(summaryPath, `${lines.join('\n')}\n`)
}

process.exit(result.exitCode)
