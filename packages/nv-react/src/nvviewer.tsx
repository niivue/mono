import type { NiiVueOptions, NVImage } from '@niivue/niivue'
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { CSSProperties } from 'react'
import { useEffect, useRef } from 'react'
import { defaultViewerOptions } from './nvscene-controller'
import type { OptionValues } from './nvviewer-options'
import { applyLiveOptions, signature, splitOptions } from './nvviewer-options'
import type { ImageFromUrlOptions } from './types'

/** Tracked visual properties for a loaded volume */
interface VolumeVisualProps {
  colormap?: string
  calMin?: number
  calMax?: number
  opacity?: number
}

/** Extract the diffable visual properties from volume options */
function extractVisualProps(opts: ImageFromUrlOptions): VolumeVisualProps {
  return {
    colormap: opts.colormap,
    calMin: opts.calMin,
    calMax: opts.calMax,
    opacity: opts.opacity,
  }
}

export interface NvViewerProps {
  volumes?: ImageFromUrlOptions[]
  options?: Partial<NiiVueOptions>
  sliceType?: number
  className?: string
  style?: CSSProperties
  onLocationChange?: (data: unknown) => void
  onImageLoaded?: (volume: NVImage) => void
  onError?: (error: unknown) => void
}

export const NvViewer = ({
  volumes,
  options,
  sliceType = SLICE_TYPE.AXIAL,
  className,
  style,
  onLocationChange,
  onImageLoaded,
  onError,
}: NvViewerProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const nvRef = useRef<NiiVue | null>(null)
  const loadedVolumesRef = useRef<Map<string, VolumeVisualProps>>(new Map())

  // Store latest callbacks in refs
  const onLocationChangeRef = useRef(onLocationChange)
  onLocationChangeRef.current = onLocationChange
  const onImageLoadedRef = useRef(onImageLoaded)
  onImageLoadedRef.current = onImageLoaded
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const sliceTypeRef = useRef(sliceType)
  sliceTypeRef.current = sliceType

  // Effects key on option values, not identity, so an inline object is free.
  const optionsRef = useRef(options)
  optionsRef.current = options
  const { live, construction } = splitOptions(NiiVue.prototype, options)
  const liveRef = useRef(live)
  liveRef.current = live
  const constructionRef = useRef(construction)
  constructionRef.current = construction
  const liveKey = signature(live)
  const constructionKey = signature(construction)
  const appliedRef = useRef<OptionValues>({})

  // Initialize NiiVue instance; recreated only when a construction-only option changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: constructionKey is the trigger
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const canvas = document.createElement('canvas')
    canvas.className = 'niivue-canvas'
    canvas.style.position = 'absolute'
    canvas.style.top = '0'
    canvas.style.left = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    const mergedOptions: Partial<NiiVueOptions> = {
      ...defaultViewerOptions,
      ...optionsRef.current,
    }

    const nv = new NiiVue(mergedOptions)
    appliedRef.current = liveRef.current

    // A load still in flight when this viewer is replaced settles late; only
    // the current viewer reports.
    nv.addEventListener('locationChange', (evt) => {
      if (nvRef.current === nv) onLocationChangeRef.current?.(evt.detail)
    })
    nv.addEventListener('volumeLoaded', (evt) => {
      if (nvRef.current === nv) onImageLoadedRef.current?.(evt.detail.volume)
    })

    // attachToCanvas is async in the new API
    nv.attachToCanvas(canvas).then(() => {
      nv.sliceType = sliceTypeRef.current
    })
    nvRef.current = nv

    const ro = new ResizeObserver(() => {
      nv.resize()
    })
    ro.observe(container)

    return () => {
      ro.disconnect()
      nv.destroy()
      canvas.width = 0
      canvas.height = 0
      canvas.remove()
      nvRef.current = null
      loadedVolumesRef.current.clear()
    }
  }, [constructionKey])

  // Apply live option changes to the existing instance
  // biome-ignore lint/correctness/useExhaustiveDependencies: liveKey is the trigger
  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    applyLiveOptions(
      nv,
      appliedRef.current,
      liveRef.current,
      (err) => onErrorRef.current?.(err),
      constructionRef.current,
    )
    appliedRef.current = liveRef.current
  }, [liveKey])

  // Handle sliceType changes
  useEffect(() => {
    const nv = nvRef.current
    if (nv) {
      nv.sliceType = sliceType
    }
  }, [sliceType])

  // Handle volume diffing (add/remove/update visual props); a recreated viewer reloads them
  // biome-ignore lint/correctness/useExhaustiveDependencies: constructionKey marks a new instance
  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return

    const desiredUrls = new Set(
      (volumes ?? []).map((v) =>
        typeof v.url === 'string' ? v.url : v.url.name,
      ),
    )
    const currentVolumes = loadedVolumesRef.current

    // Remove volumes no longer in the list
    for (const url of currentVolumes.keys()) {
      if (!desiredUrls.has(url)) {
        const volIdx = nv.volumes.findIndex(
          (v: NVImage) => v.url === url || v.name === url,
        )
        if (volIdx >= 0) {
          nv.removeVolume(volIdx).catch((err: unknown) => {
            onErrorRef.current?.(err)
          })
        }
        currentVolumes.delete(url)
      }
    }

    for (const opts of volumes ?? []) {
      const urlKey = typeof opts.url === 'string' ? opts.url : opts.url.name
      if (!currentVolumes.has(urlKey)) {
        // Add new volumes
        const props = extractVisualProps(opts)
        currentVolumes.set(urlKey, props)
        nv.addVolume(opts).catch((err: unknown) => {
          // A rebuilt viewer owns the map now; a late failure from the old
          // one must not drop the new viewer's entry or report.
          if (nvRef.current !== nv) return
          currentVolumes.delete(urlKey)
          onErrorRef.current?.(err)
        })
      } else {
        // Update visual props on already-loaded volumes
        const prev = currentVolumes.get(urlKey) as VolumeVisualProps
        const next = extractVisualProps(opts)

        const volIdx = nv.volumes.findIndex(
          (v: NVImage) => v.url === urlKey || v.name === urlKey,
        )
        if (volIdx < 0) continue

        const updates: Record<string, unknown> = {}
        if (next.colormap !== undefined && next.colormap !== prev.colormap) {
          updates.colormap = next.colormap
        }
        if (next.calMin !== undefined && next.calMin !== prev.calMin) {
          updates.calMin = next.calMin
        }
        if (next.calMax !== undefined && next.calMax !== prev.calMax) {
          updates.calMax = next.calMax
        }
        if (next.opacity !== undefined && next.opacity !== prev.opacity) {
          updates.opacity = next.opacity
        }

        if (Object.keys(updates).length > 0) {
          // A queued GPU update can reject (#467).
          nv.setVolume(volIdx, updates).catch((err: unknown) => {
            onErrorRef.current?.(err)
          })
        }

        currentVolumes.set(urlKey, next)
      }
    }
  }, [volumes, constructionKey])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', ...style }}
    />
  )
}
