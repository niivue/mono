import Link from '@docusaurus/Link'
import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import CodeBlock from '@theme/CodeBlock'
import Layout from '@theme/Layout'
import TabItem from '@theme/TabItem'
import Tabs from '@theme/Tabs'
import styles from './Gallery.module.css'

type Example = {
  slug: string
  title: string
  section: string
  summary: string
  page: string
  files: { name: string; code: string }[]
}

export default function GalleryExample({ example }: { example: Example }) {
  const { siteConfig } = useDocusaurusContext()
  const examplesBase = String(siteConfig.customFields?.examplesBase ?? '')
  const repoUrl = String(siteConfig.customFields?.repoUrl ?? '')
  const live = new URL(example.page, examplesBase).href
  const sourceDir = `${repoUrl}/blob/main/packages/niivue/examples`
  const source = `${sourceDir}/${example.page.replace(/^examples\//, '')}`

  return (
    <Layout
      title={example.title}
      description={example.summary || `NiiVue example: ${example.title}`}
    >
      <main className="container margin-vert--lg">
        <nav className={styles.crumbs} aria-label="Breadcrumb">
          <Link to="/gallery">Gallery</Link>
          <span aria-hidden="true">/</span>
          <span>{example.section}</span>
        </nav>
        <h1 className={styles.exampleTitle}>{example.title}</h1>
        {example.summary && (
          <p className={styles.exampleSummary}>{example.summary}</p>
        )}
        <div className={styles.window}>
          <div className={styles.windowBar}>
            <span className={styles.lights} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className={styles.windowUrl}>{example.page}</span>
            <a
              className={styles.windowButton}
              href={live}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open full page
            </a>
            <a
              className={styles.windowButton}
              href={source}
              target="_blank"
              rel="noopener noreferrer"
            >
              Source
            </a>
          </div>
          <iframe
            className={styles.frame}
            src={live}
            title={example.title}
            allow="fullscreen; clipboard-write"
            loading="lazy"
          />
        </div>
        <h2 className={styles.codeHeading}>Code</h2>
        {example.files.length === 1 && (
          <CodeBlock language="js" title={example.files[0].name}>
            {example.files[0].code}
          </CodeBlock>
        )}
        {example.files.length > 1 && (
          <Tabs>
            {example.files.map((f) => (
              <TabItem key={f.name} value={f.name} label={f.name}>
                <CodeBlock language="js" title={f.name}>
                  {f.code}
                </CodeBlock>
              </TabItem>
            ))}
          </Tabs>
        )}
      </main>
    </Layout>
  )
}
