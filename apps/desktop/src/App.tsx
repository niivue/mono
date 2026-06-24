import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
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
  RotateCcw,
  Save,
  SlidersHorizontal,
  SquareTerminal,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { DatasetDesktop, MAX_DESKTOP_ZOOM, MIN_DESKTOP_ZOOM, zoomBy } from './components/DatasetDesktop'
import { NiivueStage, type NiivueRenderLayer } from './components/NiivueStage'
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
  volumeRoleLabel
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
const COLORMAP_OPTIONS = [
  { value: 'gray', label: 'Gray' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'magma', label: 'Magma' },
  { value: 'actc', label: 'ACTC' }
] as const
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
  const [layerColormaps, setLayerColormaps] = useState<Record<string, string>>({})
  const [overlayIds, setOverlayIds] = useState<Set<string>>(() => new Set())
  const [atlasId, setAtlasId] = useState<string | null>(null)
  const [isAtlasVisible, setIsAtlasVisible] = useState(true)
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
        colormap: layerColormapForItem(
          selected,
          layerColormaps,
          atlasId === selected.id ? DEFAULT_ATLAS_COLORMAP : DEFAULT_BASE_COLORMAP
        ),
        opacity: atlasId === selected.id && !isAtlasVisible ? 0 : 1
      }
    ]

    let overlayIndex = 0
    for (const item of items) {
      if (!overlayIds.has(item.id) || item.id === selected.id || item.id === atlasId) continue
      layers.push({
        item,
        kind: 'overlay',
        colormap: layerColormapForItem(item, layerColormaps, overlayColormapForIndex(overlayIndex)),
        opacity: 0.48
      })
      overlayIndex += 1
    }

    const atlasItem = atlasId ? items.find((item) => item.id === atlasId) ?? null : null
    if (atlasItem && atlasItem.id !== selected.id) {
      layers.push({
        item: atlasItem,
        kind: 'overlay',
        isAtlas: true,
        colormap: layerColormapForItem(atlasItem, layerColormaps, DEFAULT_ATLAS_COLORMAP),
        opacity: isAtlasVisible ? 0.34 : 0
      })
    }

    return layers
  }, [atlasId, isAtlasVisible, items, layerColormaps, overlayIds, selected])

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
    setLayerColormaps((current) => {
      let changed = false
      const next: Record<string, string> = {}
      for (const [id, colormap] of Object.entries(current)) {
        if (validIds.has(id)) {
          next[id] = colormap
        } else {
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [atlasId, items, selected?.id])

  function changeLayerColormap(itemId: string, nextColormap: string): void {
    setLayerColormaps((current) => {
      if (current[itemId] === nextColormap) return current
      return {
        ...current,
        [itemId]: nextColormap
      }
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
    setIsAtlasVisible(true)

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
        setIsAtlasVisible(true)
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
                {renderWheelMode === 'clip-plane'
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
              onLocationChange={setLocationReadout}
              renderWheelMode={renderWheelMode}
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

                <LayerPanel
                  atlasId={atlasId}
                  isAtlasVisible={isAtlasVisible}
                  isOpeningOverlay={isOpeningOverlay}
                  items={items}
                  layerColormaps={layerColormaps}
                  overlayIds={overlayIds}
                  selected={selected}
                  onAtlasChange={changeAtlasLayer}
                  onAtlasVisibilityChange={setIsAtlasVisible}
                  onLayerColormapChange={changeLayerColormap}
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
        <span className="nv-disclaimer" role="note">
          <AlertTriangle size={12} />
          Research/preview tool — not a certified diagnostic device. Do not use for clinical diagnosis.
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
  isAtlasVisible,
  isOpeningOverlay,
  items,
  layerColormaps,
  overlayIds,
  selected,
  onAtlasChange,
  onAtlasVisibilityChange,
  onLayerColormapChange,
  onLoadOverlay,
  onOverlayToggle
}: {
  atlasId: string | null
  isAtlasVisible: boolean
  isOpeningOverlay: boolean
  items: DesktopItem[]
  layerColormaps: Record<string, string>
  overlayIds: Set<string>
  selected: DesktopItem | null
  onAtlasChange: (itemId: string) => void
  onAtlasVisibilityChange: (visible: boolean) => void
  onLayerColormapChange: (itemId: string, colormap: string) => void
  onLoadOverlay: () => void
  onOverlayToggle: (itemId: string) => void
}): JSX.Element {
  const overlayCandidates = useMemo(
    () => items.filter((item) => item.id !== selected?.id && item.id !== atlasId),
    [atlasId, items, selected?.id]
  )
  const atlasCandidates = useMemo(
    () => items.slice().sort(compareAtlasCandidates),
    [items]
  )
  const activeOverlayIndexById = useMemo(() => {
    const indexById = new Map<string, number>()
    for (const item of items) {
      if (!overlayIds.has(item.id) || item.id === selected?.id || item.id === atlasId) continue
      indexById.set(item.id, indexById.size)
    }
    return indexById
  }, [atlasId, items, overlayIds, selected?.id])
  const extras = overlayIds.size + (atlasId && atlasId !== selected?.id ? 1 : 0)

  return (
    <section className="nv-control-section nv-layer-panel">
      <div className="nv-panel-heading">
        <span>
          <Layers size={15} />
          Layers
        </span>
        <em>{selected ? `${extras} extra` : 'none'}</em>
      </div>

      <button
        className="nv-layer-load-button"
        disabled={isOpeningOverlay}
        onClick={onLoadOverlay}
        type="button"
      >
        <FolderOpen size={14} />
        <span>{isOpeningOverlay ? 'Loading overlay' : 'Load overlay'}</span>
      </button>

      {selected ? (
        <div className="nv-layer-card">
          <div className="nv-layer-copy">
            <strong>{selected.label}</strong>
            <small>{atlasId === selected.id ? 'Base atlas' : 'Base volume'}</small>
          </div>
          <LayerColormapSelect
            ariaLabel={`Colormap for ${selected.label}`}
            itemId={selected.id}
            value={layerColormapForItem(
              selected,
              layerColormaps,
              atlasId === selected.id ? DEFAULT_ATLAS_COLORMAP : DEFAULT_BASE_COLORMAP
            )}
            onChange={onLayerColormapChange}
          />
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

      <label className={`nv-layer-visibility ${atlasId ? '' : 'is-disabled'}`}>
        <input
          checked={isAtlasVisible}
          disabled={!atlasId}
          onChange={(event) => onAtlasVisibilityChange(event.target.checked)}
          type="checkbox"
        />
        <span>Show atlas</span>
      </label>

      <div className="nv-layer-list-header">
        <span>Overlays</span>
        <em>{overlayIds.size}</em>
      </div>
      <div className="nv-layer-list">
        {overlayCandidates.map((item) => {
          const isActive = overlayIds.has(item.id)
          const activeIndex = activeOverlayIndexById.get(item.id) ?? 0
          return (
            <div className={`nv-layer-option ${isActive ? 'is-active' : ''}`} key={item.id} title={item.label}>
              <label className="nv-layer-option-toggle">
                <input
                  checked={isActive}
                  disabled={!selected}
                  onChange={() => onOverlayToggle(item.id)}
                  type="checkbox"
                />
                <span>
                  <strong>{item.label}</strong>
                  <small>{layerOptionMeta(item)}</small>
                </span>
              </label>
              <LayerColormapSelect
                ariaLabel={`Colormap for ${item.label}`}
                disabled={!selected || !isActive}
                itemId={item.id}
                value={layerColormapForItem(
                  item,
                  layerColormaps,
                  overlayColormapForIndex(activeIndex)
                )}
                onChange={onLayerColormapChange}
              />
            </div>
          )
        })}
        {overlayCandidates.length === 0 ? (
          <div className="nv-filter-empty">No overlay candidates.</div>
        ) : null}
      </div>
    </section>
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

function mouseContextLabel(context: MouseContext): string {
  if (context === 'desktop') return 'Mouse: desktop grid controls'
  if (context === 'niivue') return 'Mouse: NiiVue controls'
  return 'Mouse: no pane'
}

function locationStatusLabel(location: NiiVueLocation | null): string | null {
  if (!location) return null
  const mm = location.mm.map(formatCoordinate).join(', ')
  const vox = location.vox.map(formatVoxelIndex).join(', ')
  const region = locationRegion(location)
  return region ? `XYZ ${mm} mm / IJK ${vox} / Region ${region}` : `XYZ ${mm} mm / IJK ${vox}`
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
  layerColormaps: Record<string, string>,
  fallback: string
): string {
  return layerColormaps[item.id] ?? fallback
}

function overlayColormapForIndex(index: number): string {
  return DEFAULT_OVERLAY_COLORMAPS[index % DEFAULT_OVERLAY_COLORMAPS.length]
}

function atlasCandidateScore(item: DesktopItem): number {
  const text = `${item.id} ${item.label}`
  if (/(^|[_\-\s.])(atlas|aal|bigbrain|parc|parcel|parcellation|labels?|dseg|aseg|seg|annotation)([_\-\s.]|$)/i.test(text)) {
    return 2
  }
  return 0
}

function layerOptionMeta(item: DesktopItem): string {
  return `${volumeImageTypeLabel(item)} / ${item.shape.join(' x ')} / ${item.dtype}`
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
