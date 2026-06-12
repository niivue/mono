#!/usr/bin/env bun
// Publish npm packages for a set of existing git tags.
//
// Use this when `nx release` already ran (tags + GitHub Releases exist) but
// the npm publish step did not complete — e.g. an expired NPM_TOKEN. It is
// idempotent: tags whose `<project>@<version>` is already on the registry are
// skipped, so reruns are safe.
//
// Behavior:
//   - If tags are passed on argv, those are used.
//   - Otherwise tags are auto-discovered: the most recent commit reachable
//     from HEAD that has any `<project>@<version>` release tags pointing at
//     it is selected, and all such tags at that commit are used.
//   - All selected tags must point at the same commit. The script then
//     `git checkout`s that commit so the build matches the tagged source.
//
// Usage:
//   bun .github/scripts/publish-tags-to-npm.ts            # auto-discover
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

const parseTag = (tag: string): { project: string; version: string } | null => {
  const atIndex = tag.lastIndexOf('@')
  if (atIndex < 1) return null
  return { project: tag.slice(0, atIndex), version: tag.slice(atIndex + 1) }
}

// Parse explicit tags from argv. Accept whitespace-, comma-, or
// newline-separated input so the workflow_dispatch text box can be lenient.
const explicit = Bun.argv
  .slice(2)
  .flatMap((arg) => arg.split(/[\s,]+/))
  .map((tag) => tag.trim())
  .filter(Boolean)

// Discover release tags by walking commits reachable from HEAD until we find
// one with at least one `<project>@<version>` tag whose project is an npm
// release project. This is robust against unrelated commits landing on main
// after the release commit was pushed.
const discoverReleaseTags = (): string[] => {
  const commits = output(['git', 'log', '--format=%H', '-n', '500']).split('\n')
  for (const sha of commits) {
    const tagsAtCommit = output(['git', 'tag', '--points-at', sha])
      .split('\n')
      .filter(Boolean)
    const releaseTags = tagsAtCommit.filter((tag) => {
      const parsed = parseTag(tag)
      return parsed !== null && isNpmReleaseProject(parsed.project)
    })
    if (releaseTags.length > 0) {
      console.log(`Discovered release commit ${sha} with ${releaseTags.length} release tag(s)`)
      return releaseTags
    }
  }
  return []
}

const tags = explicit.length > 0 ? explicit : discoverReleaseTags()

if (tags.length === 0) {
  console.log('No release tags found to publish.')
  process.exit(0)
}

console.log(`Considering ${tags.length} tag(s):`)
for (const tag of tags) {
  console.log(`  - ${tag}`)
}

// Resolve all tags to commits and ensure they agree. Mixing tags from
// different release commits in one run would build the wrong source for some.
const tagCommits = new Map<string, string>()
for (const tag of tags) {
  const sha = tryOutput(['git', 'rev-list', '-n', '1', tag])
  if (!sha) {
    throw new Error(`Tag not found locally: ${tag} (ensure tags were fetched)`)
  }
  tagCommits.set(tag, sha)
}
const uniqueCommits = new Set(tagCommits.values())
if (uniqueCommits.size > 1) {
  console.error('Tags point at multiple commits; refusing to continue:')
  for (const [tag, sha] of tagCommits) {
    console.error(`  ${tag} -> ${sha}`)
  }
  process.exit(1)
}
const targetCommit = [...uniqueCommits][0]
if (!targetCommit) {
  throw new Error('Could not resolve target commit from tags')
}

const headBefore = output(['git', 'rev-parse', 'HEAD'])
if (headBefore !== targetCommit) {
  console.log(`Checking out tagged commit ${targetCommit} (was ${headBefore})`)
  run(['git', 'checkout', '--detach', targetCommit])
  // Reinstall in case the lockfile at the tagged commit differs from the
  // workflow branch we initially checked out.
  console.log('Reinstalling dependencies for tagged commit')
  run(['bun', 'install', '--frozen-lockfile'])
}

const summary: string[] = []

for (const tag of tags) {
  const parsed = parseTag(tag)
  if (!parsed) {
    console.log(`Skipping ${tag} (not a project@version tag)`)
    continue
  }
  const { project, version } = parsed

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
