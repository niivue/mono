import type { Plugin } from '@docusaurus/types'

// @niivue/niivue is a workspace link to packages/niivue. With webpack's default
// symlink resolution its dist resolves outside node_modules, so Docusaurus's
// Babel loader transpiles the already-built library and breaks it (array
// spread of typed arrays becomes `.concat`). Keeping the link path leaves the
// dist under node_modules, which the loader skips.
export default function niivueWebpackPlugin(): Plugin {
  return {
    name: 'niivue-webpack',
    configureWebpack() {
      return { resolve: { symlinks: false } }
    },
  }
}
