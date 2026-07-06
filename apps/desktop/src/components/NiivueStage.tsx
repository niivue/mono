import { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react'
import type { ColorMap, NiiVueLocation } from '@niivue/niivue'
import type { Backend, ClipPlane, DesktopItem, JsonValue, VolumeMetadata } from '../domain/desktop'
import { fetchVolumeMetadata, rawVolumeUrl } from '../domain/desktop'

// The window NiiVue actually applied for a layer, plus the volume's robust
// range (the "no threshold" target for a show-all reset).
export interface ResolvedWindow {
  min: number
  max: number
  robustMin?: number
  robustMax?: number
}

interface NiivueStageProps {
  item: DesktopItem | null
  layers: NiivueRenderLayer[]
  activeClipPlaneId: string
  backend: Backend
  clipPlanes: ClipPlane[]
  isActive: boolean
  renderWheelMode: 'zoom' | 'clip-plane'
  viewMode: ViewModeId
  // A one-shot request to move the crosshair to an absolute RAS+ mm position.
  // A fresh object identity re-triggers the move (so going to the same
  // coordinate twice still fires).
  crosshairTarget?: { mm: [number, number, number] } | null
  onClipPlaneDepthChange: (planeId: string, depth: number) => void
  onLocationChange?: (location: NiiVueLocation | null) => void
  // Reports the intensity window NiiVue actually applied per layer (keyed by
  // item id), including auto-seeded defaults — so the UI can show the effective
  // threshold/range instead of a bare "auto".
  onResolvedWindows?: (windows: Record<string, ResolvedWindow>) => void
  // Reports each loaded layer's world-space (mm) bounding box, keyed by item id,
  // so the UI can warn when an overlay doesn't share the base's space.
  onLayerExtents?: (extents: Record<string, { min: number[]; max: number[] }>) => void
  onViewModeChange: (mode: ViewModeId) => void
}

export interface NiivueRenderLayer {
  item: DesktopItem
  kind: 'base' | 'overlay'
  isAtlas?: boolean
  colormap: string
  colormapNegative?: string
  opacity: number
  // Intensity window (NIfTI cal_min/cal_max). Undefined leaves NiiVue's robust
  // auto range. Most visible in 2D slice modes.
  calMin?: number
  calMax?: number
}

interface NiiVueLike {
  canvas?: HTMLCanvasElement
  // Loaded volumes, in the same order as the render layers. robustMin/robustMax
  // are NiiVue's auto window (2nd/98th percentile); globalMax is the true peak;
  // extentsMin/Max are the volume's world-space (mm) bounding box, used to flag
  // overlays that land in a different space than the base.
  volumes?: Array<{
    robustMin?: number
    robustMax?: number
    globalMax?: number
    extentsMin?: ArrayLike<number>
    extentsMax?: ArrayLike<number>
  }>
  activeClipPlaneIndex?: number
  attachToCanvas(canvas: HTMLCanvasElement): Promise<unknown>
  loadVolumes(volumes: NiiVueVolumeOptions[]): Promise<unknown>
  setColormapLabel?(volumeIndex: number, cmap: ColorMap | null): Promise<void>
  setVolume?(
    volumeIndex: number,
    options: {
      colormap?: string
      colormapNegative?: string
      opacity?: number
      // NiiVue's display window is calMin/calMax (camelCase). The snake_case
      // cal_min/cal_max are the NIfTI header fields and are ignored here.
      calMin?: number
      calMax?: number
    }
  ): Promise<unknown>
  moveCrosshairInVox?(di: number, dj: number, dk: number): void
  // Move the crosshair to an absolute RAS+ world position (mm). Fires
  // locationChange, so the readout updates like a click.
  setCrosshairPos?(pos: [number, number, number]): void
  // Slice layout: SLICE_TYPE.{AXIAL:0, CORONAL:1, SAGITTAL:2, MULTIPLANAR:3, RENDER:4}.
  sliceType?: number
  isOrientationTextVisible?: boolean
  addEventListener?(
    type: 'locationChange',
    listener: (event: CustomEvent<NiiVueLocation>) => void,
    options?: boolean | AddEventListenerOptions
  ): void
  removeEventListener?(
    type: 'locationChange',
    listener: (event: CustomEvent<NiiVueLocation>) => void,
    options?: boolean | EventListenerOptions
  ): void
  azimuth?: number
  elevation?: number
  model?: {
    scene?: {
      scaleMultiplier?: number
    }
  }
  setClipPlanes?(planes: number[][]): void
  setClipPlane?(plane: number[]): void
  drawScene(): void
  resize?: () => void
  destroy?: () => void
}

interface RenderVolumeLevel {
  level: number
  url: string
  shape?: [number, number, number]
}

interface NiiVueVolumeOptions {
  url: string | File
  name: string
  colormap?: string
  colormapNegative?: string
  opacity?: number
  isColorbarVisible?: boolean
  calMin?: number
  calMax?: number
}

interface VolumePrefetch {
  url: string
  file: Promise<File>
}

interface RenderViewSnap {
  id: RenderSnapId
  label: string
  shortLabel: string
  azimuth: number
  elevation: number
  shortcut?: string
}

type RenderSnapId = 'coronal' | 'sagittal' | 'axial'
type NiiVueConstructor = new (options?: Record<string, unknown>) => NiiVueLike
type VoxelStep = readonly [di: number, dj: number, dk: number]

const CLIP_DEPTH_WHEEL_STEP = 0.0015
const NIVUE_SLICE_TYPE_RENDER = 4
const NIVUE_SHOW_RENDER_ALWAYS = 1

// NiiVue SLICE_TYPE values for each selectable view mode.
export type ViewModeId = 'axial' | 'coronal' | 'sagittal' | 'multiplanar' | 'render'
const VIEW_MODES: Array<{ id: ViewModeId; label: string; shortLabel: string; sliceType: number }> = [
  { id: 'axial', label: 'Axial slice', shortLabel: 'Ax', sliceType: 0 },
  { id: 'coronal', label: 'Coronal slice', shortLabel: 'Cor', sliceType: 1 },
  { id: 'sagittal', label: 'Sagittal slice', shortLabel: 'Sag', sliceType: 2 },
  { id: 'multiplanar', label: 'Multiplanar', shortLabel: 'MPR', sliceType: 3 },
  { id: 'render', label: '3D render', shortLabel: '3D', sliceType: NIVUE_SLICE_TYPE_RENDER }
]
export const DEFAULT_VIEW_MODE: ViewModeId = 'render'
const CORONAL_SNAP: RenderViewSnap = {
  id: 'coronal',
  label: 'Coronal',
  shortLabel: 'Cor',
  azimuth: 180,
  elevation: 0,
  shortcut: '1 / Numpad 1'
}
const SAGITTAL_SNAP: RenderViewSnap = {
  id: 'sagittal',
  label: 'Sagittal',
  shortLabel: 'Sag',
  azimuth: -90,
  elevation: 0,
  shortcut: '3 / Numpad 3'
}
const AXIAL_SNAP: RenderViewSnap = {
  id: 'axial',
  label: 'Axial',
  shortLabel: 'Ax',
  azimuth: 0,
  elevation: 90,
  shortcut: '7 / Numpad 7'
}
const atlasColorMapCache = new Map<string, Promise<ColorMap | null>>()
const BLENDER_RENDER_VIEW_SNAPS: Record<string, { normal: RenderViewSnap; reverse: RenderViewSnap }> = {
  Digit1: {
    normal: CORONAL_SNAP,
    reverse: {
      ...CORONAL_SNAP,
      label: 'Posterior coronal',
      azimuth: 0,
      shortcut: 'Ctrl+1'
    }
  },
  Numpad1: {
    normal: CORONAL_SNAP,
    reverse: {
      ...CORONAL_SNAP,
      label: 'Posterior coronal',
      azimuth: 0,
      shortcut: 'Ctrl+Numpad 1'
    }
  },
  Digit3: {
    normal: SAGITTAL_SNAP,
    reverse: {
      ...SAGITTAL_SNAP,
      label: 'Left sagittal',
      azimuth: 90,
      shortcut: 'Ctrl+3'
    }
  },
  Numpad3: {
    normal: SAGITTAL_SNAP,
    reverse: {
      ...SAGITTAL_SNAP,
      label: 'Left sagittal',
      azimuth: 90,
      shortcut: 'Ctrl+Numpad 3'
    }
  },
  Digit7: {
    normal: AXIAL_SNAP,
    reverse: {
      ...AXIAL_SNAP,
      label: 'Inferior axial',
      elevation: -90,
      shortcut: 'Ctrl+7'
    }
  },
  Numpad7: {
    normal: AXIAL_SNAP,
    reverse: {
      ...AXIAL_SNAP,
      label: 'Inferior axial',
      elevation: -90,
      shortcut: 'Ctrl+Numpad 7'
    }
  }
}

export function NiivueStage({
  item,
  layers,
  activeClipPlaneId,
  backend,
  clipPlanes,
  isActive,
  renderWheelMode,
  viewMode,
  crosshairTarget,
  onClipPlaneDepthChange,
  onLocationChange,
  onResolvedWindows,
  onLayerExtents,
  onViewModeChange
}: NiivueStageProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nvRef = useRef<NiiVueLike | null>(null)
  const prefetchRef = useRef<VolumePrefetch | null>(null)
  const [status, setStatus] = useState('Waiting for a dataset selection.')
  const [snapId, setSnapId] = useState<RenderSnapId | null>(null)
  // Bumped after each volume load completes, so the in-place display effect
  // re-runs once NiiVue has computed per-volume stats (robust range / peak) —
  // needed to seed a stat overlay's default threshold from its data.
  const [loadedVersion, setLoadedVersion] = useState(0)
  // Current crosshair location (mirrored from NiiVue) — drives the touch slice
  // slider so it stays in sync with clicks/paging from any source.
  const [location, setLocation] = useState<NiiVueLocation | null>(null)
  const primaryItem = layers[0]?.item ?? item
  const isRenderMode = viewMode === 'render'
  const currentViewLabel = (VIEW_MODES.find((mode) => mode.id === viewMode) ?? VIEW_MODES[VIEW_MODES.length - 1]).label
  const layerLoadKey = layers.map(layerLoadSignature).join('|')

  // Fetch the coarse volume the instant it is selected — at high priority, in
  // parallel with NiiVue init, and ahead of the low-priority 2D preview tiles.
  // We own the bytes and hand them straight to loadVolumes as a File, so NiiVue
  // never issues a second (default-priority) request that would queue behind the
  // previews; the only network request for this volume is this prioritized one.
  useEffect(() => {
    if (!primaryItem) {
      prefetchRef.current = null
      return
    }
    const coarse = renderVolumeLevels(primaryItem)[0]
    if (!coarse) {
      prefetchRef.current = null
      return
    }

    const controller = new AbortController()
    const file = fetchVolumeFile(coarse.url, controller.signal)
    // Avoid an unhandled rejection; loadRenderVolumeLods awaits and reports it.
    file.catch(() => {})
    const prefetch: VolumePrefetch = { url: coarse.url, file }
    prefetchRef.current = prefetch

    return () => {
      controller.abort()
      if (prefetchRef.current === prefetch) prefetchRef.current = null
    }
  }, [primaryItem])

  useEffect(() => {
    let cancelled = false
    let localNv: NiiVueLike | null = null
    let locationListener: ((event: CustomEvent<NiiVueLocation>) => void) | null = null

    async function attach(): Promise<void> {
      const canvas = canvasRef.current
      const stage = stageRef.current
      if (!canvas || layers.length === 0 || !primaryItem) {
        setSnapId(null)
        setStatus('Waiting for a dataset selection.')
        onLocationChange?.(null)
        return
      }

      setSnapId(null)
      syncCanvasSize(canvas, stage)
      setStatus(`Loading ${layerStackLabel(layers)} with ${backend.toUpperCase()}.`)
      try {
        const NiiVue = await loadNiiVue(backend)
        if (cancelled) return

        const nv = new NiiVue({
          backend,
          backgroundColor: [0.02, 0.024, 0.018, 1],
          clipPlaneColor: [0.95, 0.2, 0.12, 0.7],
          isResizeCanvas: true,
          isColorbarVisible: true,
          isLegendVisible: false,
          isOrientCubeVisible: true,
          isOrientationTextVisible: viewMode !== 'render',
          show3Dcrosshair: false,
          showRender: NIVUE_SHOW_RENDER_ALWAYS,
          sliceType: (VIEW_MODES.find((mode) => mode.id === viewMode) ?? VIEW_MODES[VIEW_MODES.length - 1]).sliceType,
          loadingText: ''
        })
        localNv = nv
        nvRef.current = nv
        await nv.attachToCanvas(canvas)
        if (cancelled) return
        if (nv.addEventListener) {
          locationListener = (event) => {
            if (cancelled) return
            setLocation(event.detail)
            onLocationChange?.(event.detail)
          }
          nv.addEventListener('locationChange', locationListener)
        }
        const attachedCanvas = activeCanvasFor(nv, canvas)
        canvasRef.current = attachedCanvas
        resizeNiiVue(nv, attachedCanvas, stage)
        await loadRenderVolumeLods({
          layers,
          nv,
          clipPlanes,
          canvas: attachedCanvas,
          stage,
          prefetch: prefetchRef.current,
          isCancelled: () => cancelled,
          setStatus
        })
        applyActiveClipPlane(nv, clipPlanes, activeClipPlaneId)
        // Volumes (and their robust-range stats) are now loaded; re-run the
        // in-place display effect so threshold/window defaults can read them.
        if (!cancelled) setLoadedVersion((version) => version + 1)
      } catch (error) {
        if (!cancelled) {
          nvRef.current = null
          setStatus(error instanceof Error ? error.message : String(error))
        }
      }
    }

    void attach()
    return () => {
      cancelled = true
      if (localNv && nvRef.current === localNv) {
        if (locationListener) {
          localNv.removeEventListener?.('locationChange', locationListener)
        }
        localNv.destroy?.()
        nvRef.current = null
      }
      onLocationChange?.(null)
    }
    // Layer display fields are applied in place below instead of tearing down
    // and reloading the whole volume.
  }, [backend, layerLoadKey, primaryItem, onLocationChange])

  // Apply display changes in place. Recreating the NiiVue instance (as the
  // attach effect does) just to recolor or hide an atlas would re-import the
  // module, re-attach the canvas, and refetch every LOD — far too heavy for a
  // dropdown or checkbox change.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv?.setVolume) return
    const resolved: Record<string, ResolvedWindow> = {}
    void Promise.all(layers.map((layer, index) => {
      // An explicit window wins; otherwise restore NiiVue's robust auto range
      // so clearing the window (the "Auto" button) actually reverts the
      // render — setVolume merges, so omitting calMin would leave a stale one.
      const volume = nv.volumes?.[index]
      const windowOption = windowOptionForLayer(layer, volume)
      if (windowOption.calMin !== undefined && windowOption.calMax !== undefined) {
        resolved[layer.item.id] = {
          min: windowOption.calMin,
          max: windowOption.calMax,
          // The robust range is the "no threshold" target for the show-all reset.
          robustMin: Number.isFinite(volume?.robustMin) ? volume?.robustMin : undefined,
          robustMax: Number.isFinite(volume?.robustMax) ? volume?.robustMax : undefined
        }
      }
      return nv.setVolume?.(index, {
        colormap: layer.colormap,
        colormapNegative: layer.colormapNegative ?? '',
        opacity: layer.opacity,
        ...windowOption
      }) ?? Promise.resolve()
    }))
      .then(() => {
        // setVolume updates the GPU volume texture but does not repaint the
        // canvas, so display-only changes (intensity window, colormap) would
        // otherwise not appear until the next pointer event. Force a redraw
        // once all layers have applied.
        nv.drawScene()
      })
      .catch(() => {
        // No volume loaded yet (or backend lacks setVolume); the attach effect
        // already loads with current display options, so this is safe to ignore.
      })
    onResolvedWindows?.(resolved)
    // loadedVersion: re-apply once post-load stats exist (threshold defaults).
  }, [layers, loadedVersion, onResolvedWindows])

  // Report each layer's world-space bounding box once loaded, so the panel can
  // flag overlays that don't share the base's space.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !onLayerExtents) return
    const extents: Record<string, { min: number[]; max: number[] }> = {}
    layers.forEach((layer, index) => {
      const volume = nv.volumes?.[index]
      if (volume?.extentsMin && volume?.extentsMax) {
        extents[layer.item.id] = {
          min: Array.from(volume.extentsMin),
          max: Array.from(volume.extentsMax)
        }
      }
    })
    onLayerExtents(extents)
  }, [layers, loadedVersion, onLayerExtents])

  // Apply the selected view mode (2D slice plane, multiplanar, or 3D render) to
  // the live instance. NiiVue exposes sliceType as a setter, so this never
  // recreates the instance. Orientation letters are only meaningful on 2D panes.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    const mode = VIEW_MODES.find((candidate) => candidate.id === viewMode) ?? VIEW_MODES[VIEW_MODES.length - 1]
    nv.sliceType = mode.sliceType
    nv.isOrientationTextVisible = viewMode !== 'render'
    nv.drawScene()
    // loadedVersion: the attach effect builds the instance with a stale
    // sliceType if the view mode was changed mid-load (nvRef was still null when
    // this effect first ran), so re-apply once the instance/volumes exist.
  }, [viewMode, primaryItem, loadedVersion])

  // Go-to: move the crosshair to a requested RAS+ mm position. A fresh
  // crosshairTarget object identity (one per request) re-fires this.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !crosshairTarget || !nv.setCrosshairPos) return
    nv.setCrosshairPos(crosshairTarget.mm)
    nv.drawScene()
  }, [crosshairTarget])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const stageElement = stage
    const canvasElement = canvas
    let frame = 0

    function resize(): void {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const nv = nvRef.current
        if (nv) {
          resizeNiiVue(nv, canvasElement, stageElement)
        } else {
          syncCanvasSize(canvasElement, stageElement)
        }
      })
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(stageElement)
    window.addEventListener('resize', resize)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    applyActiveClipPlane(nv, clipPlanes, activeClipPlaneId)
    applyClipPlanes(nv, clipPlanes)
    // Redraw to reflect the change, but don't resize the canvas — clip planes
    // move on every wheel tick, and a full resync per tick is what made wheel
    // clipping janky. The ResizeObserver effect owns actual resizes.
    nv.drawScene()
  }, [activeClipPlaneId, clipPlanes])

  useEffect(() => {
    if (!isActive || !primaryItem) return

    function onKeyDown(event: KeyboardEvent): void {
      if (isEditableTarget(event.target)) return

      const crosshairStep = crosshairStepForEvent(event)
      if (crosshairStep) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        const nv = nvRef.current
        if (nv?.moveCrosshairInVox) {
          nv.moveCrosshairInVox(...crosshairStep)
          setSnapId(null)
        }
        return
      }

      // Camera-angle snaps only make sense for the 3D render.
      if (!isRenderMode) return
      const snap = blenderSnapForEvent(event)
      if (!snap) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      snapRenderView(snap)
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [isActive, primaryItem, isRenderMode])

  function snapRenderView(snap: RenderViewSnap): void {
    const nv = nvRef.current
    if (!nv || !('azimuth' in nv) || !('elevation' in nv)) return

    nv.azimuth = snap.azimuth
    nv.elevation = snap.elevation
    setSnapId(snap.id)
    resizeNiiVue(nv, canvasRef.current, stageRef.current)
  }

  function clearSnapSelection(): void {
    if (snapId) setSnapId(null)
  }

  function changeViewMode(next: ViewModeId): void {
    onViewModeChange(next)
    clearSnapSelection()
  }

  function handleWheelCapture(event: ReactWheelEvent<HTMLDivElement>): void {
    clearSnapSelection()
    const nv = nvRef.current
    if (!nv) return

    // 2D single-plane modes: page through slices on wheel (clinician muscle
    // memory). NiiVue's native wheel doesn't page here, so drive the crosshair's
    // through-plane voxel ourselves. Multiplanar falls through to native.
    if (!isRenderMode) {
      const step = sliceWheelStep(viewMode, event.deltaY)
      if (step && nv.moveCrosshairInVox) {
        event.preventDefault()
        event.stopPropagation()
        nv.moveCrosshairInVox(...step)
      }
      return
    }

    if (renderWheelMode === 'clip-plane') {
      // Always handle the wheel ourselves: drive the active plane's depth
      // through React state (the same value the depth slider owns) rather than
      // letting NiiVue mutate hidden internal state. That keeps React the single
      // source of truth, so re-applying clipPlanes never resets another plane.
      event.preventDefault()
      event.stopPropagation()
      const activeIndex = applyActiveClipPlane(nv, clipPlanes, activeClipPlaneId)
      if (activeIndex < 0) return
      const active = clipPlanes.find((plane) => plane.id === activeClipPlaneId)
      if (!active) return
      const depth = clamp(active.depth + event.deltaY * CLIP_DEPTH_WHEEL_STEP, -1, 1)
      if (depth !== active.depth) onClipPlaneDepthChange(activeClipPlaneId, depth)
      return
    }

    event.preventDefault()
    event.stopPropagation()
    zoomRenderWithWheel(nv, event.deltaY)
  }

  // Touch slice paging: a slider that pages the through-plane voxel in the
  // single-plane 2D modes. NiiVue's native touch moves the crosshair in-plane
  // and pinch-zooms, but has no through-plane paging (that was wheel-only), so
  // on a phone this slider is the only way to change slice.
  const sliceAxis = SLICE_AXIS_INDEX[viewMode]
  const sliceDim = sliceAxis !== undefined && primaryItem ? primaryItem.shape[sliceAxis] ?? 0 : 0
  const sliceMax = Math.max(0, sliceDim - 1)
  const currentVox = sliceAxis !== undefined ? location?.vox?.[sliceAxis] : undefined
  const sliceValue =
    typeof currentVox === 'number' ? clamp(Math.round(currentVox), 0, sliceMax) : Math.floor(sliceMax / 2)
  const showSliceSlider = sliceAxis !== undefined && !!primaryItem && sliceMax > 0

  function pageToSlice(target: number): void {
    const nv = nvRef.current
    if (sliceAxis === undefined || !nv?.moveCrosshairInVox) return
    const delta = clamp(Math.round(target), 0, sliceMax) - sliceValue
    if (delta === 0) return
    const step: [number, number, number] = [0, 0, 0]
    step[sliceAxis] = delta
    nv.moveCrosshairInVox(...step)
  }

  return (
    <div
      className="nv-render-stage"
      onPointerDown={clearSnapSelection}
      onWheelCapture={handleWheelCapture}
      ref={stageRef}
    >
      <canvas
        key={backend}
        ref={canvasRef}
        role="img"
        aria-label={
          primaryItem
            ? `${currentViewLabel} of ${primaryItem.label}`
            : 'NiiVue viewer — no volume selected'
        }
      />
      <div className="nv-render-snap-controls" role="group" aria-label="View mode">
        {VIEW_MODES.map((mode) => (
          <button
            aria-label={`Show ${mode.label}`}
            aria-pressed={viewMode === mode.id}
            className={viewMode === mode.id ? 'is-active' : ''}
            disabled={!primaryItem}
            key={mode.id}
            onClick={() => changeViewMode(mode.id)}
            title={`Show ${mode.label}`}
            type="button"
          >
            {mode.shortLabel}
          </button>
        ))}
      </div>
      {showSliceSlider ? (
        <div className="nv-slice-slider" role="group" aria-label="Slice position">
          <input
            aria-label={`${currentViewLabel} slice`}
            max={sliceMax}
            min={0}
            step={1}
            type="range"
            value={sliceValue}
            onChange={(event) => pageToSlice(Number(event.target.value))}
          />
          <span className="nv-slice-slider-value">
            {sliceValue + 1} / {sliceMax + 1}
          </span>
        </div>
      ) : null}
      <div className="nv-render-status" role="status" aria-live="polite">{status}</div>
    </div>
  )
}

async function loadNiiVue(backend: Backend): Promise<NiiVueConstructor> {
  if (backend === 'webgpu') {
    try {
      const module = await import('@niivue/niivue/webgpu')
      return module.default as NiiVueConstructor
    } catch {
      const module = await import('@niivue/niivue')
      return module.default as NiiVueConstructor
    }
  }

  try {
    const module = await import('@niivue/niivue/webgl2')
    return module.default as NiiVueConstructor
  } catch {
    const module = await import('@niivue/niivue')
    return module.default as NiiVueConstructor
  }
}

// Intensity-window / threshold options for a setVolume call. An explicit
// per-layer window (Min/Max for a base, Threshold/Max for an overlay) always
// wins. With none set:
//   - statistical overlays default to a threshold at HALF the robust max, with
//     contrast saturating at the robust max. Half the 98th-percentile sits above
//     the near-zero noise (so the background stays transparent — no colour wash)
//     but is gentle enough to show moderate activation, not just the top ~2%.
//   - base layers restore NiiVue's robust auto range, so clearing the window
//     reverts the render.
//   - atlas/label layers get no window at all: they render through a discrete
//     label colormap, and clamping to a robust intensity range would drop the
//     label indices outside 2nd–98th percentile (parcels vanish / miscolor).
// Returns no keys when the volume's stats aren't available yet (still loading).
function windowOptionForLayer(
  layer: NiivueRenderLayer,
  volume: { robustMin?: number; robustMax?: number } | undefined
): { calMin?: number; calMax?: number } {
  if (layer.calMin !== undefined && layer.calMax !== undefined) {
    return { calMin: layer.calMin, calMax: layer.calMax }
  }
  if (!volume || layer.isAtlas) return {}
  const { robustMin, robustMax } = volume
  if (
    layer.kind === 'overlay' &&
    !layer.isAtlas &&
    Number.isFinite(robustMax) &&
    (robustMax as number) > 0
  ) {
    const max = robustMax as number
    return { calMin: max * 0.5, calMax: max }
  }
  if (Number.isFinite(robustMin) && Number.isFinite(robustMax)) {
    return { calMin: robustMin, calMax: robustMax }
  }
  return {}
}

function blenderSnapForEvent(event: KeyboardEvent): RenderViewSnap | null {
  if (event.altKey || event.metaKey || event.shiftKey) return null

  const snap = BLENDER_RENDER_VIEW_SNAPS[event.code]
  if (!snap) return null

  return event.ctrlKey ? snap.reverse : snap.normal
}

function crosshairStepForEvent(event: KeyboardEvent): VoxelStep | null {
  if (event.altKey || event.metaKey || event.shiftKey) return null

  const key = event.key.toLowerCase()
  if (event.ctrlKey) {
    if (key === 'u') return [0, 0, 1]
    if (key === 'd') return [0, 0, -1]
    return null
  }

  if (key === 'h') return [-1, 0, 0]
  if (key === 'l') return [1, 0, 0]
  if (key === 'j') return [0, -1, 0]
  if (key === 'k') return [0, 1, 0]
  return null
}

// Mouse-wheel slice paging for the single-plane 2D modes. The displayed slice
// follows the crosshair's through-plane voxel, so stepping that axis pages by
// one slice. Scroll down advances the through-plane voxel (wheel-down = next);
// which anatomical direction that is depends on the volume's orientation.
// Multiplanar/render return null (the wheel keeps its zoom / native behaviour).
function sliceWheelStep(viewMode: ViewModeId, deltaY: number): VoxelStep | null {
  if (deltaY === 0) return null
  const direction = deltaY > 0 ? 1 : -1
  switch (viewMode) {
    case 'axial':
      return [0, 0, direction]
    case 'coronal':
      return [0, direction, 0]
    case 'sagittal':
      return [direction, 0, 0]
    default:
      return null
  }
}

// Through-plane voxel axis (index into `vox`/`shape`) for each single-plane 2D
// mode — the axis the slice slider pages along.
const SLICE_AXIS_INDEX: Partial<Record<ViewModeId, number>> = {
  axial: 2,
  coronal: 1,
  sagittal: 0
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
}

async function loadRenderVolumeLods({
  layers,
  nv,
  clipPlanes,
  canvas,
  stage,
  prefetch,
  isCancelled,
  setStatus
}: {
  layers: NiivueRenderLayer[]
  nv: NiiVueLike
  clipPlanes: ClipPlane[]
  canvas: HTMLCanvasElement
  stage: HTMLDivElement | null
  prefetch: VolumePrefetch | null
  isCancelled: () => boolean
  setStatus: (status: string) => void
}): Promise<void> {
  const primaryLayer = layers[0]
  if (!primaryLayer) return
  const stackLevels = layers.map((layer) => ({
    layer,
    levels: renderVolumeLevels(layer.item)
  }))
  const atlasMaps = await resolveAtlasColorMaps(layers)
  if (isCancelled()) return

  const levels = stackLevels[0].levels
  let loadedLevel: RenderVolumeLevel | null = null
  let lastError: unknown = null

  for (const [index, level] of levels.entries()) {
    if (isCancelled()) return

    if (loadedLevel) {
      setStatus(`${layerStackLabel(layers)} refining to L${level.level} (${renderLevelShape(level)}).`)
      await waitForIdle()
      if (isCancelled()) return
    }

    const volumes = await Promise.all(stackLevels.map(async ({ layer, levels: layerLevels }, layerIndex) => {
      const layerLevel = layerLevels[Math.min(index, layerLevels.length - 1)]
      let source: string | File = layerLevel.url
      if (layerIndex === 0 && prefetch && prefetch.url === layerLevel.url) {
        try {
          source = await prefetch.file
        } catch {
          // Prefetch failed (e.g. aborted or network error); fall back to the URL
          // so NiiVue fetches it itself and surfaces any real error below.
          source = layerLevel.url
        }
      }
      return {
        url: source,
        name: `${layer.item.label} L${layerLevel.level}`,
        colormap: layer.colormap,
        colormapNegative: layer.colormapNegative ?? '',
        opacity: layer.opacity,
        isColorbarVisible: layerIndex === 0,
        ...(layer.calMin !== undefined ? { calMin: layer.calMin } : {}),
        ...(layer.calMax !== undefined ? { calMax: layer.calMax } : {})
      }
    }))
    if (isCancelled()) return

    try {
      await nv.loadVolumes(volumes)
      if (isCancelled()) return
      await applyAtlasLabelMaps(nv, atlasMaps)
    } catch (error) {
      lastError = error
      if (!loadedLevel) {
        if (!isCancelled()) {
          setStatus(`${primaryLayer.item.label} L${level.level} failed; trying finer volume.`)
        }
        continue
      }

      if (!isCancelled()) {
        setStatus(`${primaryLayer.item.label} stayed at L${loadedLevel.level}; L${level.level} refinement failed.`)
      }
      return
    }
    if (isCancelled()) return

    loadedLevel = level
    applyClipPlanes(nv, clipPlanes)
    resizeNiiVue(nv, canvas, stage)

    if (index === 0 && levels.length > 1) {
      setStatus(`${layerStackLabel(layers)} visible at L${level.level} (${renderLevelShape(level)}).`)
    } else if (index === levels.length - 1) {
      setStatus(`${layerStackLabel(layers)} ready at L${level.level} (${renderLevelShape(level)}).`)
    }
  }

  if (!loadedLevel && lastError) {
    throw lastError
  }
}

async function fetchVolumeFile(url: string, signal: AbortSignal): Promise<File> {
  const init: RequestInit & { priority?: 'high' | 'low' | 'auto' } = {
    signal,
    cache: 'force-cache',
    priority: 'high'
  }
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`Volume request failed with HTTP ${response.status}.`)
  }
  const buffer = await response.arrayBuffer()
  // Preserve the URL's basename so NiiVue's extension-based format detection
  // (getFileExt reads File.name) behaves exactly as it would for the URL.
  return new File([buffer], volumeFileName(url))
}

function volumeFileName(url: string): string {
  try {
    const path = new URL(url, window.location.href).pathname
    const base = path.slice(path.lastIndexOf('/') + 1)
    return base || 'volume.nii.gz'
  } catch {
    return 'volume.nii.gz'
  }
}

async function resolveAtlasColorMaps(layers: NiivueRenderLayer[]): Promise<Array<ColorMap | null>> {
  return Promise.all(
    layers.map((layer) => {
      if (!layer.isAtlas) return Promise.resolve(null)
      return atlasColorMapForItem(layer.item).catch(() => null)
    })
  )
}

function atlasColorMapForItem(item: DesktopItem): Promise<ColorMap | null> {
  const cacheKey = `${item.id}:${item.metadata}`
  const cached = atlasColorMapCache.get(cacheKey)
  if (cached) return cached

  const pending = fetchVolumeMetadata(item).then(extractAtlasColorMap)
  atlasColorMapCache.set(cacheKey, pending)
  return pending
}

function extractAtlasColorMap(metadata: VolumeMetadata): ColorMap | null {
  const direct = normalizeLabelColorMap(metadata as unknown as JsonValue)
  if (direct) return direct

  for (const sidecar of metadata.sidecars ?? []) {
    const colorMap = normalizeLabelColorMap(sidecar.metadata)
    if (colorMap) return colorMap
  }

  return null
}

async function applyAtlasLabelMaps(
  nv: NiiVueLike,
  atlasMaps: Array<ColorMap | null>
): Promise<void> {
  if (!nv.setColormapLabel) return
  await Promise.all(atlasMaps.map((colorMap, volumeIndex) => {
    if (!colorMap) return Promise.resolve()
    return (nv.setColormapLabel?.(volumeIndex, colorMap) ?? Promise.resolve()).catch(() => undefined)
  }))
}

function normalizeLabelColorMap(value: JsonValue): ColorMap | null {
  if (!isJsonObject(value)) return null
  const R = numericJsonArray(value.R)
  const G = numericJsonArray(value.G)
  const B = numericJsonArray(value.B)
  if (!R || !G || !B || R.length === 0 || G.length !== R.length || B.length !== R.length) {
    return null
  }

  const A = numericJsonArray(value.A)
  if (A && A.length !== R.length) return null
  const I = numericJsonArray(value.I)
  if (I && I.length !== R.length) return null

  const labels = stringJsonArray(value.labels)
  const colorMap: Partial<ColorMap> & Pick<ColorMap, 'R' | 'G' | 'B'> = { R, G, B }
  if (A) colorMap.A = A
  if (I) colorMap.I = I
  if (labels) colorMap.labels = labels
  return colorMap as ColorMap
}

function numericJsonArray(value: JsonValue | undefined): number[] | null {
  if (!Array.isArray(value)) return null
  const numbers = value.map((entry) => typeof entry === 'number' ? entry : Number(entry))
  return numbers.every(Number.isFinite) ? numbers : null
}

function stringJsonArray(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null
  return value.map((entry) => typeof entry === 'string' ? entry : String(entry))
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function layerLoadSignature(layer: NiivueRenderLayer): string {
  const levels = layer.item.levels.map((level) => `${level.level}:${level.raw ?? ''}`).join(',')
  return `${layer.kind}:${layer.isAtlas ? 'atlas' : 'volume'}:${layer.item.id}:${layer.item.metadata}:${levels}`
}

function layerStackLabel(layers: NiivueRenderLayer[]): string {
  const primary = layers[0]?.item.label ?? 'volume'
  const extras = Math.max(layers.length - 1, 0)
  return extras > 0 ? `${primary} + ${extras} layer${extras === 1 ? '' : 's'}` : primary
}

function renderVolumeLevels(item: DesktopItem): RenderVolumeLevel[] {
  const levels = item.levels
    .filter((level) => level.raw)
    .map((level) => ({
      level: level.level,
      url: level.raw as string,
      shape: level.shape
    }))
    .sort((left, right) => right.level - left.level)

  if (levels.length > 0) return levels

  return [
    {
      level: 0,
      url: rawVolumeUrl(item),
      shape: item.shape
    }
  ]
}

function renderLevelShape(level: RenderVolumeLevel): string {
  return level.shape?.join(' x ') ?? 'volume'
}

function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => resolve(), { timeout: 600 })
      return
    }

    setTimeout(resolve, 80)
  })
}

function applyClipPlanes(nv: NiiVueLike, clipPlanes: ClipPlane[]): void {
  const planes = clipPlanes
    .filter((plane) => plane.enabled)
    .map((plane) => [plane.depth, plane.azimuth, plane.elevation])

  if (nv.setClipPlanes) {
    nv.setClipPlanes(planes)
    return
  }

  if (nv.setClipPlane) {
    nv.setClipPlane(planes[0] ?? [2, 0, 0])
  }
}

function applyActiveClipPlane(
  nv: NiiVueLike,
  clipPlanes: ClipPlane[],
  activeClipPlaneId: string
): number {
  const activeIndex = clipPlanes
    .filter((plane) => plane.enabled)
    .findIndex((plane) => plane.id === activeClipPlaneId)

  if (activeIndex >= 0) {
    nv.activeClipPlaneIndex = activeIndex
  }

  return activeIndex
}

function zoomRenderWithWheel(nv: NiiVueLike, deltaY: number): void {
  const scene = nv.model?.scene
  if (!scene) return

  const current = typeof scene.scaleMultiplier === 'number'
    ? scene.scaleMultiplier
    : 1
  scene.scaleMultiplier = clamp(current + deltaY * 0.001, 0.5, 2)
  nv.drawScene()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function resizeNiiVue(
  nv: NiiVueLike,
  canvas: HTMLCanvasElement | null,
  stage: HTMLDivElement | null
): void {
  if (canvas) syncCanvasSize(canvas, stage)
  nv.resize?.()
  nv.drawScene()
}

function activeCanvasFor(nv: NiiVueLike, fallback: HTMLCanvasElement): HTMLCanvasElement {
  return nv.canvas instanceof HTMLCanvasElement ? nv.canvas : fallback
}

function syncCanvasSize(canvas: HTMLCanvasElement, stage: HTMLDivElement | null): void {
  const source = stage ?? canvas
  const density = Math.max(window.devicePixelRatio || 1, 1)
  const width = Math.max(1, Math.round(source.clientWidth * density))
  const height = Math.max(1, Math.round(source.clientHeight * density))

  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}
