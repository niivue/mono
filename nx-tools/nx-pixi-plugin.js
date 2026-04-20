const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * Local NX plugin that reads pixi.toml and pyproject.toml files to infer
 * Python project dependencies for the NX dependency graph.
 *
 * It looks for a [tool.nx] section with a workspace-dependencies list:
 *
 *   [tool.nx]
 *   workspace-dependencies = ["py-package-c"]
 *
 * Both pixi and pyproject.toml ignore [tool.*] sections that aren't theirs,
 * so this won't interfere with dependency resolution. The plugin creates a
 * static dependency edge for each listed project that exists in the workspace.
 */

const name = "nx-pixi-plugin";

const MANIFEST_FILES = ["pixi.toml", "pyproject.toml"];

/**
 * Parse [tool.nx] workspace-dependencies from a TOML file's content.
 * Returns an array of project names.
 */
function parseWorkspaceDeps(content) {
  const deps = [];
  let inToolNx = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("[")) {
      inToolNx = trimmed === "[tool.nx]";
      continue;
    }

    if (!inToolNx) continue;
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Match: workspace-dependencies = ["proj-a", "proj-b"]
    const match = trimmed.match(/^workspace-dependencies\s*=\s*\[([^\]]*)\]/);
    if (!match) continue;

    const names = match[1].match(/"([^"]+)"/g);
    if (!names) continue;

    for (const quoted of names) {
      deps.push(quoted.replace(/"/g, ""));
    }
  }

  return deps;
}

/**
 * createDependencies - scans pixi.toml and pyproject.toml files across all
 * projects and creates graph edges from [tool.nx] workspace-dependencies.
 */
const createDependencies = (_options, context) => {
  const deps = [];
  const projectNames = new Set(Object.keys(context.projects));

  for (const [projectName, project] of Object.entries(context.projects)) {
    for (const manifest of MANIFEST_FILES) {
      const manifestPath = join(context.workspaceRoot, project.root, manifest);

      let content;
      try {
        content = readFileSync(manifestPath, "utf-8");
      } catch {
        continue;
      }

      for (const depName of parseWorkspaceDeps(content)) {
        if (projectNames.has(depName) && depName !== projectName) {
          deps.push({
            source: projectName,
            target: depName,
            type: "static",
            sourceFile: join(project.root, manifest),
          });
        }
      }
    }
  }

  return deps;
};

module.exports = { name, createDependencies };
