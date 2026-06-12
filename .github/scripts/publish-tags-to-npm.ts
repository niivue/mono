#!/usr/bin/env bun
// Publish npm packages for a set of existing git tags.
//
// Use this when `nx release` already ran (tags + GitHub Releases exist) but
// the npm publish step did not complete — e.g. an expired NPM_TOKEN. It is
// idempotent: tags whose `<project>@<version>` is already on the registry are
// skipped, so reruns are safe.
//
// Usage:
//   bun .github/scripts/publish-tags-to-npm.ts            # tags at HEAD
//   bun .github/scripts/publish-tags-to-npm.ts <tag>...   # explicit tags

import { readFileSync } from 'node:fs'

const run = (command: string[]) => {
  const result = Bun.spawnSync(command, {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${command.join(' ')}`)
  }
}

const output = (command: string[]): string => {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'inherit' })
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${command.join(' ')}`)
  }
  return result.stdout.toString().trim()
}

const tryOutput = (command: string[]): string | null => {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    return null
  }
  return result.stdout.toString().trim()
}

const isNpmReleaseProject = (project: string): boolean =>
  project === 'niivue' || project.startsWith('nv-')

// Parse explicit tags from argv. Accept whitespace-, comma-, or
// newline-separated input so the workflow_dispatch text box can be lenient.
const explicit = Bun.argv
  .slice(2)
  .flatMap((arg) => arg.split(/[\s,]+/))
  .map((tag) => tag.trim())
  .filter(Boolean)

const tags =
  explicit.length > 0
    ? explicit
    : output(['git', 'tag', '--points-at', 'HEAD']).split('\n').filter(Boolean)

if (explicit.length > 0) {
  const head = output(['git', 'rev-parse', 'HEAD'])
  for (const tag of explicit) {
    const tagCommit = output(['git', 'rev-list', '-n', '1', tag])
    if (tagCommit !== head) {
      throw new Error(
        `Tag ${tag} does not point at HEAD (${tagCommit} != ${head}). Check out the release commit for that tag before publishing.`,
      )
    }
  }
}
if (tags.length === 0) {
  console.log('No tags to publish.')
  process.exit(0)
}

console.log(`Considering ${tags.length} tag(s):`)
for (const tag of tags) {
  console.log(`  - ${tag}`)
}

const summary: string[] = []

for (const tag of tags) {
  const atIndex = tag.lastIndexOf('@')
  if (atIndex < 1) {
    console.log(`Skipping ${tag} (not a project@version tag)`)
    continue
  }

  const project = tag.slice(0, atIndex)
  const version = tag.slice(atIndex + 1)

  if (!isNpmReleaseProject(project)) {
    console.log(`Skipping ${tag} (not an npm release project)`)
    continue
  }

  // Resolve the npm package name from the project's package.json so the
  // existence check works regardless of project-name vs. scoped-name mapping.
  const projectInfo = JSON.parse(
    output(['bunx', 'nx', 'show', 'project', project, '--json']),
  ) as { root?: unknown }
  if (typeof projectInfo.root !== 'string') {
    throw new Error(`Could not resolve Nx project root for ${project}`)
  }
  const pkg = JSON.parse(
    readFileSync(`${projectInfo.root}/package.json`, 'utf8'),
  ) as { name?: unknown }
  if (typeof pkg.name !== 'string') {
    throw new Error(`Missing package.json "name" for ${project}`)
  }
  const pkgName = pkg.name

  const existing = tryOutput(['npm', 'view', `${pkgName}@${version}`, 'version'])
  if (existing && existing.trim() === version) {
    console.log(`Skipping ${pkgName}@${version} (already on npm)`)
    summary.push(`skipped ${pkgName}@${version} (already published)`)
    continue
  }

  const npmTag = version.includes('-') ? 'next' : 'latest'

  console.log(`Building ${project}`)
  run(['bunx', 'nx', 'run', `${project}:build`])

  console.log(`Verifying built package files for ${project}`)
  run(['bun', '.github/scripts/verify-built-package.ts', project])

  console.log(`Publishing ${pkgName}@${version} with dist-tag '${npmTag}'`)
  run([
    'bunx',
    'nx',
    'release',
    'publish',
    '--projects',
    project,
    '--tag',
    npmTag,
    '--verbose',
  ])
  summary.push(`published ${pkgName}@${version} (tag: ${npmTag})`)
}

console.log('\nSummary:')
for (const line of summary) {
  console.log(`  - ${line}`)
}
