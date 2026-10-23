import Link from '@docusaurus/Link'
import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import Layout from '@theme/Layout'
import styles from './index.module.css'

const topics = [
  {
    title: 'Volumes',
    text: 'NIfTI, MGH, NRRD, OME-Zarr and more (DICOM through an extension), with overlays, colormaps and atlases.',
    to: '/guide/loading',
  },
  {
    title: 'Meshes and tracts',
    text: 'Surfaces with per-vertex layers, connectomes and streamline tractography.',
    to: '/guide/meshes',
  },
  {
    title: 'Gallery',
    text: 'Every example page in the repository, live, with its code.',
    to: '/gallery',
  },
]

export default function Home() {
  const { siteConfig } = useDocusaurusContext()
  return (
    <Layout description={siteConfig.tagline}>
      <header className={styles.hero}>
        <div className="container">
          <h1>{siteConfig.title}</h1>
          <p className={styles.tagline}>{siteConfig.tagline}</p>
          <Link className="button button--primary button--lg" to="/guide">
            Get started
          </Link>
        </div>
      </header>
      <main className="container margin-vert--lg">
        <div className="row">
          {topics.map((t) => (
            <div key={t.title} className="col col--4 margin-bottom--md">
              <Link to={t.to} className={styles.topic}>
                <h2>{t.title}</h2>
                <p>{t.text}</p>
              </Link>
            </div>
          ))}
        </div>
      </main>
    </Layout>
  )
}
