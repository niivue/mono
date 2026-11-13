import { type CollectionEntry, getCollection } from 'astro:content'
import type { APIRoute, GetStaticPaths } from 'astro'
import { guideMarkdown } from '../../lib/markdown'
import { docsUrl } from '../../site'

// /guide/loading/index.md: the Markdown version of /guide/loading/.

type Props = { entry: CollectionEntry<'docs'> }

export const getStaticPaths = (async () =>
  (await getCollection('docs')).map((entry) => ({
    params: { slug: entry.id },
    props: { entry },
  }))) satisfies GetStaticPaths

export const GET: APIRoute<Props> = ({ props, url }) =>
  new Response(guideMarkdown(props.entry, docsUrl(url)), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
