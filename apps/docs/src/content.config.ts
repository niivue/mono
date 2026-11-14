import { defineCollection } from 'astro:content'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { docsSchema } from '@astrojs/starlight/schema'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'
import {
  buildGraph,
  collectGallery,
  EXAMPLES_DIR,
  PAGES_INDEX,
} from './lib/gallery'
import { docsId } from './lib/packageDocs'

// One entry per page in packages/niivue/examples and per demo app on the
// Pages index, rebuilt in dev whenever an example, the Pages index, a listed
// app's page or source, or a thumbnail is added, changed or removed.
const gallery = defineCollection({
  loader: {
    name: 'niivue-gallery',
    async load({ config, store, parseData, watcher, logger }) {
      const siteDir = fileURLToPath(config.root)
      const repoRoot = path.resolve(siteDir, '../..')
      const examplesDir = path.join(repoRoot, EXAMPLES_DIR)
      const pagesIndex = path.join(repoRoot, PAGES_INDEX)
      const thumbsDir = path.join(siteDir, 'public/img/gallery')
      const watched = [examplesDir, pagesIndex, thumbsDir]
      const sync = async () => {
        const examples = collectGallery(repoRoot, buildGraph(repoRoot))
        // Each listed demo app's page and src/, whose script the gallery
        // shows: under apps/, or a package's own demo pages (packages/uikit/).
        // The examples folder is watched whole above.
        for (const { source } of examples) {
          if (source.startsWith(EXAMPLES_DIR)) continue
          for (const p of [source, path.join(path.dirname(source), 'src')]) {
            const abs = path.join(repoRoot, p)
            if (!watched.includes(abs)) {
              watched.push(abs)
              watcher?.add(abs)
            }
          }
        }
        store.clear()
        for (const [order, example] of examples.entries()) {
          // Thumbnails come from `bunx nx screenshots docs-site`; a card
          // without one shows only its text.
          const image = `img/gallery/${example.slug}.webp`
          const data = await parseData({
            id: example.slug,
            data: {
              ...example,
              order,
              image: existsSync(path.join(siteDir, 'public', image))
                ? image
                : '',
            },
          })
          store.set({ id: example.slug, data })
        }
      }
      // A failure here fails the build; in dev a later reload only logs, so
      // a half-written example does not stop the server.
      await sync()
      watcher?.add(watched)
      watcher?.on('all', async (_event, changed) => {
        if (!watched.some((w) => changed.startsWith(w))) return
        logger.info('Reloading gallery')
        try {
          await sync()
        } catch (e) {
          logger.error(`Gallery reload failed: ${e}`)
        }
      })
    },
  },
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    section: z.string(),
    summary: z.string(),
    page: z.string(),
    source: z.string(),
    files: z.array(z.object({ name: z.string(), code: z.string() })),
    order: z.number(),
    image: z.string(),
  }),
})

// Each package keeps its pages in packages/<dir>/docs (see docsId for the
// URLs they get). Files starting with _ are left out, as Starlight does.
const docs = defineCollection({
  loader: glob({
    base: '../../packages',
    pattern: '*/docs/**/[^_]*.{md,mdx}',
    generateId: ({ entry, data }) =>
      typeof data.slug === 'string' ? data.slug : docsId(entry),
  }),
  schema: docsSchema(),
})

export const collections = {
  docs,
  gallery,
}
