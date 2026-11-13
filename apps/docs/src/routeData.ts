import { defineRouteMiddleware } from '@astrojs/starlight/route-data'
import { findGuide, markdownPath } from './lib/markdown'
import { withBase } from './site'

// llmstxt.org discovery links: every page points to the llms.txt that covers
// it, and each guide to its Markdown version.
export const onRequest = defineRouteMiddleware(async (context) => {
  const { head, id } = context.locals.starlightRoute
  head.push({
    tag: 'link',
    attrs: { rel: 'describedby', href: withBase('llms.txt') },
  })
  if (await findGuide(id)) {
    head.push({
      tag: 'link',
      attrs: {
        rel: 'alternate',
        type: 'text/markdown',
        href: withBase(markdownPath(id)),
      },
    })
  }
})
