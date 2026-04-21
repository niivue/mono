import type { NiiVueOptions, NVImage } from '@niivue/niivue'
import NiiVueGPU, { SLICE_TYPE } from '@niivue/niivue'
import type { CSSProperties } from 'react'
import { useEffect, useRef } from 'react'
import { defaultViewerOptions } from './nvscene-controller'
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
  const nvRef = useRef<NiiVueGPU | null>(null)
  const loadedVolumesRef = useRef<Map<string, VolumeVisualProps>>(new Map())

  // Store latest callbacks in refs
  const onLocationChangeRef = useRef(onLocationChange)
  onLocationChangeRef.current = onLocationChange
  const onImageLoadedRef = useRef(onImageLoaded)
  onImageLoadedRef.current = onImageLoaded
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Initialize NiiVueGPU instance
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
      ...options,
    }

    const nv = new NiiVueGPU(mergedOptions)

    nv.addEventListener('locationChange', (evt) => {
      onLocationChangeRef.current?.(evt.detail)
    })
    nv.addEventListener('volumeLoaded', (evt) => {
      onImageLoadedRef.current?.(evt.detail.volume)
    })

    // attachToCanvas is async in the new API
    nv.attachToCanvas(canvas).then(() => {
      nv.sliceType = sliceType
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
  }, [sliceType, options]) // intentionally stable — options changes don't recreate the instance

  // Handle sliceType changes
  useEffect(() => {
    const nv = nvRef.current
    if (nv) {
      nv.sliceType = sliceType
    }
  }, [sliceType])

  // Handle volume diffing (add/remove/update visual props)
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
          nv.model.removeVolume(volIdx)
          nv.updateGLVolume()
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
          nv.setVolume(volIdx, updates)
        }

        currentVolumes.set(urlKey, next)
      }
    }
  }, [volumes])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', ...style }}
    />
  )
}
