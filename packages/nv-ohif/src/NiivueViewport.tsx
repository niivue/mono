import type { NiiVueOptions } from '@niivue/niivue'
import NiiVueGPU, { DRAG_MODE, SLICE_TYPE } from '@niivue/niivue'
import { useEffect, useRef, useState } from 'react'
import { classifyDisplaySet } from './classifyDisplaySet'
import { convertDisplaySetToNifti } from './dicomToNiivue'
import { displaySetToNiivue } from './displaySetToNiivue'
import type {
  OhifDisplaySet,
  OhifServicesManager,
  OhifViewportProps,
} from './ohif-types'

// Default NiiVue config for the OHIF viewport. Opens multiplanar (set after attach)
// so an OHIF user sees the three orthogonal planes; the toolbar (later) can switch to
// 3D render etc.
const DEFAULT_OPTIONS: Partial<NiiVueOptions> = {
  backgroundColor: [0, 0, 0, 1],
  // WebGL2 is the robust default for an embedded viewport (broad support; avoids
  // WebGPU device churn when OHIF mounts/unmounts viewports). Revisit once WebGPU
  // multi-instance handling is proven in-app.
  backend: 'webgl2',
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'note'; message: string }
  | { kind: 'error'; message: string }

// OHIF's toolbar tools operate on cornerstone viewports; our NiiVue viewport isn't in
// a cornerstone tool group. Instead we mirror OHIF's active primary mouse tool onto
// NiiVue's left-drag behaviour, so picking Window/Level, Pan, etc. in the toolbar
// controls the NiiVue viewport too.
interface ToolGroupServiceLike {
  getActivePrimaryMouseButtonTool?: (toolGroupId: string) => string | undefined
  subscribe?: (event: string, cb: () => void) => { unsubscribe?: () => void }
  EVENTS?: Record<string, string>
}

// OHIF exposes its services on the viewport props in some builds and only on
// `window.services` in others (e.g. the current 3.x app), so read from either.
function ohifServices(
  servicesManager: OhifServicesManager | undefined,
): Record<string, unknown> | undefined {
  if (servicesManager?.services) return servicesManager.services
  const g = globalThis as unknown as { services?: Record<string, unknown> }
  return g.services
}

/** Map an OHIF primary tool name to a NiiVue left-drag mode. */
function ohifToolToDragMode(tool: string | undefined): number {
  switch (tool) {
    case 'WindowLevel':
      return DRAG_MODE.contrast
    case 'Pan':
      return DRAG_MODE.pan
    default:
      // Crosshairs / StackScroll / Zoom / anything else: crosshair navigation
      // (NiiVue changes slices with the scroll wheel regardless).
      return DRAG_MODE.crosshair
  }
}

// Pull a DICOMweb Authorization header out of OHIF's auth service, if present, so
// instance retrieval works against secured data sources.
function authHeaders(
  servicesManager: OhifServicesManager | undefined,
): Record<string, string> {
  const svc = ohifServices(servicesManager)?.userAuthenticationService as
    | { getAuthorizationHeader?: () => { Authorization?: string } | undefined }
    | undefined
  const header = svc?.getAuthorizationHeader?.()
  return header?.Authorization ? { Authorization: header.Authorization } : {}
}

/**
 * The NiiVue viewport React component OHIF hangs a display set in. It routes each
 * display set to the right NiiVue load path (see {@link classifyDisplaySet}):
 *   - a NIfTI/volume URL loads directly,
 *   - a volumetric DICOM series is fetched + converted with dcm2niix, then loaded,
 *   - whole-slide (SM) series are destined for NVSlide (not yet wired),
 *   - anything else shows an explanatory note.
 *
 * NiiVue's core is framework-agnostic, so this owns a plain <canvas> + a `NiiVueGPU`
 * instance directly (React 18) rather than depending on `@niivue/nvreact` (React 19).
 */
export function NiivueViewport(props: OhifViewportProps) {
  const { displaySets, viewportId, servicesManager } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nvRef = useRef<NiiVueGPU | null>(null)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  // Create / tear down the NiiVue instance with the canvas.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    const canvas = document.createElement('canvas')
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%'
    container.appendChild(canvas)

    const nv = new NiiVueGPU(DEFAULT_OPTIONS)
    nvRef.current = nv
    // Only mark ready once attach resolves — loading before that races the GPU
    // context (and StrictMode double-mounts), which left the volume unloaded.
    nv.attachToCanvas(canvas).then(() => {
      if (disposed) return
      nv.sliceType = SLICE_TYPE.MULTIPLANAR
      setReady(true)
    })

    const ro = new ResizeObserver(() => nv.resize())
    ro.observe(container)

    return () => {
      disposed = true
      setReady(false)
      ro.disconnect()
      nv.destroy()
      canvas.width = 0
      canvas.height = 0
      canvas.remove()
      nvRef.current = null
    }
  }, [])

  // Load the display set(s) hung in this viewport, once attached / on change.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !ready) return
    // If OHIF hung nothing, stay idle.
    if (displaySets.length === 0) {
      setStatus({ kind: 'idle' })
      return
    }

    let cancelled = false
    const abort = new AbortController()

    // Phase-1 fast path: any display set that is already a NiiVue volume URL.
    const directSpecs = displaySets
      .map((ds) => displaySetToNiivue(ds))
      .filter((s): s is NonNullable<typeof s> => s !== null)
    if (directSpecs.length > 0) {
      setStatus({ kind: 'idle' })
      nv.loadVolumes(directSpecs).catch(() => {
        if (!cancelled)
          setStatus({ kind: 'error', message: 'Failed to load volume.' })
      })
      return () => {
        cancelled = true
      }
    }

    // Otherwise route the first display set by kind.
    const ds: OhifDisplaySet | undefined = displaySets[0]
    if (!ds) {
      setStatus({ kind: 'idle' })
      return
    }
    const kind = classifyDisplaySet(ds)

    if (kind === 'wsi') {
      // Whole-slide imaging is destined for NVSlide (tiled LOD); the DICOM-WSI
      // tile-source adapter is not wired yet.
      setStatus({
        kind: 'note',
        message:
          'Whole-slide (SM) series will render with NiiVue NVSlide (tiled) — that data path is coming.',
      })
      return
    }

    if (kind === 'unsupported') {
      setStatus({
        kind: 'note',
        message: "This series isn't something NiiVue can load yet.",
      })
      return
    }

    // kind === 'dicom-volume': fetch original DICOM P10 + convert with dcm2niix.
    setStatus({ kind: 'loading', message: 'Fetching DICOM series...' })
    convertDisplaySetToNifti(ds, {
      headers: authHeaders(servicesManager),
      signal: abort.signal,
      onProgress: (phase, loaded, total) => {
        if (cancelled) return
        setStatus({
          kind: 'loading',
          message:
            phase === 'fetching'
              ? `Fetching DICOM series... ${loaded}/${total}`
              : 'Converting DICOM to NIfTI (dcm2niix)...',
        })
      },
    })
      .then((niftiFile) => {
        if (cancelled) return
        if (!niftiFile) {
          setStatus({
            kind: 'error',
            message: 'DICOM conversion produced no volume.',
          })
          return
        }
        setStatus({ kind: 'idle' })
        // Use the converted file's own name (ends in .nii/.nii.gz) so NiiVue sniffs
        // the format correctly; a display name without that extension would not.
        return nv.loadVolumes([{ url: niftiFile, name: niftiFile.name }])
      })
      .catch((err) => {
        if (cancelled || abort.signal.aborted) return
        console.error('[nv-ohif] DICOM load failed', err)
        const message = err instanceof Error ? err.message : String(err)
        setStatus({
          kind: 'error',
          message: `DICOM load failed: ${message || 'unknown error'}`,
        })
      })

    return () => {
      cancelled = true
      abort.abort()
    }
  }, [displaySets, ready, servicesManager])

  // Mirror OHIF's active primary tool onto NiiVue's left-drag mode (Window/Level,
  // Pan, ...), so the OHIF toolbar drives this viewport too. NiiVue already applies a
  // robust 2-98% window on load, so no default-window wiring is needed here.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !ready) return
    const svc = ohifServices(servicesManager)?.toolGroupService as
      | ToolGroupServiceLike
      | undefined
    if (!svc?.getActivePrimaryMouseButtonTool) return

    const apply = () => {
      const tool = svc.getActivePrimaryMouseButtonTool?.('default')
      nv.primaryDragMode = ohifToolToDragMode(tool)
    }
    apply()
    const event = svc.EVENTS?.PRIMARY_TOOL_ACTIVATED
    const sub = event ? svc.subscribe?.(event, apply) : undefined
    return () => sub?.unsubscribe?.()
  }, [ready, servicesManager])

  const overlay = status.kind === 'idle' ? null : status.message
  return (
    <div
      data-viewport-id={viewportId}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {overlay ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: status.kind === 'error' ? '#e88' : '#9aa',
            font: '14px sans-serif',
            textAlign: 'center',
            padding: '1rem',
            pointerEvents: 'none',
          }}
        >
          {overlay}
        </div>
      ) : null}
    </div>
  )
}
