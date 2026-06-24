import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { DesktopItem } from '../domain/desktop'
import { acquirePreviewSlot } from '../domain/previewLoadQueue'

export const SIDEBAR_PREVIEW_SIZE = 96
export const DESKTOP_PREVIEW_TIERS = [96, 192, 384, 768, 1024] as const
export const PREVIEW_TIER_SETTLE_MS = 180
const PREVIEW_IMAGE_VERSION = 5
const PREVIEW_LOAD_TIMEOUT_MS = 15000
const PREVIEW_RETAIN_ROOT_MARGIN = '1200px'

export function previewImageForSize(item: DesktopItem, size: number): string {
  if (!item.preview.service) return item.preview.image
  const level = previewLevelForSize(size, item)
  return `${item.preview.service}/full/${size},${size}/0/default.png?level=${level}&v=${PREVIEW_IMAGE_VERSION}`
}

export function previewLevelForSize(size: number, item?: DesktopItem): number {
  const requestedLevel = size <= 192 ? 2 : size <= 384 ? 1 : 0
  const availableLevels = item?.levels?.map((level) => level.level) ?? [0]
  const maxLevel = Math.max(0, ...availableLevels)
  return Math.min(requestedLevel, maxLevel)
}

export function StablePreviewImage({
  src,
  frameClassName,
  draggable
}: {
  src: string
  frameClassName: string
  draggable?: boolean
}): JSX.Element {
  // currentSrc is the committed, visible image; pendingSrc is the one we've been
  // granted a load slot for and are now fetching. Gating the fetch behind a slot
  // keeps a gridful of tiles from saturating the connection pool ahead of the
  // volume.
  const [currentSrc, setCurrentSrc] = useState<string | null>(null)
  const [pendingSrc, setPendingSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [nearViewport, setNearViewport] = useState(false)
  const frameRef = useRef<HTMLSpanElement>(null)
  const releaseRef = useRef<(() => void) | null>(null)

  function releaseSlot(): void {
    releaseRef.current?.()
    releaseRef.current = null
  }

  // Load previews near the viewport and unload them again once they are far
  // offscreen. The generous margin prevents scroll churn while bounding live
  // <img> count on very large datasets.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setNearViewport(entries.some((entry) => entry.isIntersecting))
      },
      { rootMargin: PREVIEW_RETAIN_ROOT_MARGIN }
    )
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!nearViewport) {
      releaseSlot()
      setCurrentSrc(null)
      setPendingSrc(null)
      setLoading(false)
      return
    }

    if (src === currentSrc) {
      releaseSlot()
      setPendingSrc(null)
      setLoading(false)
      return
    }

    // Drop the slot held by any now-stale pending load before queueing the new
    // one; replacing the <img> src cancels the in-flight request anyway.
    releaseSlot()
    setLoading(true)

    let cancelled = false
    void acquirePreviewSlot().then((release) => {
      if (cancelled) {
        release()
        return
      }
      releaseRef.current = release
      setPendingSrc(src)
    })

    return () => {
      cancelled = true
    }
  }, [nearViewport, currentSrc, src])

  // Release the slot if we unmount mid-load so it can never leak.
  useEffect(() => releaseSlot, [])

  // Safety valve: if a pending <img> never fires load or error, abandon it after
  // a timeout so its queue slot is freed instead of held indefinitely.
  useEffect(() => {
    if (!pendingSrc) return
    const timer = window.setTimeout(abandonPendingSrc, PREVIEW_LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [pendingSrc])

  function commitPendingSrc(): void {
    setCurrentSrc((previous) => (pendingSrc ? pendingSrc : previous))
    setPendingSrc(null)
    setLoading(false)
    releaseSlot()
  }

  function abandonPendingSrc(): void {
    setPendingSrc(null)
    setLoading(false)
    releaseSlot()
  }

  return (
    <span className={frameClassName} ref={frameRef}>
      {loading && !currentSrc ? (
        // Decorative only: a live region here would fire for every tile on a
        // grid load and spam assistive tech. The spinner is a visual hint.
        <span className="nv-preview-spinner" aria-hidden="true">
          <LoaderCircle size={18} />
        </span>
      ) : null}
      {currentSrc ? (
        <img
          className="nv-preview-image"
          src={currentSrc}
          alt=""
          draggable={draggable}
          loading="eager"
          decoding="async"
          fetchPriority="low"
        />
      ) : null}
      {pendingSrc ? (
        <img
          className="nv-preview-image is-pending"
          src={pendingSrc}
          alt=""
          draggable={draggable}
          loading="eager"
          decoding="async"
          fetchPriority="low"
          onLoad={commitPendingSrc}
          onError={abandonPendingSrc}
        />
      ) : null}
    </span>
  )
}
