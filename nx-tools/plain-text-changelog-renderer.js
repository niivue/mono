// Custom Nx changelog renderer that strips emoji from the section headers
// Nx hardcodes in its default renderer (Breaking Changes, Updated Dependencies,
// Thank You). Commit-type section titles are driven by nx.json's
// release.conventionalCommits.types overrides, so this renderer doesn't need
// to touch those.
//
// Nx drops hidden-type commits before the renderer sees them, even breaking
// ones, so nx.json leaves every type visible and this renderer drops changes
// that neither bump the version nor break the API (#444).

const DefaultChangelogRenderer =
  require('nx/release/changelog-renderer').default

class PlainTextChangelogRenderer extends DefaultChangelogRenderer {
  preprocessChanges() {
    // After super so reverts can still cancel the commits they revert.
    super.preprocessChanges()
    const types = this.conventionalCommitsConfig.types
    this.relevantChanges = this.relevantChanges.filter(
      (c) => c.isBreaking || types[c.type]?.semverBump !== 'none',
    )
  }

  renderBreakingChanges() {
    const unique = Array.from(new Set(this.breakingChanges))
    return ['### Breaking Changes', '', ...unique]
  }

  renderDependencyBumps() {
    const markdownLines = ['', '### Updated Dependencies', '']
    for (const bump of this.dependencyBumps ?? []) {
      markdownLines.push(
        `- Updated ${bump.dependencyName} to ${bump.newVersion}`,
      )
    }
    return markdownLines
  }

  async renderAuthors() {
    // Delegate resolution to the parent (maps authors to GitHub usernames via
    // ungh / the gh CLI) and swap the only emoji heading for a plain one.
    const lines = await super.renderAuthors()
    return lines.map((line) =>
      line === '### ❤️ Thank You' ? '### Thank You' : line,
    )
  }
}

module.exports = PlainTextChangelogRenderer
module.exports.default = PlainTextChangelogRenderer
