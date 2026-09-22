#!/usr/bin/env bun
// Resolve the Nx projects that publish to npm.
//
// The source of truth is the "typescript" release group in nx.json. Every
// project that `nx release` versions and tags in that group must also be
// published, so the publish scripts derive their allowlist from the same
// patterns instead of hard-coding project names. (A hard-coded
// `niivue || nv-*` list once tagged uikit@0.1.0-rc.0 without publishing it,
// which left the published nv-ohif depending on a version that did not exist.)
//
// As a guard, every public (non-private) TypeScript package under packages/
// must resolve into the group. Otherwise a release would tag it without
// publishing it, so this throws and the workflow fails loudly.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const NPM_RELEASE_GROUP = 'typescript'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readJson = (path: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) {
    throw new Error(`${path} did not contain an object`)
  }
  return parsed
}

// The project patterns of the npm release group, exactly as written in
// nx.json (for example "packages/niivue", "packages/nv-*", "packages/uikit").
export const readNpmReleaseGroupPatterns = (
  nxJsonPath = 'nx.json',
): string[] => {
  const nxJson = readJson(nxJsonPath)
  const release = isRecord(nxJson.release) ? nxJson.release : {}
  const groups = isRecord(release.groups) ? release.groups : {}
  const group = groups[NPM_RELEASE_GROUP]
  const projects = isRecord(group) ? group.projects : undefined
  const patterns =
    typeof projects === 'string'
      ? [projects]
      : Array.isArray(projects)
        ? projects.filter((p): p is string => typeof p === 'string')
        : []
  if (patterns.length === 0) {
    throw new Error(
      `${nxJsonPath}: release group "${NPM_RELEASE_GROUP}" has no projects`,
    )
  }
  return patterns
}

// Project names of every public TypeScript package under packages/. A package
// is publishable when its package.json is not "private": true. The project
// name comes from project.json when present (Nx falls back to the package
// name otherwise).
export const findPublishablePackageProjects = (
  packagesDir = 'packages',
): string[] => {
  const projects: string[] = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const dir = join(packagesDir, entry.name)
    const packageJsonPath = join(dir, 'package.json')
    if (!existsSync(packageJsonPath)) {
      continue
    }
    const pkg = readJson(packageJsonPath)
    if (pkg.private === true) {
      continue
    }
    let name = typeof pkg.name === 'string' ? pkg.name : entry.name
    const projectJsonPath = join(dir, 'project.json')
    if (existsSync(projectJsonPath)) {
      const project = readJson(projectJsonPath)
      const tags = Array.isArray(project.tags) ? project.tags : []
      if (!tags.includes('lang:typescript')) {
        continue
      }
      if (typeof project.name === 'string') {
        name = project.name
      }
    }
    projects.push(name)
  }
  return projects.sort()
}

// Throw if any publishable package is not part of the npm release group.
export const assertNoPublishablePackageSkipped = (
  releaseProjects: ReadonlySet<string>,
  packagesDir = 'packages',
): void => {
  const missing = findPublishablePackageProjects(packagesDir).filter(
    (project) => !releaseProjects.has(project),
  )
  if (missing.length > 0) {
    throw new Error(
      `Publishable packages are not in the "${NPM_RELEASE_GROUP}" release group ` +
        `in nx.json and would be tagged without being published: ${missing.join(', ')}. ` +
        'Add them to the group or mark them "private": true.',
    )
  }
}

// Ask Nx to expand the group's patterns the same way `nx release` does, so
// the publish allowlist can never disagree with what was versioned.
export const resolveNpmReleaseProjects = (): Set<string> => {
  const patterns = readNpmReleaseGroupPatterns()
  const result = Bun.spawnSync(
    ['bunx', 'nx', 'show', 'projects', '--projects', ...patterns, '--json'],
    { stdout: 'pipe', stderr: 'inherit' },
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not resolve projects for release group "${NPM_RELEASE_GROUP}"`,
    )
  }
  const parsed: unknown = JSON.parse(result.stdout.toString())
  if (!Array.isArray(parsed)) {
    throw new Error('`nx show projects --json` did not return an array')
  }
  const projects = new Set(
    parsed.filter((p): p is string => typeof p === 'string'),
  )
  if (projects.size === 0) {
    throw new Error(
      `Release group "${NPM_RELEASE_GROUP}" resolved to no projects`,
    )
  }
  assertNoPublishablePackageSkipped(projects)
  return projects
}

if (import.meta.main) {
  for (const project of [...resolveNpmReleaseProjects()].sort()) {
    console.log(project)
  }
}
