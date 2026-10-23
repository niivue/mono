import path from 'node:path'
import type { LoadContext, Plugin } from '@docusaurus/types'
import {
  buildGraph,
  collectGallery,
  EXAMPLES_DIR,
  type GalleryExample,
} from './gallery'

// Adds /gallery (a card per example) and /gallery/<slug> (the live example
// plus its code). Content is regenerated from the knowledge graph on every
// build and when an example changes under `docusaurus start`.
export default function galleryPlugin(
  context: LoadContext,
): Plugin<GalleryExample[]> {
  const repoRoot = path.resolve(context.siteDir, '../..')
  return {
    name: 'niivue-gallery',
    getPathsToWatch() {
      return [path.join(repoRoot, EXAMPLES_DIR, '*.{html,js}')]
    },
    async loadContent() {
      return collectGallery(repoRoot, buildGraph(repoRoot))
    },
    async contentLoaded({ content, actions }) {
      const { createData, addRoute } = actions
      const base = context.baseUrl
      const cards = content.map(({ slug, title, section, summary }) => ({
        slug,
        title,
        section,
        summary,
      }))
      // Route modules must be objects; a bare JSON array does not reach props.
      const cardsPath = await createData('gallery-cards.json', { cards })
      addRoute({
        path: `${base}gallery`,
        component: '@site/src/components/GalleryIndex',
        modules: { index: cardsPath },
        exact: true,
      })
      for (const example of content) {
        const examplePath = await createData(
          `gallery-${example.slug}.json`,
          example,
        )
        addRoute({
          path: `${base}gallery/${example.slug}`,
          component: '@site/src/components/GalleryExample',
          modules: { example: examplePath },
          exact: true,
        })
      }
    },
  }
}
