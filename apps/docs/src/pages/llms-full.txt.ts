import type { APIRoute } from 'astro'
import {
  guideMarkdown,
  guidesInOrder,
  type PackageDocs,
  packagePageTitle,
  packagesInOrder,
} from '../lib/markdown'
import { docsUrl } from '../site'

// Every guide in reading order, then every package's pages, each headed by
// its title, its page URL and its description, for agents that want all the
// docs in one request.
export const GET: APIRoute = async ({ url }) => {
  const site = docsUrl(url)
  const page = (
    entry: Awaited<ReturnType<typeof guidesInOrder>>[number],
    pkg?: PackageDocs,
  ) => {
    const [, ...rest] = guideMarkdown(entry, site).split('\n')
    const title = pkg ? packagePageTitle(pkg, entry) : entry.data.title
    const source = new URL(`${entry.id}/`, site).href
    return [`# ${title}`, '', `Source: ${source}`, ...rest].join('\n')
  }
  const pages = [
    ...(await guidesInOrder()).map((entry) => page(entry)),
    ...(await packagesInOrder()).flatMap((pkg) =>
      pkg.pages.map((entry) => page(entry, pkg)),
    ),
  ]
  return new Response(pages.join('\n---\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
