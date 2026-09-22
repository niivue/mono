import type { NiiVueOptions, VectorAnnotation } from '@niivue/niivue'
import NiiVue, { NVSlide, SLICE_TYPE } from '@niivue/niivue'
import { loadDefaultFont } from '@niivue/uikit'
import { useEffect, useRef, useState } from 'react'
import { classifyDisplaySet } from './classifyDisplaySet'
import {
  applyDefaultAnnotationText,
  clearNiivueAnnotations,
  readBaseWindowLevel,
  reconcileNiivueAnnotations,
  reflectNiivueAnnotation,
  removeNiivueAnnotation,
  subscribeOhifLabelSync,
  syncNiivueWindowLevelToOhif,
  visibleAnnotationScreenShapes,
} from './commands'
import { convertDisplaySetToNifti } from './dicomToNiivue'
import { displaySetToNiivue } from './displaySetToNiivue'
import {
  authHeaders,
  ohifServices,
  refreshToolbar,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import type { OhifDisplaySet, OhifViewportProps } from './ohif-types'
import {
  ohifToolToAnnotationTool,
  ohifToolToDragMode,
  UNSUPPORTED_MEASUREMENT_TOOLS,
} from './toolBridge'
import { VolumeAnnotationOverlay } from './volumeAnnotationOverlay'
import { mountWsiSlideView } from './wsiSlideView'
import { buildWsiManifest, DicomWsiTileSource } from './wsiTileSource'

// Default NiiVue config for the OHIF viewport. Opens multiplanar (set after attach)
// so an OHIF user sees the three orthogonal planes; the toolbar (later) can switch to
// 3D render etc.
const DEFAULT_OPTIONS: Partial<NiiVueOptions> = {
  backgroundColor: [0, 0, 0, 1],
  // WebGL2 is the robust default for an embedded viewport (broad support; avoids
  // WebGPU device churn when OHIF mounts/unmounts viewports). Revisit once WebGPU
  // multi-instance handling is proven in-app.
  backend: 'webgl2',
  // OHIF panel measurements are independent records. Never union/cut them when
  // their contours overlap, because that destroys measurement identity/stats.
  annotationMergesOverlaps: false,
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

/**
 * The NiiVue viewport React component OHIF hangs a display set in. It routes each
 * display set to the right NiiVue load path (see {@link classifyDisplaySet}):
 *   - a NIfTI/volume URL loads directly,
 *   - a volumetric DICOM series is fetched + converted with dcm2niix, then loaded,
 *   - whole-slide (SM) series render with NVSlide (JPEG / TILED_FULL; JPEG 2000 and
 *     TILED_SPARSE are declined with a note),
 *   - anything else shows an explanatory note.
 *
 * NiiVue's core is framework-agnostic, so this owns a plain <canvas> + a `NiiVue`
 * instance directly (React 18) rather than depending on `@niivue/nvreact` (React 19).
 */
export function NiivueViewport(props: OhifViewportProps) {
  const { displaySets, viewportId, servicesManager, commandsManager } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nvRef = useRef<NiiVue | null>(null)
  const slideViewRef = useRef<ReturnType<typeof mountWsiSlideView> | null>(null)
  const activeOhifToolRef = useRef<string | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  // OHIF can re-render with fresh displaySets/servicesManager object
  // identities on unrelated state changes (e.g. toolbar interactions). Effects
  // must NOT key on those identities — a spurious re-run of the create effect
  // would tear down the GPU context, and of the load effect refetch the whole
  // series — so they read the latest props from refs and key on stable values.
  const displaySetsRef = useRef(displaySets)
  displaySetsRef.current = displaySets
  const servicesManagerRef = useRef(servicesManager)
  servicesManagerRef.current = servicesManager
  const commandsManagerRef = useRef(commandsManager)
  commandsManagerRef.current = commandsManager
  const displaySetsKey = displaySets
    .map((ds) => String(ds.displaySetInstanceUID ?? ds.SeriesInstanceUID ?? ''))
    .join('|')

  // Create / tear down the NiiVue instance with the canvas.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    // UIKit annotation overlay for volume measurements + ROIs (registered after
    // the font loads); torn down on unmount.
    let annotationOverlay: VolumeAnnotationOverlay | null = null
    let unregisterAnnotation: (() => void) | null = null
    const canvas = document.createElement('canvas')
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%'
    container.appendChild(canvas)

    const nv = new NiiVue(DEFAULT_OPTIONS)
    nvRef.current = nv
    // Only mark ready once attach resolves — loading before that races the GPU
    // context (and StrictMode double-mounts), which left the volume unloaded.
    nv.attachToCanvas(canvas).then(() => {
      if (disposed) return
      nv.sliceType = SLICE_TYPE.MULTIPLANAR
      // Measurements + ROIs are vector annotations (Length is the measureLine
      // tool, unified with the ellipse/rect/circle/arrow/spline tools). Draw them
      // as @niivue/uikit shapes: once the bundled UIKit font resolves we register
      // the overlay and switch NiiVue's built-in annotation draw OFF, so only the
      // UIKit rendering shows (line + length/area/intensity label). If the font
      // never loads, NiiVue's built-in annotation draw remains as the fallback.
      loadDefaultFont()
        .then((font) => {
          if (disposed) return
          annotationOverlay = new VolumeAnnotationOverlay(font, () =>
            visibleAnnotationScreenShapes(
              viewportId,
              nv.annotationScreenShapes,
            ),
          )
          unregisterAnnotation = nv.registerOverlayRenderer(annotationOverlay)
          nv.isAnnotationDrawn = false
        })
        .catch((err) =>
          console.error('[nv-ohif] annotation font failed to load', err),
        )
      // Expose the instance to OHIF commands / toolbar evaluators (commands.ts),
      // with a status sink so async commands (overlay load) surface progress.
      registerNiivue(viewportId, nv)
      updateNiivueViewport(viewportId, {
        setStatus: (message) =>
          setStatus(
            message === null
              ? { kind: 'idle' }
              : {
                  kind: /failed/i.test(message)
                    ? 'error'
                    : /\.\.\./.test(message)
                      ? 'loading'
                      : 'note',
                  message,
                },
          ),
      })
      refreshToolbar(servicesManagerRef.current, viewportId)
      setReady(true)
    })

    const ro = new ResizeObserver(() => nv.resize())
    ro.observe(container)

    // Reverse W/L bridge: a manual contrast drag changes the base volume's
    // window but NiiVue emits no intensity event, so read it on pointer release
    // and reflect any change back to OHIF (commands.ts). A transient readout
    // confirms the new window/level; unchanged releases (navigation) are silent.
    const onPointerUp = () => {
      const wl = syncNiivueWindowLevelToOhif(
        viewportId,
        servicesManagerRef.current,
        commandsManagerRef.current,
      )
      if (!wl) return
      const message = `W: ${Math.round(wl.window)}  L: ${Math.round(wl.level)}`
      setStatus({ kind: 'note', message })
      window.setTimeout(
        () =>
          setStatus((s) =>
            s.kind === 'note' && s.message === message ? { kind: 'idle' } : s,
          ),
        2000,
      )
    }
    canvas.addEventListener('pointerup', onPointerUp)

    // Annotations (Length / ROI / arrow): reflect a completed vector annotation
    // into OHIF's measurement panel, remove its row when the annotation is
    // removed, and drop every row when annotations are cleared (series swap /
    // clear-all).
    const onAnnotationAdded = (e: Event) => {
      const annotation = (e as CustomEvent<{ annotation: VectorAnnotation }>)
        .detail?.annotation
      if (!annotation) return
      if (applyDefaultAnnotationText(annotation, nv.annotations)) nv.drawScene()
      // annotationAdded carries the PRE-merge object; nv.annotations holds the
      // post-merge clone (clipper may have changed its polygons). Reflect the
      // stored one so its geometry + content hash match what reconcile later sees
      // (round-2 review R2-5). Fall back to the event object if not found.
      const stored =
        nv.annotations.find((a) => a.id === annotation.id) ?? annotation
      const added = reflectNiivueAnnotation(
        viewportId,
        servicesManagerRef.current,
        stored,
      )
      const stats = stored.stats
      if (!added || !stats) return
      // A measured line reports its length; area tools report area.
      const message =
        stats.length !== undefined
          ? `Length: ${stats.length.toFixed(1)} mm`
          : `Area: ${stats.area.toFixed(1)} mm²`
      setStatus({ kind: 'note', message })
      window.setTimeout(
        () =>
          setStatus((s) =>
            s.kind === 'note' && s.message === message ? { kind: 'idle' } : s,
          ),
        2000,
      )
    }
    const onAnnotationRemoved = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id
      if (id) removeNiivueAnnotation(viewportId, servicesManagerRef.current, id)
    }
    const onAnnotationChanged = (e: Event) => {
      const action = (e as CustomEvent<{ action: string }>).detail?.action
      if (!action) return
      // onAnnotationAdded already reflected the new annotation, but a 'draw' can
      // also MERGE (clipper union/cut) a previously reflected annotation out of
      // the set with no annotationRemoved event, so its row would linger
      // (round-2 review R2-2). Every action reconciles: it is diff-based (only
      // touches changed/vanished/new rows) and re-entrancy guarded, so
      // reconciling on 'draw' just prunes any consumed row and no-ops the rest.
      reconcileNiivueAnnotations(viewportId, servicesManagerRef.current)
    }
    nv.addEventListener('annotationAdded', onAnnotationAdded)
    nv.addEventListener('annotationRemoved', onAnnotationRemoved)
    nv.addEventListener('annotationChanged', onAnnotationChanged)

    // Push OHIF measurement-label edits onto the matching NiiVue annotation as
    // free text, so labeling a row in the panel labels the shape on the canvas.
    const unsubscribeLabelSync = subscribeOhifLabelSync(
      servicesManagerRef.current,
    )

    return () => {
      disposed = true
      setReady(false)
      // Drop this viewport's reflected measurement rows and their bookkeeping:
      // nv.destroy() fires no 'clear' event, so without this the panel rows and
      // the module-level reflection maps would leak across every unmount
      // (StrictMode double-mount, route / layout churn).
      clearNiivueAnnotations(viewportId, servicesManagerRef.current)
      unregisterNiivue(viewportId)
      refreshToolbar(servicesManagerRef.current, viewportId)
      canvas.removeEventListener('pointerup', onPointerUp)
      nv.removeEventListener('annotationAdded', onAnnotationAdded)
      nv.removeEventListener('annotationRemoved', onAnnotationRemoved)
      nv.removeEventListener('annotationChanged', onAnnotationChanged)
      unsubscribeLabelSync?.()
      unregisterAnnotation?.()
      annotationOverlay?.destroy()
      ro.disconnect()
      nv.destroy()
      canvas.width = 0
      canvas.height = 0
      canvas.remove()
      nvRef.current = null
    }
  }, [viewportId])

  // Load the display set(s) hung in this viewport, once attached / on change.
  // Keyed on displaySetsKey (not the array identity) by design — see above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on displaySetsKey by design
  useEffect(() => {
    const nv = nvRef.current
    const displaySets = displaySetsRef.current
    const servicesManager = servicesManagerRef.current
    if (!nv || !ready) return
    // This effect re-runs when a NEW display set is hung in the same viewport
    // slot (OHIF swaps props; the NiiVue instance is reused — the create effect
    // keys only on viewportId). Core loadVolumes replaces the volume array but
    // does NOT reset annotations or our overlay bookkeeping, so clear them here
    // before loading the new series: otherwise the previous series' measurements
    // and ROIs re-project onto the new anatomy, and the Overlay button reads
    // active with nothing overlaid. (No-op on the first load — nothing to clear
    // yet.)
    nv.clearAnnotations()
    // Keep the registry's view of the base display sets current, so overlay
    // commands know what is already loaded and W/L-preset buttons can gate on
    // the base modality (see commands.ts). Refresh the toolbar so those
    // modality-gated buttons re-evaluate now that the modality is known.
    updateNiivueViewport(viewportId, {
      displaySets,
      overlayUIDs: [],
      overlayLoading: false,
    })
    refreshToolbar(servicesManager, viewportId)

    // Volume-loading routes call loadVolumes, which replaces nv.volumes to match
    // the reset overlayUIDs=[]. Routes that do NOT load a volume (WSI /
    // unsupported / empty) must drop any volumes left from a previous series, or
    // nv.volumes desyncs from overlayUIDs=[] — the volume-gated Overlay button
    // would stay enabled on a WSI viewport and toggling it would stack volumes.
    const dropStaleVolumes = () => {
      if (nv.volumes.length > 0) void nv.removeAllVolumes().catch(() => {})
    }

    // If OHIF hung nothing, stay idle.
    if (displaySets.length === 0) {
      dropStaleVolumes()
      setStatus({ kind: 'idle' })
      return
    }

    let cancelled = false
    const abort = new AbortController()

    // Record the base volume's initial window/level as the reverse-bridge
    // baseline, so the first manual contrast drag is detected as a change.
    const seedWindowLevel = () => {
      if (cancelled) return
      updateNiivueViewport(viewportId, { windowLevel: readBaseWindowLevel(nv) })
      // A reflection may have failed while OHIF's backing series or the converted
      // volume was still becoming ready. Retry after the load boundary even when
      // annotation geometry itself has not changed.
      reconcileNiivueAnnotations(viewportId, servicesManagerRef.current)
      // The volume-gated toolbar buttons (Views, Clip, W/L, ...) were evaluated
      // at attach time when no volume was loaded yet, so they came up disabled.
      // Now that the volume is in (esp. after the async dcm2niix conversion),
      // re-evaluate the toolbar so they enable.
      refreshToolbar(servicesManagerRef.current, viewportId)
    }

    // Phase-1 fast path: any display set that is already a NiiVue volume URL.
    const directSpecs = displaySets
      .map((ds) => displaySetToNiivue(ds))
      .filter((s): s is NonNullable<typeof s> => s !== null)
    if (directSpecs.length > 0) {
      setStatus({ kind: 'idle' })
      nv.loadVolumes(directSpecs).then(
        () => {
          // The slot was swapped away (e.g. to a WSI) while this load was in flight:
          // its dropStaleVolumes() already ran and no-op'd because nv.volumes was
          // still empty, so undo this now-stale load ourselves.
          if (cancelled) {
            void nv.removeAllVolumes().catch(() => {})
            return
          }
          seedWindowLevel()
        },
        () => {
          if (!cancelled)
            setStatus({ kind: 'error', message: 'Failed to load volume.' })
        },
      )
      return () => {
        cancelled = true
      }
    }

    // Otherwise route the first display set by kind.
    const ds: OhifDisplaySet | undefined = displaySets[0]
    if (!ds) {
      dropStaleVolumes()
      setStatus({ kind: 'idle' })
      return
    }
    const kind = classifyDisplaySet(ds)

    if (kind === 'wsi') {
      // WSI renders on its own slide canvas, not the NiiVue volume renderer, so
      // drop any volume left from a previous series in this slot.
      dropStaleVolumes()
      // Whole-slide imaging renders with NVSlide (tiled deep-zoom) on its own
      // WebGL2 canvas, independent of NiiVue's volume renderer. The NiiVue canvas
      // stays blank underneath; the slide canvas is overlaid and torn down here.
      const built = buildWsiManifest(ds)
      if (!built) {
        setStatus({
          kind: 'note',
          message:
            'This slide has no tiled (VOLUME) pyramid levels to display.',
        })
        return
      }
      if (!built.allJpeg) {
        setStatus({
          kind: 'note',
          message:
            'This slide is JPEG 2000, which the viewer cannot decode yet (JPEG slides are supported).',
        })
        return
      }
      if (!built.tiledFull) {
        // The tile grid assumes TILED_FULL row-major frame order; a TILED_SPARSE
        // slide would render scrambled, so decline rather than mislead.
        setStatus({
          kind: 'note',
          message:
            'This slide uses TILED_SPARSE frame organization, which the viewer cannot render yet (TILED_FULL slides are supported).',
        })
        return
      }
      const container = containerRef.current
      if (!container) return
      const slideCanvas = document.createElement('canvas')
      slideCanvas.style.cssText =
        'position:absolute;top:0;left:0;width:100%;height:100%;touch-action:none'
      container.appendChild(slideCanvas)
      const source = new DicomWsiTileSource(built, authHeaders(servicesManager))
      const slide = NVSlide.fromSource(source)
      let view: ReturnType<typeof mountWsiSlideView> | null = null
      try {
        // The ruler draws its length label on the slide itself, so we do NOT
        // reflect it into the centered status overlay (that produced a floating
        // duplicate of the reading). The onMeasure hook stays available for a
        // future push into OHIF's MeasurementService.
        view = mountWsiSlideView(slideCanvas, slide)
        slideViewRef.current = view
        view.setTool(activeOhifToolRef.current)
        updateNiivueViewport(viewportId, { slideView: view })
        refreshToolbar(servicesManager, viewportId)
        setStatus({ kind: 'idle' })
      } catch (err) {
        slideCanvas.remove()
        console.error('[nv-ohif] WSI view failed', err)
        setStatus({
          kind: 'error',
          message: 'Failed to start the whole-slide viewer.',
        })
        return
      }
      return () => {
        cancelled = true
        updateNiivueViewport(viewportId, { slideView: undefined })
        slideViewRef.current = null
        view?.dispose()
        slideCanvas.width = 0
        slideCanvas.height = 0
        slideCanvas.remove()
      }
    }

    if (kind === 'unsupported') {
      dropStaleVolumes()
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
        return nv
          .loadVolumes([{ url: niftiFile, name: niftiFile.name }])
          .then(() => {
            // Swapped away while this load was in flight: undo the now-stale load
            // (its dropStaleVolumes already ran and no-op'd on an empty array).
            if (cancelled) {
              void nv.removeAllVolumes().catch(() => {})
              return
            }
            seedWindowLevel()
          })
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
  }, [displaySetsKey, ready])

  // Mirror OHIF's active primary tool onto NiiVue's matching left-drag mode, so
  // windowing, pan, zoom, measurements, angles and ROI tools drive this viewport.
  // NiiVue already applies a robust 2-98% window on load, so no default-window
  // wiring is needed here.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !ready) return
    const svc = ohifServices(servicesManager)?.toolGroupService as
      | ToolGroupServiceLike
      | undefined
    if (!svc?.getActivePrimaryMouseButtonTool) return

    const apply = () => {
      const tool = svc.getActivePrimaryMouseButtonTool?.('default')
      activeOhifToolRef.current = tool
      // ROI / arrow tools drive NiiVue's vector-annotation system (measureEllipse
      // etc.); the master gate must be on for a left-drag to draw. Every other
      // tool turns the gate off and maps to a left-drag mode instead.
      const annoTool = ohifToolToAnnotationTool(tool)
      if (annoTool) {
        nv.annotationTool = annoTool
        nv.annotationIsEnabled = true
      } else {
        nv.annotationIsEnabled = false
        nv.primaryDragMode = ohifToolToDragMode(tool)
        if (tool && UNSUPPORTED_MEASUREMENT_TOOLS.has(tool)) {
          const message = `${tool} is not supported in NiiVue`
          setStatus({ kind: 'note', message })
          window.setTimeout(
            () =>
              setStatus((s) =>
                s.kind === 'note' && s.message === message
                  ? { kind: 'idle' }
                  : s,
              ),
            2500,
          )
        }
      }
      slideViewRef.current?.setTool(tool)
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
