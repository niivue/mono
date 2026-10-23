import BrowserOnly from '@docusaurus/BrowserOnly'
import Link from '@docusaurus/Link'
import useBaseUrl from '@docusaurus/useBaseUrl'
import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import { usePluginData } from '@docusaurus/useGlobalData'
import CodeBlock from '@theme/CodeBlock'
import Layout from '@theme/Layout'
import { type ReactNode, useState } from 'react'
import type { GalleryCard } from '../components/GalleryIndex'
import HeroViewer from '../components/HeroViewer'
import styles from './index.module.css'

const INSTALL = 'npm install @niivue/niivue@next'

const FIRST_VIEWER = `import NiiVue from '@niivue/niivue'

const nv = new NiiVue()
await nv.attachToCanvas(document.getElementById('gl1'))
await nv.loadVolumes([{ url: './mni152.nii.gz' }])`

// 24px stroke icons, one or more paths each.
const ICONS: Record<string, string[]> = {
  volume: [
    'M12 3 3 7.5 12 12l9-4.5L12 3Z',
    'M3 12l9 4.5 9-4.5',
    'M3 16.5 12 21l9-4.5',
  ],
  mesh: [
    'M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z',
    'M12 12 4 7.5M12 12l8-4.5M12 12v9',
  ],
  tracts: ['M3 8c4 0 5 8 9 8s5-8 9-8', 'M3 16c4 0 5-8 9-8s5 8 9 8'],
  overlay: [
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
    'M12 3a9 9 0 0 1 0 18',
    'M12 8a4 4 0 1 0 0 8',
  ],
  draw: ['M4 20l4-1 11-11-3-3L5 16l-1 4Z', 'M14 6l3 3'],
  sync: ['M7 7h10l-3-3', 'M17 17H7l3 3'],
  react: [
    'M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
    'M12 7.5c5 0 9 2 9 4.5s-4 4.5-9 4.5-9-2-9-4.5 4-4.5 9-4.5Z',
    'M8.1 9.75c2.5-4.3 6.2-6.8 8.4-5.6 2.2 1.3 1.9 5.8-.6 10.1s-6.2 6.8-8.4 5.6c-2.2-1.3-1.9-5.8.6-10.1Z',
  ],
  extend: [
    'M10 4h4v3a2 2 0 1 1 0 4h3v4h-3a2 2 0 1 0-4 0H6v-4h3a2 2 0 1 0 0-4H6V4h4Z',
  ],
}

function Icon({ name }: { name: string }) {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(ICONS[name] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

const FEATURES = [
  {
    icon: 'volume',
    title: 'Volumes',
    text: 'NIfTI, MGH, NRRD, OME-Zarr and more, as slices or ray-marched in 3D. DICOM through an extension.',
    to: '/guide/loading',
  },
  {
    icon: 'overlay',
    title: 'Overlays and colormaps',
    text: 'Stack statistical maps on anatomy with thresholds, blend modes and dozens of colormaps.',
    to: '/guide/overlays',
  },
  {
    icon: 'mesh',
    title: 'Meshes',
    text: 'Cortical surfaces with per-vertex layers, curvature and matcap shaders.',
    to: '/guide/meshes',
  },
  {
    icon: 'tracts',
    title: 'Tracts and connectomes',
    text: 'Streamline tractography and node-and-edge connectomes in the same scene.',
    to: '/guide/tracts',
  },
  {
    icon: 'draw',
    title: 'Drawing',
    text: 'Paint, erase and fill segmentations right on the slices, with undo.',
    to: '/guide/drawing',
  },
  {
    icon: 'sync',
    title: 'Linked viewers',
    text: 'Share the crosshair, zoom and 3D camera across any number of canvases.',
    to: '/guide/sync',
  },
  {
    icon: 'react',
    title: 'React',
    text: 'Components and hooks from @niivue/nvreact.',
    to: '/guide/react',
  },
  {
    icon: 'extend',
    title: 'Extensions',
    text: 'DICOM, image processing and custom tools from separate packages.',
    to: '/guide/extensions',
  },
]

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div className={styles.install}>
      <span className={styles.prompt} aria-hidden="true">
        $
      </span>
      <code>{text}</code>
      <button type="button" className={styles.copy} onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function Hero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroGrid} aria-hidden="true" />
      <div className={`container ${styles.heroInner}`}>
        <div className={styles.heroText}>
          <span className={styles.eyebrow}>
            <span className={styles.dot} />
            WebGPU and WebGL2
          </span>
          <h1 className={styles.title}>
            Medical images,{' '}
            <span className="nv-gradient-text">live in the browser.</span>
          </h1>
          <p className={styles.lead}>
            NiiVue renders MRI, CT, microscopy, surfaces and tractography on the
            GPU. No plugins and no special server: give it a canvas and a URL.
          </p>
          <div className={styles.ctas}>
            <Link className={styles.primary} to="/guide">
              Get started
            </Link>
            <Link className={styles.secondary} to="/gallery">
              Browse the gallery
            </Link>
          </div>
          <CopyCommand text={INSTALL} />
        </div>
        <div className={styles.heroViewer}>
          <BrowserOnly fallback={<div className={styles.viewerFallback} />}>
            {() => <HeroViewer />}
          </BrowserOnly>
        </div>
      </div>
    </header>
  )
}

function Section({
  kicker,
  title,
  children,
  className = '',
}: {
  kicker: string
  title: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`${styles.section} ${className}`}>
      <div className="container">
        <span className={styles.kicker}>{kicker}</span>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {children}
      </div>
    </section>
  )
}

function Features() {
  return (
    <Section kicker="What it does" title="One viewer, many kinds of data">
      <div className={styles.features}>
        {FEATURES.map((f) => (
          <Link key={f.title} to={f.to} className={styles.feature}>
            <Icon name={f.icon} />
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </Link>
        ))}
      </div>
    </Section>
  )
}

function Code() {
  return (
    <Section
      kicker="A few lines"
      title="From canvas to viewer"
      className={styles.alt}
    >
      <div className={styles.codeRow}>
        <div className={styles.codeText}>
          <p>
            Attach a viewer to a canvas and hand it the images. NiiVue uses
            WebGPU when the browser has it and falls back to WebGL2.
          </p>
          <ul className={styles.checks}>
            <li>Mouse, touch and drag and drop built in</li>
            <li>Settings are plain properties</li>
            <li>Save and restore the whole scene as JSON</li>
          </ul>
          <Link to="/guide" className={styles.textLink}>
            Read the guide
          </Link>
        </div>
        <div className={styles.codeBlock}>
          <CodeBlock language="ts" title="main.ts">
            {FIRST_VIEWER}
          </CodeBlock>
        </div>
      </div>
    </Section>
  )
}

function StripCard({ card }: { card: GalleryCard }) {
  const src = useBaseUrl(card.image)
  return (
    <Link to={`/gallery/${card.slug}`} className={styles.stripCard}>
      <img src={src} alt="" loading="lazy" />
      <span>{card.title}</span>
    </Link>
  )
}

// Hand-picked for variety; any that lose their thumbnail drop out.
const STRIP = [
  'vox-clip',
  'mesh-layers',
  'tract-group',
  'slide3d',
  'vox-tissues',
  'mesh-atlas',
  'vox-torso',
  'vox-draw-explode',
]

function GalleryStrip() {
  const { cards } = usePluginData('niivue-gallery') as {
    cards: GalleryCard[]
  }
  const bySlug = new Map(cards.map((c) => [c.slug, c]))
  const picked = STRIP.map((s) => bySlug.get(s)).filter(
    (c): c is GalleryCard => !!c?.image,
  )
  const picks =
    picked.length >= 4 ? picked : cards.filter((c) => c.image).slice(0, 8)
  return (
    <Section
      kicker="Gallery"
      title={`${cards.length} live examples, with code`}
    >
      <div className={styles.strip}>
        {picks.map((c) => (
          <StripCard key={c.slug} card={c} />
        ))}
      </div>
      <div className={styles.stripMore}>
        <Link className={styles.outline} to="/gallery">
          See every example
        </Link>
      </div>
    </Section>
  )
}

function Closing() {
  return (
    <section className={styles.closing}>
      <div className="container">
        <h2>
          Open source, <span className="nv-gradient-text">BSD licensed.</span>
        </h2>
        <p>Issues, ideas and pull requests are welcome.</p>
        <div className={styles.ctas}>
          <Link className={styles.primary} to="/guide">
            Get started
          </Link>
          <Link
            className={styles.secondary}
            href="https://github.com/niivue/mono"
          >
            View on GitHub
          </Link>
        </div>
      </div>
    </section>
  )
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext()
  return (
    <Layout description={siteConfig.tagline}>
      <Hero />
      <main>
        <Features />
        <Code />
        <GalleryStrip />
        <Closing />
      </main>
    </Layout>
  )
}
