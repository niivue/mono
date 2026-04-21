Object.defineProperty(exports, "__esModule", { value: true })

const { join } = require("node:path")
const { VersionActions } = require("nx/release")

/**
 * Custom NX Release version actions for Pixi/Python projects.
 *
 * Supports both pixi.toml and pyproject.toml manifests:
 * - pixi.toml: version is under [workspace] as `version = "X.Y.Z"`
 * - pyproject.toml: version is under [project] as `version = "X.Y.Z"`
 *
 * The plugin auto-detects which manifest the project uses.
 */
class PixiVersionActions extends VersionActions {
  constructor(...args) {
    super(...args)
    this.validManifestFilenames = ["pixi.toml", "pyproject.toml"]
  }

  /**
   * Override init to correctly resolve the manifest path.
   * The base class has a bug where it picks the first validManifestFilename
   * for the path regardless of which file actually exists.
   */
  async init(tree) {
    const root = this.projectGraphNode.data.root
    const preserveLocal =
      this.finalConfigForProject.preserveLocalDependencyProtocols

    // Find which manifest actually exists
    for (const filename of this.validManifestFilenames) {
      const path = join(root, filename)
      if (tree.exists(path)) {
        this.manifestsToUpdate = [
          {
            manifestPath: path,
            preserveLocalDependencyProtocols: preserveLocal,
          },
        ]
        return
      }
    }

    // No manifest found — manifestsToUpdate stays empty, validate() will error
    this.manifestsToUpdate = []
  }

  async readCurrentVersionFromSourceManifest(tree) {
    if (this.manifestsToUpdate.length === 0) {
      throw new Error(
        `Unable to find pixi.toml or pyproject.toml for project "${this.projectGraphNode.name}"`,
      )
    }
    const manifestPath = this.manifestsToUpdate[0].manifestPath
    const content = tree.read(manifestPath, "utf-8")
    const match = content.match(/^version\s*=\s*"([^"]+)"/m)
    if (!match) {
      throw new Error(
        `No version field found in ${manifestPath} for project "${this.projectGraphNode.name}"`,
      )
    }
    return { manifestPath, currentVersion: match[1] }
  }

  async readCurrentVersionFromRegistry(_tree, _metadata) {
    return null
  }

  async readCurrentVersionOfDependency(tree, _projectGraph, depName) {
    if (this.manifestsToUpdate.length === 0) {
      return { currentVersion: null, dependencyCollection: null }
    }
    try {
      const content = tree.read(this.manifestsToUpdate[0].manifestPath, "utf-8")
      const toolNxMatch = content.match(
        /\[tool\.nx\][\s\S]*?workspace-dependencies\s*=\s*\[([^\]]*)\]/,
      )
      if (toolNxMatch?.[1].includes(`"${depName}"`)) {
        return {
          currentVersion: null,
          dependencyCollection: "workspace-dependencies",
        }
      }
    } catch {}
    return { currentVersion: null, dependencyCollection: null }
  }

  async updateProjectVersion(tree, newVersion) {
    const logMessages = []
    for (const manifestToUpdate of this.manifestsToUpdate) {
      const content = tree.read(manifestToUpdate.manifestPath, "utf-8")
      const updated = content.replace(
        /^(version\s*=\s*)"[^"]+"/m,
        `$1"${newVersion}"`,
      )
      tree.write(manifestToUpdate.manifestPath, updated)
      logMessages.push(
        `✍️  New version ${newVersion} written to manifest: ${manifestToUpdate.manifestPath}`,
      )
    }
    return logMessages
  }

  async updateProjectDependencies(_tree, _projectGraph, dependenciesToUpdate) {
    const count = Object.keys(dependenciesToUpdate).length
    if (count === 0) return []
    return [
      `ℹ️  ${count} workspace dependency version(s) not written (workspace-dependencies don't carry version specifiers)`,
    ]
  }
}

exports.default = PixiVersionActions
