import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import type NiiVue from '@niivue/niivue'
import CodeBlock from '@theme/CodeBlock'
import { useEffect, useRef, useState } from 'react'
import type { Demo as DemoFn } from '../demos/types'
import { DemoUI } from '../demos/ui'
import styles from './Demo.module.css'

type Props = {
  /** `() => import('@site/src/demos/<name>')`, so NiiVue only loads in the browser. */
  load: () => Promise<{ default: DemoFn }>
  /** The same file through `!!raw-loader!`, shown under the canvas. */
  source: string
  /** Canvas height in pixels. */
  height?: number
  /** Number of side-by-side canvases (for sync demos). */
  canvases?: number
  /** Title of the code block. */
  file?: string
}

// Drop the docs-only type import and annotation so the shown code reads like
// plain NiiVue usage.
function displaySource(source: string): string {
  return source
    .replace(/^import type \{ Demo \} from '\.\/types'\n/m, '')
    .replace(/^const demo: Demo = /m, 'const demo = ')
    .trim()
}

export default function Demo({
  load,
  source,
  height = 420,
  canvases = 1,
  file,
}: Props) {
  const { siteConfig } = useDocusaurusContext()
  const examplesBase = String(siteConfig.customFields?.examplesBase ?? '')
  const barRef = useRef<HTMLDivElement>(null)
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const [error, setError] = useState<string | null>(null)
  // MDX passes a fresh arrow each render; run the demo once per mount.
  const loadRef = useRef(load)

  useEffect(() => {
    const bar = barRef.current
    const list = canvasRefs.current
      .slice(0, canvases)
      .filter((c): c is HTMLCanvasElement => c !== null)
    if (!bar || list.length === 0) return
    let cancelled = false
    let viewers: NiiVue[] = []
    const ui = new DemoUI(bar)
    const asset = (path: string) => new URL(path, examplesBase).href
    loadRef
      .current()
      .then(async (mod) => {
        if (cancelled) return
        const result = await mod.default(list[0], { ui, asset, canvases: list })
        viewers = Array.isArray(result) ? result : [result]
        if (cancelled) for (const nv of viewers) nv.destroy()
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      for (const nv of viewers) nv.destroy()
      ui.dispose()
    }
  }, [canvases, examplesBase])

  return (
    <div className={styles.demo}>
      <div className={styles.viewer}>
        <div ref={barRef} className={styles.bar} />
        <div className={styles.canvases} style={{ height }}>
          {Array.from({ length: canvases }, (_, i) => (
            <canvas
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length list
              key={i}
              ref={(el) => {
                canvasRefs.current[i] = el
              }}
              className={styles.canvas}
            />
          ))}
        </div>
      </div>
      {error && <p className={styles.error}>Demo failed: {error}</p>}
      <CodeBlock language="ts" title={file}>
        {displaySource(source)}
      </CodeBlock>
    </div>
  )
}
