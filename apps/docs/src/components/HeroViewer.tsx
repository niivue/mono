import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import type NiiVue from '@niivue/niivue'
import { useEffect, useRef, useState } from 'react'
import styles from './HeroViewer.module.css'

// One hemisphere only reads well from the side, so the idle motion sways
// around the starting (lateral) view rather than spinning. Dragging takes
// over, and the sway resumes around wherever the user left it.
const SWAY_DEG = 30
const SWAY_PERIOD_S = 14

/** The home page's live render: a cortical surface with a motor-task layer. */
export default function HeroViewer() {
  const { siteConfig } = useDocusaurusContext()
  const examplesBase = String(siteConfig.customFields?.examplesBase ?? '')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let nv: NiiVue | null = null
    let frame = 0
    let dragging = false
    const asset = (p: string) => new URL(p, examplesBase).href
    const down = () => {
      dragging = true
    }
    const up = () => {
      dragging = false
    }
    // The wheel scrolls the page, not the camera: stop it at the canvas's
    // parent before it reaches NiiVue's zoom handler.
    const wheel = (e: WheelEvent) => e.stopPropagation()
    const parent = canvas.parentElement
    canvas.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    parent?.addEventListener('wheel', wheel, { capture: true, passive: true })

    import('./heroScene')
      .then(async ({ createHeroScene }) => {
        if (cancelled) return
        const viewer = await createHeroScene(canvas, asset)
        nv = viewer
        if (cancelled) {
          viewer.destroy()
          return
        }
        setReady(true)
        const reduce = window.matchMedia(
          '(prefers-reduced-motion: reduce)',
        ).matches
        if (reduce) return
        let center = viewer.azimuth
        let phase = 0
        let last = performance.now()
        const tick = (now: number) => {
          const dt = Math.min((now - last) / 1000, 0.1)
          last = now
          if (dragging) {
            center = viewer.azimuth
            phase = 0
          } else if (!document.hidden) {
            phase += (2 * Math.PI * dt) / SWAY_PERIOD_S
            viewer.azimuth = center + SWAY_DEG * Math.sin(phase)
          }
          frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
      })
      .catch(() => {
        // The hero is decoration; the page reads fine without it.
      })

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      canvas.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      parent?.removeEventListener('wheel', wheel, { capture: true })
      nv?.destroy()
    }
  }, [examplesBase])

  return (
    <div className={styles.frame}>
      <div className={styles.glow} aria-hidden="true" />
      <canvas
        ref={canvasRef}
        className={`${styles.canvas} ${ready ? styles.ready : ''}`}
        aria-label="Live NiiVue render of a cortical surface. Drag to rotate."
      />
      <span className={styles.caption}>Live render. Drag to rotate.</span>
    </div>
  )
}
