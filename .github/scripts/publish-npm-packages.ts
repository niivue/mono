#!/usr/bin/env bun
// Build, verify, and publish npm packages for all TypeScript release tags at HEAD.
//
// Usage: bun .github/scripts/publish-npm-packages.ts

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

const isNpmReleaseProject = (project: string): boolean =>
  project === 'niivue' || project.startsWith('nv-')

const tags = output(['git', 'tag', '--points-at', 'HEAD'])
  .split('\n')
  .filter(Boolean)

for (const tag of tags) {
  const atIndex = tag.lastIndexOf('@')
  if (atIndex < 1) {
    continue
  }

  const project = tag.slice(0, atIndex)
  const version = tag.slice(atIndex + 1)

  if (!isNpmReleaseProject(project)) {
    continue
  }

  const npmTag = version.includes('-') ? 'next' : 'latest'

  // `nx release publish --projects ...` intentionally excludes task
  // dependencies for filtered publishes, so targetDefaults on
  // nx-release-publish will not run `build` here. Run the project's Nx build
  // target explicitly so cached outputs are restored (or the package is built)
  // before npm packs the `files` allowlist.
  console.log(`Building ${project} before npm publish`)
  run(['bunx', 'nx', 'run', `${project}:build`])

  console.log(`Verifying built package files for ${project}`)
  run(['bun', '.github/scripts/verify-built-package.ts', project])

  console.log(
    `Publishing ${project}@${version} to npm with dist-tag '${npmTag}'`,
  )
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
}
