import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import {
  assertNoPublishablePackageSkipped,
  findPublishablePackageProjects,
  readNpmReleaseGroupPatterns,
  resolveNpmReleaseProjects,
} from './npm-release-projects'

// These tests run against the real workspace so they fail whenever a public
// package is added outside the release group. Run from the repo root:
//   bun test .github/scripts

describe('npm release projects', () => {
  test('reads the typescript release group patterns from nx.json', () => {
    const patterns = readNpmReleaseGroupPatterns()
    expect(patterns).toContain('packages/niivue')
    expect(patterns).toContain('packages/uikit')
  })

  test('resolves every public package and no private one', () => {
    const projects = resolveNpmReleaseProjects()
    const nvExtensions = readdirSync('packages').filter((name) =>
      name.startsWith('nv-'),
    )
    expect(nvExtensions.length).toBeGreaterThan(0)
    for (const project of ['niivue', 'uikit', ...nvExtensions]) {
      expect(projects.has(project)).toBe(true)
    }
    for (const project of ['niivue-web-bridge', 'dev-images', 'ipyniivue']) {
      expect(projects.has(project)).toBe(false)
    }
    expect(new Set(findPublishablePackageProjects())).toEqual(projects)
  })

  test('throws when a publishable package would be skipped', () => {
    const projects = new Set(findPublishablePackageProjects())
    expect(() => assertNoPublishablePackageSkipped(projects)).not.toThrow()
    projects.delete('uikit')
    expect(() => assertNoPublishablePackageSkipped(projects)).toThrow(/uikit/)
  })
})
