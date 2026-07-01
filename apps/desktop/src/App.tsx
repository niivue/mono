import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { NiiVueLocation } from '@niivue/niivue'
import {
  AlertTriangle,
  ChevronDown,
  CircleDot,
  Calculator,
  CheckCircle2,
  Crosshair,
  Database,
  Eye,
  EyeOff,
  FileJson,
  FolderOpen,
  GripHorizontal,
  GripVertical,
  Layers,
  LoaderCircle,
  X,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Save,
  SlidersHorizontal,
  SquareTerminal,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { DatasetDesktop, MAX_DESKTOP_ZOOM, MIN_DESKTOP_ZOOM, zoomBy } from './components/DatasetDesktop'
import {
  NiivueStage,
  DEFAULT_VIEW_MODE,
  type NiivueRenderLayer,
  type ResolvedWindow,
  type ViewModeId
} from './components/NiivueStage'
import { NiimathOperationsPanel } from './components/NiimathOperationsPanel'
import { TerminalPanel } from './components/TerminalPanel'
import { VolumeFilterPanel } from './components/VolumeFilterPanel'
import type {
  Backend,
  ClipPlane,
  DesktopItem,
  DesktopManifest,
  JsonValue,
  VolumeMetadata,
  WarmProgress
} from './domain/desktop'
import {
  defaultClipPlanes,
  fetchVolumeMetadata,
  openOverlayVolume,
  resolveRuntimeCapabilities
} from './domain/desktop'
import {
  volumeImageTypeLabel,
  volumeRoleLabel,
  volumeSession,
  volumeSubject
} from './domain/volumeFacets'
import { useClipPlanes } from './hooks/useClipPlanes'
import { useDatasetManifest } from './hooks/useDatasetManifest'
import { recentDatasetLabel, useRecentDatasets } from './hooks/useRecentDatasets'
import { useTerminalDock } from './hooks/useTerminalDock'
import { useVolumeFilters } from './hooks/useVolumeFilters'
import { useVolumeMetadata } from './hooks/useVolumeMetadata'
import neurovueIconUrl from '../src-tauri/icons/neurovue-icon.svg?url'

const MIN_SPLIT = 34
const MAX_SPLIT = 68
const DEFAULT_BASE_COLORMAP = 'gray'
const DEFAULT_ATLAS_COLORMAP = 'actc'
const DEFAULT_OVERLAY_COLORMAPS = ['magma', 'viridis', 'actc'] as const
// Default layer opacities (used when a layer has no explicit opacity setting).
const DEFAULT_OVERLAY_OPACITY = 0.48
const DEFAULT_ATLAS_OPACITY = 0.34
const COLORMAP_OPTIONS = [
  { value: 'gray', label: 'Gray' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'magma', label: 'Magma' },
  { value: 'actc', label: 'ACTC' },
  { value: 'warm_cool', label: 'Warm/Cool (diverging)' }
] as const

// A colormap selection of 'warm_cool' is the NiiVue idiom for signed/stat data:
// a warm map for positive intensities paired with a cool map for negatives, so
// the rendering diverges around zero. Everything else is a single sequential map.
function resolveColormap(name: string): { colormap: string; colormapNegative?: string } {
  if (name === 'warm_cool') return { colormap: 'warm', colormapNegative: 'cool' }
  return { colormap: name }
}
// Prefer WebGPU when the platform exposes it, falling back to WebGL2 otherwise.
function preferredBackend(): Backend {
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'webgl2'
}

const FLIPPED_CLIP_ORIENTATIONS: Record<string, Pick<ClipPlane, 'azimuth' | 'elevation'>> = {
  anterior: { azimuth: 0, elevation: 0 },
  inferior: { azimuth: 0, elevation: 90 },
  right: { azimuth: 270, elevation: 0 }
}
type MouseContext = 'desktop' | 'niivue' | null
type SidePanelTab = 'inspect' | 'operations'

// Per-layer display settings, keyed by item id. An absent entry (or absent
// field) means "use the default": NiiVue's robust auto range for `window`, the
// role-based fallback for `colormap`. Opacity/hidden/threshold land in later
// phases of the layer-controls redesign.
// A layer's world-space (mm) axis-aligned bounding box, as reported by NiiVue.
interface LayerExtent {
  min: number[]
  max: number[]
}

interface LayerSettings {
  colormap?: string
  opacity?: number
  // Visibility override. `hidden` renders the layer at opacity 0 without
  // touching `opacity`, so toggling it back on restores the stored value.
  hidden?: boolean
  window?: { min: number; max: number }
}

export function App(): JSX.Element {
  const splitRef = useRef<HTMLElement | null>(null)
  const backend = useMemo<Backend>(preferredBackend, [])
  const { recentDatasets, promoteRecent, removeRecent } = useRecentDatasets()
  const {
    bidsDatasetDoi,
    bidsName,
    cacheRoot,
    datasetRevision,
    datasetRoot,
    isOpeningDataset,
    items,
    manifest,
    openLocalDataset,
    openRecentDataset,
    refreshDesktopManifest,
    refreshDesktopManifestData,
    selected,
    serverUrl,
    setSelectedId,
    setStatus,
    status,
    warmProgress
  } = useDatasetManifest({ promoteRecent })
  const [layerSettings, setLayerSettings] = useState<Record<string, LayerSettings>>({})
  // Effective intensity window NiiVue applied per layer (incl. auto-seeded
  // thresholds), reported back from NiivueStage so the UI can show the real
  // cutoff instead of a bare "auto".
  const [resolvedWindows, setResolvedWindows] = useState<Record<string, ResolvedWindow>>({})
  const handleResolvedWindows = useCallback(
    (next: Record<string, ResolvedWindow>) => {
      setResolvedWindows((prev) => {
        const prevKeys = Object.keys(prev)
        const nextKeys = Object.keys(next)
        const unchanged =
          prevKeys.length === nextKeys.length &&
          nextKeys.every(
            (id) =>
              prev[id] &&
              prev[id].min === next[id].min &&
              prev[id].max === next[id].max &&
              prev[id].robustMin === next[id].robustMin &&
              prev[id].robustMax === next[id].robustMax
          )
        return unchanged ? prev : next
      })
    },
    []
  )
  // Per-layer world-space bounding boxes, reported from NiivueStage after load,
  // used to flag overlays that land in a different space than the base.
  const [layerExtents, setLayerExtents] = useState<Record<string, LayerExtent>>({})
  const handleLayerExtents = useCallback((next: Record<string, LayerExtent>) => {
    setLayerExtents((prev) => (extentsEqual(prev, next) ? prev : next))
  }, [])
  const [overlayIds, setOverlayIds] = useState<Set<string>>(() => new Set())
  const [viewMode, setViewMode] = useState<ViewModeId>(DEFAULT_VIEW_MODE)
  const [atlasId, setAtlasId] = useState<string | null>(null)
  const [locationReadout, setLocationReadout] = useState<NiiVueLocation | null>(null)
  const {
    clipPlanes,
    activeClipPlaneId,
    renderWheelMode,
    activeClipPlane,
    setRenderWheelMode,
    bindActiveClipPlane,
    updateClipPlane,
    changeClipPlaneDepth,
    resetClipPlanes
  } = useClipPlanes()
  const [splitPercent, setSplitPercent] = useState(52)
  const [desktopZoom, setDesktopZoom] = useState(1)
  const [mouseContext, setMouseContext] = useState<MouseContext>(null)
  const [isFileListCollapsed, setIsFileListCollapsed] = useState(false)
  const [isControlsCollapsed, setIsControlsCollapsed] = useState(false)
  const [isRenderMaximized, setIsRenderMaximized] = useState(false)
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>('inspect')
  const [isOpeningOverlay, setIsOpeningOverlay] = useState(false)
  const [isTerminalAvailable, setIsTerminalAvailable] = useState(false)
  const [isRecentMenuOpen, setIsRecentMenuOpen] = useState(false)
  const recentMenuRef = useRef<HTMLDivElement | null>(null)
  const { isTerminalOpen, terminalHeight, toggleTerminal, setTerminalHeight } = useTerminalDock()
  const isTerminalDockOpen = isTerminalAvailable && isTerminalOpen

  useEffect(() => {
    let favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!favicon) {
      favicon = document.createElement('link')
      favicon.rel = 'icon'
      document.head.appendChild(favicon)
    }
    favicon.type = 'image/svg+xml'
    favicon.href = neurovueIconUrl
  }, [])

  useEffect(() => {
    let cancelled = false
    void resolveRuntimeCapabilities().then((capabilities) => {
      if (!cancelled) setIsTerminalAvailable(capabilities.terminalAvailable)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isRecentMenuOpen) return

    function handleMouseDown(event: MouseEvent): void {
      if (!recentMenuRef.current) return
      if (recentMenuRef.current.contains(event.target as Node)) return
      setIsRecentMenuOpen(false)
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setIsRecentMenuOpen(false)
    }

    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKey)
    }
  }, [isRecentMenuOpen])

  const {
    query,
    selectedRoles,
    selectedImageTypes,
    selectedFormats,
    selectedDtypes,
    activeFilterItemId,
    filteredItems,
    setQuery,
    setActiveFilterItemId,
    toggleRole,
    toggleImageType,
    toggleFormat,
    toggleDtype,
    clearFilters
  } = useVolumeFilters(items)

  useEffect(() => {
    clearFilters()
    setActiveFilterItemId(null)
    // Reset dataset-scoped filters when the backing dataset changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetRevision])

  const { metadata, metadataStatus } = useVolumeMetadata(selected)
  const renderLayers = useMemo<NiivueRenderLayer[]>(() => {
    if (!selected) return []

    const layers: NiivueRenderLayer[] = [
      {
        item: selected,
        kind: 'base',
        isAtlas: atlasId === selected.id,
        ...resolveColormap(
          layerColormapForItem(
            selected,
            layerSettings,
            atlasId === selected.id ? DEFAULT_ATLAS_COLORMAP : DEFAULT_BASE_COLORMAP
          )
        ),
        ...windowForItem(selected.id, layerSettings),
        // The base is always fully opaque (its row has no opacity slider); only
        // its `hidden` flag applies. Reading a stored opacity here would leak a
        // value left over from when this volume was an overlay/atlas.
        opacity: layerSettings[selected.id]?.hidden ? 0 : 1
      }
    ]

    let overlayIndex = 0
    for (const item of items) {
      if (!overlayIds.has(item.id) || item.id === selected.id || item.id === atlasId) continue
      layers.push({
        item,
        kind: 'overlay',
        ...resolveColormap(layerColormapForItem(item, layerSettings, overlayColormapForIndex(overlayIndex))),
        ...windowForItem(item.id, layerSettings),
        opacity: renderOpacityForItem(item.id, layerSettings, DEFAULT_OVERLAY_OPACITY)
      })
      overlayIndex += 1
    }

    const atlasItem = atlasId ? items.find((item) => item.id === atlasId) ?? null : null
    if (atlasItem && atlasItem.id !== selected.id) {
      layers.push({
        item: atlasItem,
        kind: 'overlay',
        isAtlas: true,
        colormap: layerColormapForItem(atlasItem, layerSettings, DEFAULT_ATLAS_COLORMAP),
        opacity: renderOpacityForItem(atlasItem.id, layerSettings, DEFAULT_ATLAS_OPACITY)
      })
    }

    return layers
  }, [atlasId, items, layerSettings, overlayIds, selected])

  useEffect(() => {
    const validIds = new Set(items.map((item) => item.id))
    setOverlayIds((current) => {
      let changed = false
      const next = new Set<string>()
      for (const id of current) {
        if (validIds.has(id) && id !== selected?.id && id !== atlasId) {
          next.add(id)
        } else {
          changed = true
        }
      }
      return changed ? next : current
    })
    setAtlasId((current) => (current && validIds.has(current) ? current : null))
    setLayerSettings((current) => {
      let changed = false
      const next: Record<string, LayerSettings> = {}
      for (const [id, settings] of Object.entries(current)) {
        if (validIds.has(id)) {
          next[id] = settings
        } else {
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [atlasId, items, selected?.id])

  function changeLayerColormap(itemId: string, nextColormap: string): void {
    setLayerSettings((current) => {
      if (current[itemId]?.colormap === nextColormap) return current
      return { ...current, [itemId]: { ...current[itemId], colormap: nextColormap } }
    })
  }

  function changeLayerWindow(itemId: string, min: number, max: number): void {
    setLayerSettings((current) => {
      const existing = current[itemId]?.window
      if (existing && existing.min === min && existing.max === max) return current
      return { ...current, [itemId]: { ...current[itemId], window: { min, max } } }
    })
  }

  function resetLayerWindow(itemId: string): void {
    setLayerSettings((current) => {
      const existing = current[itemId]
      if (!existing || existing.window === undefined) return current
      const { window: _removed, ...rest } = existing
      const next = { ...current }
      // Drop the whole entry once no other settings remain, so the map stays
      // a clean "only non-default layers" record.
      if (Object.keys(rest).length === 0) {
        delete next[itemId]
      } else {
        next[itemId] = rest
      }
      return next
    })
  }

  function changeLayerOpacity(itemId: string, opacity: number): void {
    const clamped = Math.min(1, Math.max(0, opacity))
    setLayerSettings((current) => {
      const existing = current[itemId]
      if (existing?.opacity === clamped && !existing?.hidden) return current
      // Adjusting opacity implies the layer should be visible, so clear hidden.
      return { ...current, [itemId]: { ...existing, opacity: clamped, hidden: false } }
    })
  }

  function setLayerHidden(itemId: string, hidden: boolean): void {
    setLayerSettings((current) => {
      if (!!current[itemId]?.hidden === hidden) return current
      return { ...current, [itemId]: { ...current[itemId], hidden } }
    })
  }

  useEffect(() => {
    setLocationReadout(null)
  }, [renderLayers])

  function toggleOverlayLayer(itemId: string): void {
    setOverlayIds((current) => {
      const next = new Set(current)
      if (next.has(itemId)) {
        next.delete(itemId)
      } else {
        next.add(itemId)
      }
      return next
    })
  }

  function changeAtlasLayer(itemId: string): void {
    const nextAtlasId = itemId || null
    setAtlasId(nextAtlasId)
    if (!nextAtlasId) return
    setLayerHidden(nextAtlasId, false)

    setOverlayIds((current) => {
      if (!current.has(nextAtlasId)) return current
      const next = new Set(current)
      next.delete(nextAtlasId)
      return next
    })
  }

  async function loadOverlayVolume(): Promise<void> {
    if (isOpeningOverlay) return

    setIsOpeningOverlay(true)
    setStatus('Choosing overlay volume.')
    try {
      const result = await openOverlayVolume()
      if (!result) {
        setStatus('Overlay load cancelled.')
        return
      }

      const nextManifest = await refreshDesktopManifestData()
      const overlayItem = nextManifest?.items.find((item) => item.id === result.id) ?? null
      const isAtlas = overlayItem ? await volumeHasAtlasLabelSidecar(overlayItem) : false
      if (isAtlas) {
        setAtlasId(result.id)
        setLayerHidden(result.id, false)
        setOverlayIds((current) => {
          if (!current.has(result.id)) return current
          const next = new Set(current)
          next.delete(result.id)
          return next
        })
        setStatus(`Atlas ${result.label} added with label sidecar.`)
      } else {
        setOverlayIds((current) => {
          const next = new Set(current)
          next.add(result.id)
          return next
        })
        setStatus(`Overlay ${result.label} added to every volume.`)
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsOpeningOverlay(false)
    }
  }


  useEffect(() => {
    if (!isRenderMaximized) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setIsRenderMaximized(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isRenderMaximized])

  const warmStatus = warmProgressLabel(warmProgress, datasetRoot)
  const locationStatus = useMemo(() => locationStatusLabel(locationReadout), [locationReadout])
  const slicePosition = useMemo(
    () => slicePositionLabel(locationReadout, viewMode),
    [locationReadout, viewMode]
  )

  return (
    <main
      className={`nv-app ${isTerminalDockOpen ? 'has-terminal' : ''}`}
      style={{ '--terminal-height': `${terminalHeight}px` } as CSSProperties}
    >
      <header className="nv-topbar">
        <div className="nv-brand">
          <div className="nv-mark">
            <img alt="" src={neurovueIconUrl} />
          </div>
          <div>
            <h1>NeuroVue</h1>
            <p title={[datasetRoot, bidsDatasetDoi && `DOI: ${bidsDatasetDoi}`].filter(Boolean).join(' · ') || undefined}>
              {bidsName || datasetRoot || serverUrl || 'Resolving local server'}
            </p>
          </div>
        </div>

        <div className="nv-toolbar" aria-label="Viewer controls">
          <div className="nv-open-group" ref={recentMenuRef}>
            <button
              className="nv-tool-button"
              disabled={isOpeningDataset}
              onClick={() => setIsRecentMenuOpen((open) => !open)}
              title={cacheRoot ? `Datasets. Temp cache: ${cacheRoot}` : 'Datasets'}
              type="button"
              aria-haspopup="menu"
              aria-expanded={isRecentMenuOpen}
            >
              <Database size={15} />
              <span>{isOpeningDataset ? 'Opening' : 'Datasets'}</span>
              <ChevronDown size={14} />
            </button>
            {isRecentMenuOpen ? (
              <div className="nv-recent-menu" role="menu">
                <button
                  className="nv-recent-item nv-recent-open"
                  disabled={isOpeningDataset}
                  onClick={() => {
                    setIsRecentMenuOpen(false)
                    void openLocalDataset()
                  }}
                  type="button"
                  role="menuitem"
                >
                  <FolderOpen size={14} />
                  <span className="nv-recent-item-name">Open dataset directory…</span>
                </button>
                {recentDatasets.length > 0 ? (
                  <>
                    <div className="nv-recent-divider" role="separator" />
                    {recentDatasets.map((path) => (
                      <div key={path} className="nv-recent-row">
                        <button
                          className="nv-recent-item"
                          onClick={() => {
                            setIsRecentMenuOpen(false)
                            void openRecentDataset(path)
                          }}
                          title={path}
                          type="button"
                          role="menuitem"
                        >
                          <span className="nv-recent-item-name">{recentDatasetLabel(path)}</span>
                          <span className="nv-recent-item-path">{path}</span>
                        </button>
                        <button
                          className="nv-recent-remove"
                          onClick={() => removeRecent(path)}
                          title="Remove from recents"
                          type="button"
                          aria-label={`Remove ${path} from recents`}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </>
                ) : (
                  <p className="nv-recent-empty">No recent datasets yet.</p>
                )}
              </div>
            ) : null}
          </div>

          <button
            aria-label="Reset clip planes"
            className="nv-icon-button"
            title="Reset clip planes"
            type="button"
            onClick={resetClipPlanes}
          >
            <RotateCcw size={16} />
          </button>
          <button
            aria-label="Save correction patch"
            className="nv-icon-button"
            title="Save correction patch"
            type="button"
            onClick={async () => {
              try {
                await savePatch(serverUrl, selected, clipPlanes, backend)
                setStatus(`Correction patch saved for ${selected?.label ?? 'volume'}.`)
              } catch (error) {
                setStatus(error instanceof Error ? error.message : String(error))
              }
            }}
          >
            <Save size={16} />
          </button>
          {isTerminalAvailable ? (
            <button
              aria-pressed={isTerminalOpen}
              className={`nv-icon-button ${isTerminalOpen ? 'is-active' : ''}`}
              title={isTerminalOpen ? 'Hide Python terminal' : 'Show Python terminal'}
              onClick={toggleTerminal}
              type="button"
            >
              <SquareTerminal size={16} />
            </button>
          ) : null}
        </div>
      </header>

      <section
        className={`nv-workbench ${isFileListCollapsed ? 'is-file-list-collapsed' : ''} ${
          isControlsCollapsed ? 'is-controls-collapsed' : ''
        }`}
      >
        <aside className={`nv-sidebar ${isFileListCollapsed ? 'is-collapsed' : ''}`}>
          <div className="nv-panel-heading">
            <span>
              <Database size={15} />
              <span className="nv-sidebar-title">Dataset</span>
            </span>
            <div className="nv-sidebar-heading-tools">
              <em>{filteredItems.length}/{items.length}</em>
              <button
                aria-expanded={!isFileListCollapsed}
                aria-label={isFileListCollapsed ? 'Expand dataset file list' : 'Collapse dataset file list'}
                className="nv-sidebar-toggle"
                onClick={() => setIsFileListCollapsed((collapsed) => !collapsed)}
                title={isFileListCollapsed ? 'Expand file list' : 'Collapse file list'}
                type="button"
              >
                {isFileListCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
              </button>
            </div>
          </div>

          {!isFileListCollapsed ? (
            <VolumeFilterPanel
              activeItemId={activeFilterItemId}
              filteredItems={filteredItems}
              items={items}
              query={query}
              selected={selected}
              selectedDtypes={selectedDtypes}
              selectedFormats={selectedFormats}
              selectedImageTypes={selectedImageTypes}
              selectedRoles={selectedRoles}
              onActiveItem={setActiveFilterItemId}
              onClearFilters={clearFilters}
              onQueryChange={setQuery}
              onSelect={(item) => setSelectedId(item.id)}
              onToggleDtype={toggleDtype}
              onToggleFormat={toggleFormat}
              onToggleImageType={toggleImageType}
              onToggleRole={toggleRole}
            />
          ) : null}
        </aside>

        <section
          className="nv-split-workspace"
          ref={splitRef}
          style={{ '--split-left': `${splitPercent}%` } as CSSProperties}
        >
          <section
            className={`nv-dataset-pane ${mouseContext === 'desktop' ? 'is-context-active' : ''}`}
            aria-label="OSD dataset viewer"
            onPointerEnter={() => setMouseContext('desktop')}
            onPointerLeave={() => setMouseContext(null)}
          >
            <DatasetDesktop
              items={filteredItems}
              manifest={manifest}
              selected={selected}
              isActive={mouseContext === 'desktop'}
              zoom={desktopZoom}
              onZoom={setDesktopZoom}
              onSelect={(item) => setSelectedId(item.id)}
            />
          </section>

          <button
            aria-label="Resize dataset and NiiVue panes"
            aria-valuemax={MAX_SPLIT}
            aria-valuemin={MIN_SPLIT}
            aria-valuenow={splitPercent}
            className="nv-splitter"
            onPointerDown={(event) => beginSplitDrag(event, splitRef, setSplitPercent)}
            role="separator"
            title="Resize panes"
            type="button"
          >
            <GripVertical size={16} />
          </button>

          <section
            className={`nv-niivue-pane ${mouseContext === 'niivue' ? 'is-context-active' : ''} ${isRenderMaximized ? 'is-maximized' : ''}`}
            aria-label="NiiVue render window"
            onPointerEnter={() => setMouseContext('niivue')}
            onPointerLeave={() => setMouseContext(null)}
          >
            <div className="nv-stage-title nv-niivue-title" aria-hidden="true">
              <span>NiiVue Window</span>
              <strong>{selected?.label ?? 'No selection'}</strong>
              <em>
                {viewMode !== 'render'
                  ? `${viewModeLabel(viewMode)}${slicePosition ? ` · ${slicePosition}` : ''}`
                  : renderWheelMode === 'clip-plane'
                    ? `wheel ${activeClipPlane?.label ?? 'clip'}`
                    : backend.toUpperCase()}
              </em>
            </div>
            <button
              aria-label={isRenderMaximized ? 'Exit full screen' : 'View NiiVue full screen'}
              aria-pressed={isRenderMaximized}
              className="nv-pane-icon-button nv-render-maximize"
              onClick={() => setIsRenderMaximized((value) => !value)}
              title={isRenderMaximized ? 'Exit full screen (Esc)' : 'Full screen'}
              type="button"
            >
              {isRenderMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <NiivueStage
              activeClipPlaneId={activeClipPlaneId}
              backend={backend}
              clipPlanes={clipPlanes}
              isActive={mouseContext === 'niivue'}
              item={selected}
              layers={renderLayers}
              onClipPlaneDepthChange={changeClipPlaneDepth}
              onLayerExtents={handleLayerExtents}
              onLocationChange={setLocationReadout}
              onResolvedWindows={handleResolvedWindows}
              onViewModeChange={setViewMode}
              renderWheelMode={renderWheelMode}
              viewMode={viewMode}
            />
          </section>
        </section>

        <aside
          className={`nv-controls ${isControlsCollapsed ? 'is-collapsed' : ''} ${
            isRenderMaximized ? 'is-floating' : ''
          }`}
        >
          <div className="nv-controls-toolbar">
            <button
              aria-expanded={!isControlsCollapsed}
              aria-label={isControlsCollapsed ? 'Expand controls panel' : 'Collapse controls panel'}
              className="nv-sidebar-toggle"
              onClick={() => setIsControlsCollapsed((collapsed) => !collapsed)}
              title={isControlsCollapsed ? 'Expand controls' : 'Collapse controls'}
              type="button"
            >
              {isControlsCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
            </button>
          </div>

          <div className="nv-inspector-tools" aria-label="Desktop controls">
            <DesktopZoomControls
              zoom={desktopZoom}
              onFit={() => setDesktopZoom(1)}
              onZoomIn={() => setDesktopZoom((zoom) => zoomBy(zoom, 1.25))}
              onZoomOut={() => setDesktopZoom((zoom) => zoomBy(zoom, 0.8))}
            />
            <span className="nv-zoom-readout">{Math.round(desktopZoom * 100)}%</span>
          </div>

          <SidePanelTabs activeTab={sidePanelTab} onChange={setSidePanelTab} />

          <div className="nv-sidepanel-content">
            {sidePanelTab === 'inspect' ? (
              <>
                {viewMode === 'render' ? (
                  <>
                    <section className="nv-control-section">
                      <div className="nv-panel-heading">
                        <span>
                          <ZoomIn size={15} />
                          Zoom
                        </span>
                      </div>

                      <button
                        aria-pressed={renderWheelMode === 'zoom'}
                        className={`nv-clip-card nv-zoom-card ${renderWheelMode === 'zoom' ? 'is-active' : ''}`}
                        onClick={() => setRenderWheelMode('zoom')}
                        type="button"
                      >
                        <span className="nv-clip-card-header">
                          <span className="nv-zoom-card-title">Zoom render</span>
                          {renderWheelMode === 'zoom' ? <span className="nv-clip-active-badge">wheel</span> : null}
                        </span>
                        <span className="nv-zoom-card-hint">Scroll the render to zoom in and out.</span>
                      </button>
                    </section>

                    <section className="nv-control-section">
                      <div className="nv-panel-heading">
                        <span>
                          <SlidersHorizontal size={15} />
                          Clip Planes
                        </span>
                        <em>
                          {renderWheelMode === 'clip-plane'
                            ? clipPlanes.find((plane) => plane.id === activeClipPlaneId)?.label ?? 'none'
                            : 'none'}
                        </em>
                      </div>

                      <div className="nv-clip-list">
                        {clipPlanes.map((plane) => (
                          <ClipPlaneEditor
                            active={renderWheelMode === 'clip-plane' && plane.id === activeClipPlaneId}
                            key={plane.id}
                            plane={plane}
                            onActivate={() => bindActiveClipPlane(plane.id)}
                            onChange={updateClipPlane}
                          />
                        ))}
                      </div>
                    </section>
                  </>
                ) : (
                  <section className="nv-control-section">
                    <p className="nv-mode-note">
                      Zoom and clip planes apply to the 3D render. In 2D modes, scroll to page through
                      slices and click to move the crosshair. Switch to <strong>3D</strong> for render controls.
                    </p>
                  </section>
                )}

                <LayerPanel
                  atlasId={atlasId}
                  isOpeningOverlay={isOpeningOverlay}
                  items={items}
                  layerSettings={layerSettings}
                  layerExtents={layerExtents}
                  resolvedWindows={resolvedWindows}
                  overlayIds={overlayIds}
                  selected={selected}
                  onAtlasChange={changeAtlasLayer}
                  onLayerColormapChange={changeLayerColormap}
                  onLayerHiddenChange={setLayerHidden}
                  onLayerOpacityChange={changeLayerOpacity}
                  onLayerWindowChange={changeLayerWindow}
                  onLayerWindowReset={resetLayerWindow}
                  onLoadOverlay={loadOverlayVolume}
                  onOverlayToggle={toggleOverlayLayer}
                />

                <SelectionPanel item={selected} metadataStatus={metadataStatus} />
                <MetadataPanel item={selected} metadata={metadata} status={metadataStatus} />
              </>
            ) : (
              <>
                <NiimathOperationsPanel
                  item={selected}
                  metadata={metadata}
                  onDerivedVolume={refreshDesktopManifest}
                  onStatus={setStatus}
                />
              </>
            )}
          </div>
        </aside>
      </section>

      {isTerminalDockOpen ? (
        <section className="nv-terminal-dock" aria-label="Python terminal">
          <button
            aria-label="Resize terminal"
            className="nv-hsplitter"
            onPointerDown={(event) => beginVerticalDrag(event, setTerminalHeight)}
            title="Drag to resize the terminal"
            type="button"
          >
            <GripHorizontal size={16} />
          </button>
          <TerminalPanel datasetRoot={datasetRoot} onStatus={setStatus} />
        </section>
      ) : null}

      <footer className="nv-status">
        <span>
          <CircleDot size={12} />
          {status}
        </span>
        {warmStatus ? (
          <span className="nv-warm-status">
            {warmProgress?.active ? <LoaderCircle size={12} /> : <CheckCircle2 size={12} />}
            {warmStatus}
          </span>
        ) : null}
        {locationStatus ? (
          <span className="nv-location-status" title={locationReadout?.string}>
            <Crosshair size={12} />
            {locationStatus}
          </span>
        ) : null}
        <span>{mouseContextLabel(mouseContext)}</span>
        <span
          className="nv-disclaimer"
          role="note"
          title="Research/preview tool — not a certified diagnostic device. Do not use for clinical diagnosis."
        >
          <AlertTriangle size={12} />
          Research preview — not for clinical diagnosis
        </span>
      </footer>
    </main>
  )
}

function SidePanelTabs({
  activeTab,
  onChange
}: {
  activeTab: SidePanelTab
  onChange: (tab: SidePanelTab) => void
}): JSX.Element {
  return (
    <div className="nv-sidepanel-tabs" role="tablist" aria-label="Side panel sections">
      <button
        aria-selected={activeTab === 'inspect'}
        className={activeTab === 'inspect' ? 'is-active' : ''}
        onClick={() => onChange('inspect')}
        role="tab"
        type="button"
      >
        <Eye size={14} />
        Inspect
      </button>
      <button
        aria-selected={activeTab === 'operations'}
        className={activeTab === 'operations' ? 'is-active' : ''}
        onClick={() => onChange('operations')}
        role="tab"
        type="button"
      >
        <Calculator size={14} />
        Operations
      </button>
    </div>
  )
}

function DesktopZoomControls({
  zoom,
  onFit,
  onZoomIn,
  onZoomOut
}: {
  zoom: number
  onFit: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}): JSX.Element {
  return (
    <>
      <button
        className="nv-pane-icon-button"
        disabled={zoom <= MIN_DESKTOP_ZOOM}
        onClick={onZoomOut}
        title="Zoom out"
        type="button"
      >
        <ZoomOut size={15} />
      </button>
      <button
        className="nv-pane-icon-button"
        disabled={zoom >= MAX_DESKTOP_ZOOM}
        onClick={onZoomIn}
        title="Zoom in"
        type="button"
      >
        <ZoomIn size={15} />
      </button>
      <button
        className="nv-pane-icon-button"
        disabled={zoom === 1}
        onClick={onFit}
        title="Fit grid"
        type="button"
      >
        <Maximize2 size={15} />
      </button>
    </>
  )
}

function LayerPanel({
  atlasId,
  isOpeningOverlay,
  items,
  layerSettings,
  layerExtents,
  resolvedWindows,
  overlayIds,
  selected,
  onAtlasChange,
  onLayerColormapChange,
  onLayerHiddenChange,
  onLayerOpacityChange,
  onLayerWindowChange,
  onLayerWindowReset,
  onLoadOverlay,
  onOverlayToggle
}: {
  atlasId: string | null
  isOpeningOverlay: boolean
  items: DesktopItem[]
  layerSettings: Record<string, LayerSettings>
  layerExtents: Record<string, LayerExtent>
  resolvedWindows: Record<string, ResolvedWindow>
  overlayIds: Set<string>
  selected: DesktopItem | null
  onAtlasChange: (itemId: string) => void
  onLayerColormapChange: (itemId: string, colormap: string) => void
  onLayerHiddenChange: (itemId: string, hidden: boolean) => void
  onLayerOpacityChange: (itemId: string, opacity: number) => void
  onLayerWindowChange: (itemId: string, min: number, max: number) => void
  onLayerWindowReset: (itemId: string) => void
  onLoadOverlay: () => void
  onOverlayToggle: (itemId: string) => void
}): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null | undefined>(undefined)
  const atlasCandidates = useMemo(
    () => items.slice().sort(compareAtlasCandidates),
    [items]
  )
  // Active overlay items in render order, excluding the base and atlas.
  const overlayItems = useMemo(
    () => items.filter((item) => overlayIds.has(item.id) && item.id !== selected?.id && item.id !== atlasId),
    [atlasId, items, overlayIds, selected?.id]
  )
  // Volumes not yet used by any layer — the "add overlay" pool.
  const addCandidates = useMemo(
    () => items.filter((item) => item.id !== selected?.id && item.id !== atlasId && !overlayIds.has(item.id)),
    [atlasId, items, overlayIds, selected?.id]
  )
  // The unified layer list, in NiiVue render order: base -> overlays -> atlas.
  const rows = useMemo(() => {
    const out: Array<{ item: DesktopItem; role: 'base' | 'overlay' | 'atlas' }> = []
    if (selected) out.push({ item: selected, role: 'base' })
    for (const item of overlayItems) out.push({ item, role: 'overlay' })
    const atlasItem = atlasId && atlasId !== selected?.id ? items.find((item) => item.id === atlasId) : null
    if (atlasItem) out.push({ item: atlasItem, role: 'atlas' })
    return out
  }, [atlasId, items, overlayItems, selected])
  // Every row except the base is an "extra" layer; derive it from `rows` so the
  // atlas-membership rule lives in exactly one place (see rows above).
  const extras = rows.length - (selected ? 1 : 0)
  // Exactly one row open at a time. `undefined` means the user hasn't chosen, so
  // default to the base (its controls show on load); `null` means they collapsed
  // the open row and nothing should be expanded.
  const rowIds = rows.map((row) => row.item.id)
  const expanded =
    expandedId === undefined
      ? selected?.id ?? null
      : expandedId && rowIds.includes(expandedId)
        ? expandedId
        : null
  const mismatches = rows
    .map((row) => layerWarning(selected, row.item, layerExtents))
    .filter((warning): warning is string => warning !== null)

  return (
    <section className="nv-control-section nv-layer-panel">
      <div className="nv-panel-heading">
        <span>
          <Layers size={15} />
          Layers
        </span>
        <em>{selected ? `${extras} extra` : 'none'}</em>
      </div>

      {mismatches.length > 0 ? (
        <div className="nv-layer-banner" role="alert">
          <AlertTriangle size={14} />
          <span>
            {mismatches.length === 1
              ? mismatches[0]
              : `${mismatches.length} layers may not match the base — verify subject and alignment.`}
          </span>
        </div>
      ) : null}

      {selected ? (
        <div className="nv-layer-rows">
          {rows.map(({ item, role }) => {
            const settings = layerSettings[item.id]
            const isBaseAtlas = role === 'base' && atlasId === selected.id
            const overlayIndex = role === 'overlay' ? overlayItems.findIndex((o) => o.id === item.id) : 0
            const colormapValue = layerColormapForItem(
              item,
              layerSettings,
              role === 'overlay'
                ? overlayColormapForIndex(overlayIndex)
                : isBaseAtlas
                  ? DEFAULT_ATLAS_COLORMAP
                  : DEFAULT_BASE_COLORMAP
            )
            return (
              <LayerRow
                key={item.id}
                role={role}
                label={item.label}
                meta={layerOptionMeta(item)}
                warning={layerWarning(selected, item, layerExtents)}
                hidden={!!settings?.hidden}
                expanded={expanded === item.id}
                removable={role !== 'base'}
                onToggleExpand={() => setExpandedId(expanded === item.id ? null : item.id)}
                onHiddenChange={(hidden) => onLayerHiddenChange(item.id, hidden)}
                onRemove={role === 'atlas' ? () => onAtlasChange('') : () => onOverlayToggle(item.id)}
              >
                {role === 'atlas' ? (
                  <Slider
                    label="Opacity"
                    min={0}
                    max={1}
                    step={0.05}
                    value={opacityForItem(item.id, layerSettings, DEFAULT_ATLAS_OPACITY)}
                    onChange={(value) => onLayerOpacityChange(item.id, value)}
                  />
                ) : (
                  <>
                    <LayerColormapSelect
                      ariaLabel={`Colormap for ${item.label}`}
                      itemId={item.id}
                      value={colormapValue}
                      onChange={onLayerColormapChange}
                    />
                    {role === 'overlay' ? (
                      <Slider
                        label="Opacity"
                        min={0}
                        max={1}
                        step={0.05}
                        value={opacityForItem(item.id, layerSettings, DEFAULT_OVERLAY_OPACITY)}
                        onChange={(value) => onLayerOpacityChange(item.id, value)}
                      />
                    ) : null}
                    {!isBaseAtlas ? (
                      <WindowControl
                        itemId={item.id}
                        label={item.label}
                        window={settings?.window}
                        resolved={resolvedWindows[item.id]}
                        variant={role === 'overlay' ? 'threshold' : 'window'}
                        onChange={onLayerWindowChange}
                        onReset={onLayerWindowReset}
                      />
                    ) : null}
                  </>
                )}
              </LayerRow>
            )
          })}
        </div>
      ) : null}

      <label className="nv-select nv-layer-select">
        <span>Atlas</span>
        <select
          aria-label="Atlas layer"
          disabled={!selected || atlasCandidates.length === 0}
          value={atlasId ?? ''}
          onChange={(event) => onAtlasChange(event.target.value)}
        >
          <option value="">None</option>
          {atlasCandidates.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} />
      </label>

      <button
        className="nv-layer-load-button"
        disabled={isOpeningOverlay}
        onClick={onLoadOverlay}
        type="button"
      >
        <FolderOpen size={14} />
        <span>{isOpeningOverlay ? 'Loading overlay' : 'Load overlay'}</span>
      </button>

      <div className="nv-layer-list-header">
        <span>Add overlay</span>
        <em>{addCandidates.length}</em>
      </div>
      <div className="nv-layer-list">
        {addCandidates.map((item) => (
          <button
            className="nv-layer-add-option"
            disabled={!selected}
            key={item.id}
            onClick={() => onOverlayToggle(item.id)}
            title={item.label}
            type="button"
          >
            <Plus size={13} />
            <span>
              <strong>{item.label}</strong>
              <small>{layerOptionMeta(item)}</small>
            </span>
          </button>
        ))}
        {addCandidates.length === 0 ? (
          <div className="nv-filter-empty">No overlay candidates.</div>
        ) : null}
      </div>
    </section>
  )
}

// One expandable row in the unified Layers list. The header carries the
// visibility toggle, label/role, expand caret, and (for non-base layers) a
// remove button; the role-specific controls live in the expanded body.
function LayerRow({
  role,
  label,
  meta,
  warning,
  hidden,
  expanded,
  removable,
  onToggleExpand,
  onHiddenChange,
  onRemove,
  children
}: {
  role: 'base' | 'overlay' | 'atlas'
  label: string
  meta: string
  warning?: string | null
  hidden: boolean
  expanded: boolean
  removable: boolean
  onToggleExpand: () => void
  onHiddenChange: (hidden: boolean) => void
  onRemove: () => void
  children: JSX.Element
}): JSX.Element {
  const roleLabel = role === 'base' ? 'Base' : role === 'atlas' ? 'Atlas' : 'Overlay'
  return (
    <div
      className={`nv-layer-row is-${role}${expanded ? ' is-expanded' : ''}${hidden ? ' is-hidden' : ''}${warning ? ' is-warning' : ''}`}
    >
      <div className="nv-layer-row-head">
        <button
          aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
          aria-pressed={!hidden}
          className="nv-layer-row-vis"
          onClick={() => onHiddenChange(!hidden)}
          type="button"
        >
          {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        <button
          aria-expanded={expanded}
          className="nv-layer-row-main"
          onClick={onToggleExpand}
          type="button"
        >
          <span className="nv-layer-row-title">
            <strong>{label}</strong>
            <small>
              <span className="nv-layer-role">{roleLabel}</span>
              {meta ? ` · ${meta}` : ''}
            </small>
          </span>
          {warning ? (
            <span aria-label={warning} className="nv-layer-row-warn" role="img" title={warning}>
              <AlertTriangle size={15} />
            </span>
          ) : null}
          <ChevronDown className="nv-layer-row-caret" size={15} />
        </button>
        {removable ? (
          <button
            aria-label={`Remove ${label}`}
            className="nv-layer-row-remove"
            onClick={onRemove}
            type="button"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      {expanded ? <div className="nv-layer-row-body">{children}</div> : null}
    </div>
  )
}

function LayerColormapSelect({
  ariaLabel,
  disabled = false,
  itemId,
  value,
  onChange
}: {
  ariaLabel: string
  disabled?: boolean
  itemId: string
  value: string
  onChange: (itemId: string, colormap: string) => void
}): JSX.Element {
  return (
    <label className={`nv-select nv-layer-colormap-select ${disabled ? 'is-disabled' : ''}`}>
      <span>Map</span>
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(itemId, event.target.value)}
      >
        {COLORMAP_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} />
    </label>
  )
}

// Per-layer intensity mapping (NIfTI cal_min/cal_max). Empty inputs mean
// NiiVue's robust auto range. Two variants:
//   - 'window' (base): Min/Max contrast range.
//   - 'threshold' (stat overlay): Threshold/Max, where values below the
//     threshold render transparent (NiiVue's transparent-below-calMin), so the
//     min field is the statistical threshold, not a contrast floor.
function WindowControl({
  itemId,
  label,
  window,
  resolved,
  variant = 'window',
  onChange,
  onReset
}: {
  itemId: string
  label: string
  window: { min: number; max: number } | undefined
  // The effective window NiiVue applied when none is set explicitly (its robust
  // auto range, or an overlay's auto-threshold). Shown so "auto" isn't a black
  // box — e.g. a stat overlay reveals the threshold it's hiding signal below.
  // robustMin/robustMax (when present) are the "show all" / threshold-off target.
  resolved?: ResolvedWindow
  variant?: 'window' | 'threshold'
  onChange: (itemId: string, min: number, max: number) => void
  onReset: (itemId: string) => void
}): JSX.Element {
  const isThreshold = variant === 'threshold'
  const heading = isThreshold ? 'Threshold' : 'Intensity window'
  const minLabel = isThreshold ? 'Threshold' : 'Min'
  const fmt = (value: number): string =>
    Number.isFinite(value) ? String(Number(value.toFixed(2))) : '–'
  const readout = window
    ? `${fmt(window.min)} – ${fmt(window.max)}`
    : resolved
      ? `auto · ${fmt(resolved.min)} – ${fmt(resolved.max)}`
      : 'auto'
  const minPlaceholder = resolved ? fmt(resolved.min) : 'auto'
  const maxPlaceholder = resolved ? fmt(resolved.max) : 'auto'
  const [minText, setMinText] = useState(window ? String(window.min) : '')
  const [maxText, setMaxText] = useState(window ? String(window.max) : '')

  useEffect(() => {
    setMinText(window ? String(window.min) : '')
    setMaxText(window ? String(window.max) : '')
  }, [window?.min, window?.max])

  // Commit whenever either field changes, reading both current values from
  // state (no stale closure across the two inputs). For the threshold variant a
  // blank Max means "up to the auto top", so fall back to the resolved max
  // rather than discarding the input — setting just a threshold is the common
  // case and must not look like a broken control.
  const resolvedMax = resolved?.max
  useEffect(() => {
    if (!minText.trim()) return
    const min = Number(minText)
    if (!Number.isFinite(min)) return
    const max = maxText.trim()
      ? Number(maxText)
      : isThreshold && Number.isFinite(resolvedMax)
        ? (resolvedMax as number)
        : NaN
    if (Number.isFinite(max) && min < max) {
      onChange(itemId, min, max)
    }
    // onChange/itemId are stable for a given layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minText, maxText, resolvedMax, isThreshold])

  return (
    <div className="nv-window-control">
      <div className="nv-window-heading">
        <span>{heading}</span>
        <em className={window ? '' : 'is-auto'}>{readout}</em>
      </div>
      <div className="nv-window-row">
        <label className="nv-field">
          <span>{minLabel}</span>
          <input
            aria-label={`${minLabel} for ${label}`}
            className="nv-text-input"
            inputMode="decimal"
            onChange={(event) => setMinText(event.target.value)}
            placeholder={minPlaceholder}
            type="number"
            value={minText}
          />
        </label>
        <label className="nv-field">
          <span>Max</span>
          <input
            aria-label={`Window maximum for ${label}`}
            className="nv-text-input"
            inputMode="decimal"
            onChange={(event) => setMaxText(event.target.value)}
            placeholder={maxPlaceholder}
            type="number"
            value={maxText}
          />
        </label>
        <button
          className="nv-window-reset"
          disabled={!window}
          onClick={() => onReset(itemId)}
          title="Reset to auto range"
          type="button"
        >
          Auto
        </button>
      </div>
      {isThreshold &&
      resolved &&
      Number.isFinite(resolved.robustMin) &&
      Number.isFinite(resolved.robustMax) ? (
        <button
          className="nv-window-showall"
          onClick={() =>
            onChange(itemId, resolved.robustMin as number, resolved.robustMax as number)
          }
          title="Display the full robust range with no threshold"
          type="button"
        >
          Show all (no threshold)
        </button>
      ) : null}
    </div>
  )
}

function SelectionPanel({
  item,
  metadataStatus
}: {
  item: DesktopItem | null
  metadataStatus: string
}): JSX.Element {
  return (
    <section className="nv-readout">
      <h2>
        <Eye size={15} />
        Focus
      </h2>
      {item ? (
        <dl>
          <dt>ID</dt>
          <dd>{item.id}</dd>
          <dt>Format</dt>
          <dd>{item.format}</dd>
          <dt>Image</dt>
          <dd>{volumeImageTypeLabel(item)}</dd>
          <dt>Role</dt>
          <dd>{item.role ?? 'source'}</dd>
          {item.derivedFrom ? (
            <>
              <dt>Source</dt>
              <dd>{item.derivedFrom}</dd>
            </>
          ) : null}
          <dt>Shape</dt>
          <dd>{item.shape.join(' x ')}</dd>
          <dt>Spacing</dt>
          <dd>{item.spacing.join(' x ')}</dd>
          <dt>Metadata</dt>
          <dd>{metadataStatus}</dd>
        </dl>
      ) : (
        <p>No volume selected.</p>
      )}
    </section>
  )
}

function MetadataPanel({
  item,
  metadata,
  status
}: {
  item: DesktopItem | null
  metadata: VolumeMetadata | null
  status: string
}): JSX.Element {
  const sidecars = metadata?.sidecars ?? []
  const embeddedMetadata = metadata ? volumeMetadataJson(metadata) : null

  return (
    <section className="nv-readout nv-metadata-panel">
      <h2>
        <FileJson size={15} />
        JSON Sidecars
      </h2>
      {item ? (
        <>
          <p>{status}</p>
          {metadata?.sourcePath ? (
            <dl>
              <dt>Source</dt>
              <dd className="nv-path-value" title={metadata.sourcePath}>
                {metadata.sourcePath}
              </dd>
            </dl>
          ) : null}
          {sidecars.length > 0 ? (
            <div className="nv-sidecar-list">
              {sidecars.map((sidecar) => (
                <details className="nv-sidecar" key={sidecar.path ?? sidecar.name}>
                  <summary>
                    <span>{sidecar.name}</span>
                    <em>{sidecar.kind}</em>
                  </summary>
                  <pre>{formatJsonForDisplay(sidecar.metadata)}</pre>
                </details>
              ))}
            </div>
          ) : null}
          {embeddedMetadata ? (
            <div className="nv-sidecar-list">
              <details className="nv-sidecar">
                <summary>
                  <span>metadata response</span>
                  <em>json</em>
                </summary>
                <pre>{formatJsonForDisplay(embeddedMetadata)}</pre>
              </details>
            </div>
          ) : null}
          {sidecars.length === 0 && !embeddedMetadata ? (
            <div className="nv-empty-meta">No JSON sidecar attached to this volume.</div>
          ) : null}
        </>
      ) : (
        <p>Select a volume to inspect sidecar metadata.</p>
      )}
    </section>
  )
}

function ClipPlaneEditor({
  active,
  onActivate,
  plane,
  onChange
}: {
  active: boolean
  onActivate: () => void
  plane: ClipPlane
  onChange: (plane: ClipPlane) => void
}): JSX.Element {
  const defaultPlane = defaultClipPlaneFor(plane)
  const isFlipped = isClipPlaneFlipped(plane)

  return (
    <section
      className={`nv-clip-card ${active ? 'is-active' : ''}`}
      onFocusCapture={onActivate}
      onPointerDownCapture={onActivate}
    >
      <div className="nv-clip-card-header">
        <label className="nv-toggle">
          <input
            checked={plane.enabled}
            onChange={(event) => onChange({ ...plane, enabled: event.target.checked })}
            type="checkbox"
          />
          <span>{plane.label}</span>
        </label>
        {active ? <span className="nv-clip-active-badge">wheel</span> : null}

        <button
          aria-label={`Reset ${plane.label} clip plane`}
          className="nv-pane-icon-button"
          onClick={() => onChange(defaultPlane)}
          title="Reset clip plane"
          type="button"
        >
          <RotateCcw size={14} />
        </button>
      </div>

      <label className="nv-toggle nv-clip-flip">
        <input
          checked={isFlipped}
          onChange={(event) => onChange(setClipPlaneFlipped(plane, event.target.checked))}
          type="checkbox"
        />
        <span>Flip</span>
      </label>

      <Slider label="Depth" max={1} min={-1} step={0.01} value={plane.depth} onChange={(depth) => onChange({ ...plane, depth })} />
      <Slider label="Azimuth" max={360} min={-360} step={1} value={plane.azimuth} onChange={(azimuth) => onChange({ ...plane, azimuth })} />
      <Slider label="Elevation" max={180} min={-180} step={1} value={plane.elevation} onChange={(elevation) => onChange({ ...plane, elevation })} />
    </section>
  )
}

function defaultClipPlaneFor(plane: ClipPlane): ClipPlane {
  return defaultClipPlanes().find((candidate) => candidate.id === plane.id) ?? plane
}

function setClipPlaneFlipped(plane: ClipPlane, flipped: boolean): ClipPlane {
  const defaultPlane = defaultClipPlaneFor(plane)
  const orientation = flipped ? flippedClipOrientation(defaultPlane) : defaultPlane
  return {
    ...plane,
    azimuth: orientation.azimuth,
    elevation: orientation.elevation
  }
}

function isClipPlaneFlipped(plane: ClipPlane): boolean {
  const flipped = flippedClipOrientation(defaultClipPlaneFor(plane))
  return degreesEqual(plane.azimuth, flipped.azimuth) && degreesEqual(plane.elevation, flipped.elevation)
}

function flippedClipOrientation(plane: ClipPlane): Pick<ClipPlane, 'azimuth' | 'elevation'> {
  return (
    FLIPPED_CLIP_ORIENTATIONS[plane.id] ?? {
      azimuth: plane.azimuth + 180,
      elevation: -plane.elevation
    }
  )
}

function degreesEqual(a: number, b: number): boolean {
  return Math.abs(normalizeDegrees(a) - normalizeDegrees(b)) < 0.0001
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <label className="nv-slider">
      <span>{label}</span>
      <input
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="range"
        value={value}
      />
      <code>{Number.isFinite(value) ? value.toFixed(step < 1 ? 2 : 0) : '–'}</code>
    </label>
  )
}

function beginSplitDrag(
  event: ReactPointerEvent<HTMLButtonElement>,
  workspaceRef: RefObject<HTMLElement>,
  onChange: (value: number) => void
): void {
  const workspace = workspaceRef.current
  if (!workspace) return
  const workspaceElement = workspace

  event.preventDefault()
  const handle = event.currentTarget
  const pointerId = event.pointerId

  function update(clientX: number): void {
    const rect = workspaceElement.getBoundingClientRect()
    const next = ((clientX - rect.left) / rect.width) * 100
    onChange(clamp(next, MIN_SPLIT, MAX_SPLIT))
  }

  function onMove(moveEvent: PointerEvent): void {
    update(moveEvent.clientX)
  }

  function onUp(): void {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId)
    }
  }

  update(event.clientX)
  handle.setPointerCapture(pointerId)
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

function beginVerticalDrag(
  event: ReactPointerEvent<HTMLButtonElement>,
  onChange: (value: number) => void
): void {
  event.preventDefault()
  const handle = event.currentTarget
  const pointerId = event.pointerId
  // Track the drag relative to where it started so the dock doesn't jump to the
  // pointer on grab. Dragging up (smaller clientY) grows the dock.
  const startY = event.clientY
  const startHeight = handle.parentElement?.getBoundingClientRect().height ?? 0

  function onMove(moveEvent: PointerEvent): void {
    onChange(startHeight + (startY - moveEvent.clientY))
  }

  function onUp(): void {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId)
    }
  }

  handle.setPointerCapture(pointerId)
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

async function volumeHasAtlasLabelSidecar(item: DesktopItem): Promise<boolean> {
  try {
    const metadata = await fetchVolumeMetadata(item)
    return metadataHasAtlasLabelMap(metadata)
  } catch {
    return false
  }
}

function metadataHasAtlasLabelMap(metadata: VolumeMetadata): boolean {
  if (isAtlasLabelMap(metadata as unknown as JsonValue)) return true
  return (metadata.sidecars ?? []).some((sidecar) => isAtlasLabelMap(sidecar.metadata))
}

function isAtlasLabelMap(value: JsonValue): boolean {
  if (!isJsonObject(value)) return false
  return (
    numericList(value.R) !== null &&
    numericList(value.G) !== null &&
    numericList(value.B) !== null &&
    stringList(value.labels)?.some((label) => label.trim().length > 0) === true
  )
}

function numericList(value: JsonValue | undefined): number[] | null {
  if (!Array.isArray(value)) return null
  const numbers = value.map((entry) => typeof entry === 'number' ? entry : Number(entry))
  return numbers.length > 0 && numbers.every(Number.isFinite) ? numbers : null
}

function stringList(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null
  return value.map((entry) => typeof entry === 'string' ? entry : String(entry))
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function volumeMetadataJson(metadata: VolumeMetadata): unknown | null {
  const {
    id: _id,
    label: _label,
    format: _format,
    shape: _shape,
    spacing: _spacing,
    dtype: _dtype,
    sourcePath: _sourcePath,
    sidecars: _sidecars,
    ...extra
  } = metadata

  if (extra.metadata !== undefined) return extra.metadata
  return Object.keys(extra).length > 0 ? extra : null
}

function formatJsonForDisplay(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? String(value)
  if (text.length <= 7000) return text
  return `${text.slice(0, 7000)}\n... truncated`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function viewModeLabel(mode: ViewModeId): string {
  switch (mode) {
    case 'axial':
      return 'Axial'
    case 'coronal':
      return 'Coronal'
    case 'sagittal':
      return 'Sagittal'
    case 'multiplanar':
      return 'Multiplanar'
    default:
      return '3D render'
  }
}

function mouseContextLabel(context: MouseContext): string {
  if (context === 'desktop') return 'Mouse: desktop grid controls'
  if (context === 'niivue') return 'Mouse: NiiVue controls'
  return 'Mouse: no pane'
}

// Through-plane position of the current slice, as an anatomical mm coordinate
// (RAS+, so it's correct regardless of the volume's raw voxel orientation).
// Only meaningful for the single-plane 2D modes; multiplanar/render return null.
const SLICE_THROUGH_PLANE: Record<string, { index: number; positive: string; negative: string }> = {
  axial: { index: 2, positive: 'S', negative: 'I' },
  coronal: { index: 1, positive: 'A', negative: 'P' },
  sagittal: { index: 0, positive: 'R', negative: 'L' }
}

function slicePositionLabel(location: NiiVueLocation | null, viewMode: ViewModeId): string | null {
  if (!location) return null
  const axis = SLICE_THROUGH_PLANE[viewMode]
  if (!axis) return null
  const value = location.mm[axis.index]
  if (!Number.isFinite(value)) return null
  const letter = value >= 0 ? axis.positive : axis.negative
  return `${letter} ${formatCoordinate(Math.abs(value))} mm`
}

function locationStatusLabel(location: NiiVueLocation | null): string | null {
  if (!location) return null
  const mm = formatAnatomicalCoordinates(location.mm)
  const vox = location.vox.map(formatVoxelIndex).join(', ')
  const region = locationRegion(location)
  const intensity = locationIntensity(location)
  const parts = [`${mm} mm`, `IJK ${vox}`]
  if (intensity) parts.push(`Val ${intensity}`)
  if (region) parts.push(`Region ${region}`)
  return parts.join(' / ')
}

// NiiVue reports crosshair mm in RAS+ world space: +X=Right, +Y=Anterior,
// +Z=Superior. Render the sign as anatomical letters so laterality is never
// ambiguous (the unsigned XYZ readout could not distinguish left from right).
function formatAnatomicalCoordinates(mm: number[]): string {
  const axes: Array<[string, string]> = [['R', 'L'], ['A', 'P'], ['S', 'I']]
  return mm
    .slice(0, 3)
    .map((value, index) => {
      const [positive, negative] = axes[index]
      const letter = (Number.isFinite(value) ? value : 0) >= 0 ? positive : negative
      return `${letter} ${formatCoordinate(Math.abs(value))}`
    })
    .join(' / ')
}

function locationIntensity(location: NiiVueLocation): string | null {
  if (location.values.length === 0) return null
  const single = location.values.length === 1
  const parts = location.values.map((value) => {
    const intensity = formatIntensity(value.value)
    return single ? intensity : `${value.name || value.id} ${intensity}`
  })
  return parts.join(', ')
}

function formatIntensity(value: number): string {
  if (!Number.isFinite(value)) return 'n/a'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1000 || magnitude < 0.001) return value.toExponential(2)
  return value.toFixed(magnitude >= 100 ? 1 : 3)
}

function locationRegion(location: NiiVueLocation): string | null {
  const labelled = location.values.find((value) => isRegionLabel(value.label)) ??
    location.values.find((value) => value.label && value.label.trim().length > 0)
  return labelled?.label?.trim() || null
}

function isRegionLabel(label: string | undefined): boolean {
  if (!label) return false
  const normalized = label.trim().toLowerCase()
  return normalized.length > 0 && normalized !== 'air' && normalized !== 'background'
}

function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)
}

function formatVoxelIndex(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value))
}

function warmProgressLabel(progress: WarmProgress | null, datasetRoot: string): string | null {
  if (!progress || progress.total <= 0) return null
  const datasetLabel = datasetRoot ? `${recentDatasetLabel(datasetRoot)}: ` : ''
  if (!progress.active) return `${datasetLabel}Pyramid cache ready ${progress.completed}/${progress.total}`
  const percent = Math.round((progress.completed / progress.total) * 100)
  return `${datasetLabel}Warming pyramid ${progress.completed}/${progress.total} (${percent}%)`
}

function compareAtlasCandidates(left: DesktopItem, right: DesktopItem): number {
  return atlasCandidateScore(right) - atlasCandidateScore(left) || left.label.localeCompare(right.label)
}

function layerColormapForItem(
  item: DesktopItem,
  layerSettings: Record<string, LayerSettings>,
  fallback: string
): string {
  return layerSettings[item.id]?.colormap ?? fallback
}

function overlayColormapForIndex(index: number): string {
  return DEFAULT_OVERLAY_COLORMAPS[index % DEFAULT_OVERLAY_COLORMAPS.length]
}

// The layer's stored opacity (or role default) — what the slider edits, and
// what a hidden layer reverts to when shown again.
function opacityForItem(
  itemId: string,
  layerSettings: Record<string, LayerSettings>,
  fallback: number
): number {
  const opacity = layerSettings[itemId]?.opacity
  return typeof opacity === 'number' && Number.isFinite(opacity) ? opacity : fallback
}

// The opacity actually sent to NiiVue: 0 when hidden, otherwise the stored value.
function renderOpacityForItem(
  itemId: string,
  layerSettings: Record<string, LayerSettings>,
  fallback: number
): number {
  if (layerSettings[itemId]?.hidden) return 0
  return opacityForItem(itemId, layerSettings, fallback)
}

function windowForItem(
  itemId: string,
  layerSettings: Record<string, LayerSettings>
): { calMin: number; calMax: number } | Record<string, never> {
  const window = layerSettings[itemId]?.window
  if (!window || !Number.isFinite(window.min) || !Number.isFinite(window.max) || window.min >= window.max) {
    return {}
  }
  return { calMin: window.min, calMax: window.max }
}

function atlasCandidateScore(item: DesktopItem): number {
  const text = `${item.id} ${item.label}`
  if (/(^|[_\-\s.])(atlas|aal|bigbrain|parc|parcel|parcellation|labels?|dseg|aseg|seg|annotation)([_\-\s.]|$)/i.test(text)) {
    return 2
  }
  return 0
}

function layerOptionMeta(item: DesktopItem): string {
  const base = `${volumeImageTypeLabel(item)} / ${item.shape.join(' x ')} / ${item.dtype}`
  const subject = volumeSubject(item)
  return subject ? `${subject} · ${base}` : base
}

// A layer is "suspect" against the base when both carry a BIDS subject and the
// subjects differ — the silent study-mix-up case. Returns a reason for the
// warning, or null. Geometry (shape/spacing) is shown but not warned on: legit
// co-registered overlays routinely have a different grid than the base.
function layerSubjectWarning(base: DesktopItem | null, item: DesktopItem): string | null {
  if (!base || item.id === base.id) return null
  const baseSubject = volumeSubject(base)
  const itemSubject = volumeSubject(item)
  if (baseSubject && itemSubject && baseSubject !== itemSubject) {
    const baseSession = volumeSession(base)
    const itemSession = volumeSession(item)
    const here = [itemSubject, itemSession].filter(Boolean).join(' ')
    const there = [baseSubject, baseSession].filter(Boolean).join(' ')
    return `Different subject (${here}) than the base (${there}) — verify this is the same study.`
  }
  return null
}

function extentsEqual(
  a: Record<string, LayerExtent>,
  b: Record<string, LayerExtent>
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((id) => {
    const ea = a[id]
    const eb = b[id]
    return (
      !!eb &&
      ea.min.length === eb.min.length &&
      ea.min.every((value, i) => value === eb.min[i]) &&
      ea.max.length === eb.max.length &&
      ea.max.every((value, i) => value === eb.max[i])
    )
  })
}

function boxVolume(box: LayerExtent): number {
  let volume = 1
  for (let i = 0; i < 3; i += 1) volume *= Math.max(0, box.max[i] - box.min[i])
  return volume
}

// Fraction of the smaller box that lies inside the larger one. ~1 for
// co-registered volumes even at different resolution/FOV; → 0 for volumes in a
// different space (e.g. subject-native overlay on an MNI base). Below this we
// flag a possible space mismatch — caught even when subjects aren't BIDS-known.
const SPACE_OVERLAP_MIN = 0.5

function layerSpaceWarning(
  base: LayerExtent | undefined,
  item: LayerExtent | undefined
): string | null {
  if (!base || !item || base.min.length < 3 || item.min.length < 3) return null
  let intersection = 1
  for (let i = 0; i < 3; i += 1) {
    const low = Math.max(base.min[i], item.min[i])
    const high = Math.min(base.max[i], item.max[i])
    intersection *= Math.max(0, high - low)
  }
  const smaller = Math.min(boxVolume(base), boxVolume(item))
  if (smaller <= 0) return null
  const overlap = intersection / smaller
  if (overlap < SPACE_OVERLAP_MIN) {
    return `Different space than the base (${Math.round(overlap * 100)}% world overlap) — the overlay may be mislocated.`
  }
  return null
}

// The mismatch warning for a non-base layer vs the base, if any: a known
// different BIDS subject, else a different world space. Subject takes
// precedence (more specific); space catches the non-BIDS / same-subject cases.
function layerWarning(
  base: DesktopItem | null,
  item: DesktopItem,
  layerExtents: Record<string, LayerExtent>
): string | null {
  if (!base || item.id === base.id) return null
  return (
    layerSubjectWarning(base, item) ??
    layerSpaceWarning(layerExtents[base.id], layerExtents[item.id])
  )
}

async function savePatch(
  serverUrl: string,
  item: DesktopItem | null,
  clipPlanes: ClipPlane[],
  backend: Backend
): Promise<void> {
  if (!serverUrl || !item) {
    throw new Error('Select a volume before saving a correction patch.')
  }

  const response = await fetch(`${serverUrl}/session/correction.patch.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      neurovue: '0.1.0',
      asset: {
        id: item.id,
        type: item.type,
        manifest: item.manifest
      },
      backend,
      clipPlanes: clipPlanes.filter((plane) => plane.enabled),
      savedAt: new Date().toISOString()
    })
  })
  if (!response.ok) {
    throw new Error(`Correction patch save failed with HTTP ${response.status}.`)
  }
}
