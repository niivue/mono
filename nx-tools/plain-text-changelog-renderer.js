// Custom Nx changelog renderer that strips emoji from the section headers
// Nx hardcodes in its default renderer (Breaking Changes, Updated Dependencies,
// Thank You). Commit-type section titles (Features, Fixes, Performance) are
// driven by nx.json's release.conventionalCommits.types overrides, so this
// renderer doesn't need to touch those.

const DefaultChangelogRenderer =
  require('nx/release/changelog-renderer').default

class PlainTextChangelogRenderer extends DefaultChangelogRenderer {
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
