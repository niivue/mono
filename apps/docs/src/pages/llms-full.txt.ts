import type { APIRoute } from 'astro'
import { guideMarkdown, guidesInOrder } from '../lib/markdown'
import { docsUrl } from '../site'

// Every guide in reading order, each headed by its title, its page URL and
// its description, for agents that want the whole guide in one request.
export const GET: APIRoute = async ({ url }) => {
  const site = docsUrl(url)
  const pages = (await guidesInOrder()).map((entry) => {
    const [title, ...rest] = guideMarkdown(entry, site).split('\n')
    const source = new URL(`${entry.id}/`, site).href
    return [title, '', `Source: ${source}`, ...rest].join('\n')
  })
  return new Response(pages.join('\n---\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
