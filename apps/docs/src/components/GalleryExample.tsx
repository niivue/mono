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

  return (
    <Layout
      title={example.title}
      description={example.summary || `NiiVue example: ${example.title}`}
    >
      <main className="container margin-vert--lg">
        <p>
          <Link to="/gallery">Gallery</Link> / {example.section}
        </p>
        <h1>{example.title}</h1>
        {example.summary && <p>{example.summary}</p>}
        <iframe
          className={styles.frame}
          src={live}
          title={example.title}
          allow="fullscreen; clipboard-write"
          loading="lazy"
        />
        <p className={styles.links}>
          <a href={live} target="_blank" rel="noopener noreferrer">
            Open full page
          </a>
          <a
            href={`${sourceDir}/${example.page.replace(/^examples\//, '')}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Source on GitHub
          </a>
        </p>
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
