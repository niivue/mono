#!/usr/bin/env bun
// Create or update GitHub Releases for all Nx release tags at HEAD.
//
// Usage: bun .github/scripts/create-github-releases.ts

import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (command: string[], options?: { quiet?: boolean }): string => {
  const result = Bun.spawnSync(command, {
    stdout: options?.quiet ? 'pipe' : 'inherit',
    stderr: options?.quiet ? 'pipe' : 'inherit',
  })
  if (result.exitCode !== 0) {
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (output) {
      Bun.stderr.write(output)
    }
    throw new Error(`Command failed: ${command.join(' ')}`)
  }
  return result.stdout.toString().trim()
}

const commandSucceeds = (command: string[]): boolean => {
  const result = Bun.spawnSync(command, { stdout: 'ignore', stderr: 'ignore' })
  return result.exitCode === 0
}

type ProjectJson = {
  name?: unknown
}

type PackageJson = {
  name?: unknown
}

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8')) as T

const resolvePackageDir = (project: string): string | null => {
  for (const name of readdirSync('packages')) {
    const dir = join('packages', name)
    const projectPath = join(dir, 'project.json')
    if (existsSync(projectPath)) {
      const projectJson = readJson<ProjectJson>(projectPath)
      if (projectJson.name === project) {
        return dir
      }
    }

    const packagePath = join(dir, 'package.json')
    if (existsSync(packagePath)) {
      const packageJson = readJson<PackageJson>(packagePath)
      if (packageJson.name === project) {
        return dir
      }
    }
  }
  return null
}

const changelogTopSection = (pkgDir: string): string | null => {
  const changelogPath = join(pkgDir, 'CHANGELOG.md')
  if (!existsSync(changelogPath)) {
    return null
  }

  const lines = readFileSync(changelogPath, 'utf8').split('\n')
  const body: string[] = []
  let seenHeading = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (seenHeading) {
        break
      }
      seenHeading = true
      continue
    }
    if (seenHeading) {
      body.push(line)
    }
  }

  return body.join('\n').trim()
}

const sha = run(['git', 'rev-parse', 'HEAD'], { quiet: true })
const tags = run(['git', 'tag', '--points-at', 'HEAD'], { quiet: true })
  .split('\n')
  .filter(Boolean)
const tempDir = mkdtempSync(join(tmpdir(), 'github-releases-'))

for (const tag of tags) {
  const atIndex = tag.lastIndexOf('@')
  const project = tag.slice(0, atIndex)
  const version = tag.slice(atIndex + 1)
  const pkgDir = resolvePackageDir(project)
  const notes = pkgDir ? changelogTopSection(pkgDir) : null
  const notesFile =
    notes !== null
      ? join(tempDir, `${tag.replace(/[^a-zA-Z0-9._-]/g, '_')}.md`)
      : null
  if (notesFile) {
    await Bun.write(notesFile, notes ?? '')
  }

  const releaseExists = commandSucceeds(['gh', 'release', 'view', tag])
  if (releaseExists) {
    console.log(`Updating existing GitHub Release for ${tag}`)
    const args = ['gh', 'release', 'edit', tag, '--title', tag]
    if (notesFile) {
      args.push('--notes-file', notesFile)
    }
    run(args)
    continue
  }

  console.log(`Creating GitHub Release for ${tag}`)
  const args = ['gh', 'release', 'create', tag, '--title', tag, '--target', sha]
  if (notesFile) {
    args.push('--notes-file', notesFile)
  } else {
    console.log(
      `No CHANGELOG.md found for ${project}; using auto-generated notes.`,
    )
    args.push('--generate-notes')
  }
  if (version.includes('-')) {
    args.push('--prerelease')
  }
  run(args)
}
