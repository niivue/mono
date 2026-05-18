#!/usr/bin/env bun
// Verify that an npm package has its built files before publishing.
//
// Usage: bun .github/scripts/verify-built-package.ts <nx-project-name>

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const project = Bun.argv[2]
if (!project) {
  Bun.stderr.write('usage: verify-built-package.ts <nx-project-name>\n')
  process.exit(2)
}

type ProjectInfo = {
  root: string
}

type PackageJson = {
  name?: string
  files?: unknown
  main?: unknown
  module?: unknown
  types?: unknown
  exports?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parseProjectInfo = (value: unknown): ProjectInfo => {
  if (!isRecord(value) || typeof value.root !== 'string') {
    throw new Error(`Could not resolve Nx project root for ${project}`)
  }
  return { root: value.root }
}

const parsePackageJson = (value: unknown): PackageJson => {
  if (!isRecord(value)) {
    throw new Error('package.json did not contain an object')
  }
  return value
}

const projectJson = execFileSync(
  'bunx',
  ['nx', 'show', 'project', project, '--json'],
  { encoding: 'utf8' },
)
const { root: pkgDir } = parseProjectInfo(JSON.parse(projectJson))
const pkgPath = join(pkgDir, 'package.json')
const pkg = parsePackageJson(JSON.parse(readFileSync(pkgPath, 'utf8')))
const packageName = typeof pkg.name === 'string' ? pkg.name : project
const missing: string[] = []

const existsWithContent = (relativePath: string): boolean => {
  const absolutePath = join(pkgDir, relativePath.replace(/^\.\//, ''))
  if (!existsSync(absolutePath)) {
    return false
  }

  const stat = statSync(absolutePath)
  if (stat.isFile()) {
    return stat.size > 0
  }
  if (!stat.isDirectory()) {
    return true
  }

  const entries = readdirSync(absolutePath, {
    recursive: true,
    withFileTypes: true,
  })
  return entries.some((entry) => entry.isFile())
}

const verifyPath = (label: string, value: unknown) => {
  if (
    typeof value === 'string' &&
    value.startsWith('./') &&
    !existsWithContent(value)
  ) {
    missing.push(`${label}: ${value}`)
  }
}

if (Array.isArray(pkg.files)) {
  for (const entry of pkg.files) {
    if (
      typeof entry === 'string' &&
      !entry.startsWith('!') &&
      !existsWithContent(entry)
    ) {
      missing.push(`files entry: ${entry}`)
    }
  }
}

verifyPath('main', pkg.main)
verifyPath('module', pkg.module)
verifyPath('types', pkg.types)

const exportLabel = (label: string, key: string): string => {
  if (key === '.') {
    return label
  }
  if (key.startsWith('./')) {
    return `${label}["${key}"]`
  }
  return `${label}.${key}`
}

const verifyExports = (value: unknown, label: string) => {
  if (typeof value === 'string') {
    verifyPath(label, value)
    return
  }
  if (!isRecord(value)) {
    return
  }
  for (const [key, child] of Object.entries(value)) {
    verifyExports(child, exportLabel(label, key))
  }
}
verifyExports(pkg.exports, 'exports')

if (missing.length > 0) {
  Bun.stderr.write(`Package ${packageName} is missing built files:\n`)
  for (const item of missing) {
    Bun.stderr.write(`- ${item}\n`)
  }
  process.exit(1)
}

Bun.write(Bun.stdout, `Package ${packageName} built files verified\n`)
