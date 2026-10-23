import Link from '@docusaurus/Link'
import Layout from '@theme/Layout'
import { useMemo, useState } from 'react'
import styles from './Gallery.module.css'

export type GalleryCard = {
  slug: string
  title: string
  section: string
  summary: string
}

export default function GalleryIndex({
  index: { cards },
}: {
  index: { cards: GalleryCard[] }
}) {
  const [query, setQuery] = useState('')
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const groups = new Map<string, GalleryCard[]>()
    for (const card of cards) {
      const text = `${card.title} ${card.summary} ${card.section}`.toLowerCase()
      if (q && !q.split(/\s+/).every((t) => text.includes(t))) continue
      groups.set(card.section, [...(groups.get(card.section) ?? []), card])
    }
    return Array.from(groups)
  }, [cards, query])

  return (
    <Layout title="Gallery" description="NiiVue examples with their code">
      <main className="container margin-vert--lg">
        <h1>Gallery</h1>
        <p>
          Every example from <code>packages/niivue/examples</code>, live, with
          the code that runs it.
        </p>
        <input
          className={styles.search}
          type="search"
          placeholder="Filter examples"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {sections.map(([section, list]) => (
          <section key={section} className="margin-top--lg">
            <h2>{section}</h2>
            <div className={styles.grid}>
              {list.map((card) => (
                <Link
                  key={card.slug}
                  to={`/gallery/${card.slug}`}
                  className={styles.card}
                >
                  <strong>{card.title}</strong>
                  {card.summary && (
                    <span className={styles.summary}>{card.summary}</span>
                  )}
                </Link>
              ))}
            </div>
          </section>
        ))}
        {sections.length === 0 && <p>No examples match.</p>}
      </main>
    </Layout>
  )
}
