import Link from '@docusaurus/Link'
import useBaseUrl from '@docusaurus/useBaseUrl'
import Layout from '@theme/Layout'
import { useMemo, useState } from 'react'
import styles from './Gallery.module.css'

export type GalleryCard = {
  slug: string
  title: string
  section: string
  summary: string
  /** Thumbnail path under static/, or '' when none was captured. */
  image: string
}

const ALL = 'All'

export default function GalleryIndex({
  index: { cards },
}: {
  index: { cards: GalleryCard[] }
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(ALL)
  const sectionNames = useMemo(
    () => Array.from(new Set(cards.map((c) => c.section))),
    [cards],
  )
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const groups = new Map<string, GalleryCard[]>()
    for (const card of cards) {
      if (active !== ALL && card.section !== active) continue
      const text = `${card.title} ${card.summary} ${card.section}`.toLowerCase()
      if (q && !q.split(/\s+/).every((t) => text.includes(t))) continue
      groups.set(card.section, [...(groups.get(card.section) ?? []), card])
    }
    return Array.from(groups)
  }, [cards, query, active])
  const shown = sections.reduce((n, [, list]) => n + list.length, 0)

  return (
    <Layout title="Gallery" description="NiiVue examples with their code">
      <header className={styles.header}>
        <div className="container">
          <span className={styles.kicker}>Gallery</span>
          <h1>Every example, live</h1>
          <p>
            All {cards.length} pages from <code>packages/niivue/examples</code>,
            each running in the browser next to the code that drives it.
          </p>
          <div className={styles.toolbar}>
            <input
              className={styles.search}
              type="search"
              placeholder="Search examples"
              aria-label="Search examples"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <fieldset className={styles.chips}>
              <legend className={styles.legend}>Section</legend>
              {[ALL, ...sectionNames].map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`${styles.chip} ${active === name ? styles.chipActive : ''}`}
                  aria-pressed={active === name}
                  onClick={() => setActive(name)}
                >
                  {name}
                </button>
              ))}
            </fieldset>
          </div>
        </div>
      </header>
      <main className="container margin-bottom--xl">
        {(query || active !== ALL) && (
          <p className={styles.count}>
            {shown} of {cards.length} examples
          </p>
        )}
        {sections.map(([section, list]) => (
          <section key={section} className={styles.group}>
            <h2>
              {section} <span className={styles.groupCount}>{list.length}</span>
            </h2>
            <div className={styles.grid}>
              {list.map((card) => (
                <Link
                  key={card.slug}
                  to={`/gallery/${card.slug}`}
                  className={styles.card}
                >
                  <Thumb image={card.image} />
                  <span className={styles.cardBody}>
                    <strong>{card.title}</strong>
                    {card.summary && (
                      <span className={styles.summary}>{card.summary}</span>
                    )}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
        {sections.length === 0 && (
          <p className={styles.empty}>No examples match.</p>
        )}
      </main>
    </Layout>
  )
}

function Thumb({ image }: { image: string }) {
  const src = useBaseUrl(image)
  return (
    <span className={styles.thumb}>
      {image && <img src={src} alt="" loading="lazy" />}
    </span>
  )
}
