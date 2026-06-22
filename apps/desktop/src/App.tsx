import {
  type CSSProperties,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { flushSync } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import {
  ChevronDown,
  CircleDot,
  Calculator,
  Database,
  Eye,
  FileJson,
  FolderOpen,
  GripVertical,
  History,
  X,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Save,
  SlidersHorizontal,
  SquareTerminal,
  Play,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { NiivueStage } from './components/NiivueStage'
import { TerminalPanel } from './components/TerminalPanel'
import type {
  Backend,
  ClipPlane,
  DatasetOpenResult,
  DesktopItem,
  DesktopManifest,
  VolumeMetadata,
  WorldRect
} from './domain/desktop'
import {
  defaultClipPlanes,
  fetchDesktopManifest,
  fetchVolumeMetadata,
  openDatasetByPath,
  openDatasetDirectory,
  resolveServerInfo,
  resolveServerUrl
} from './domain/desktop'
import { runNiimathTask, type NiimathOperation, type NiimathTaskResult } from './domain/niimath'
import { acquirePreviewSlot } from './domain/previewLoadQueue'
import neurovueIconUrl from '../src-tauri/icons/neurovue-icon.svg?url'

const MIN_SPLIT = 34
const MAX_SPLIT = 68
const MIN_DESKTOP_ZOOM = 0.5
const MAX_DESKTOP_ZOOM = 4
const SIDEBAR_PREVIEW_SIZE = 96
const DESKTOP_PREVIEW_TIERS = [96, 192, 384, 768, 1024] as const
const PREVIEW_TIER_SETTLE_MS = 180
const PREVIEW_IMAGE_VERSION = 5
const RECENT_DATASETS_KEY = 'neurovue.recentDatasets.v1'
const MAX_RECENT_DATASETS = 10
const TERMINAL_OPEN_KEY = 'neurovue.terminalOpen.v1'
const TERMINAL_HEIGHT_KEY = 'neurovue.terminalHeight.v1'
const MIN_TERMINAL_HEIGHT = 120
const MAX_TERMINAL_HEIGHT = 800
const DEFAULT_TERMINAL_HEIGHT = 280
const NIIMATH_OPERATIONS: Array<{
  id: NiimathOperation
  label: string
  needsOperand: boolean
  needsMask: boolean
  help: string
}> = [
  {
    id: 'smooth',
    label: 'Smooth',
    needsOperand: true,
    needsMask: false,
    help: 'Apply Gaussian smoothing to a temporary output volume.'
  },
  {
    id: 'threshold',
    label: 'Threshold',
    needsOperand: true,
    needsMask: false,
    help: 'Keep values above the lower threshold.'
  },
  {
    id: 'upperThreshold',
    label: 'Upper Threshold',
    needsOperand: true,
    needsMask: false,
    help: 'Keep values below the upper threshold.'
  },
  {
    id: 'binarize',
    label: 'Binarize',
    needsOperand: false,
    needsMask: false,
    help: 'Convert non-zero voxels to a binary mask.'
  },
  {
    id: 'mask',
    label: 'Apply Mask',
    needsOperand: false,
    needsMask: true,
    help: 'Apply another NIfTI volume as a mask.'
  }
]
const FLIPPED_CLIP_ORIENTATIONS: Record<string, Pick<ClipPlane, 'azimuth' | 'elevation'>> = {
  anterior: { azimuth: 0, elevation: 0 },
  inferior: { azimuth: 0, elevation: 90 },
  right: { azimuth: 270, elevation: 0 }
}
const BIDS_IMAGE_TYPE_LABELS: Record<string, string> = {
  asl: 'ASL',
  bold: 'BOLD',
  dwi: 'DWI',
  epi: 'EPI',
  fieldmap: 'Field map',
  flair: 'FLAIR',
  inplanet1: 'Inplane T1',
  inplanet2: 'Inplane T2',
  magnitude1: 'Magnitude',
  magnitude2: 'Magnitude',
  m0scan: 'M0',
  phasediff: 'Phase diff',
  pd: 'PD',
  pdw: 'PDw',
  pet: 'PET',
  sbref: 'SBRef',
  t1map: 'T1 map',
  t1rho: 'T1rho',
  t1w: 'T1w',
  t2map: 'T2 map',
  t2star: 'T2star',
  t2starmap: 'T2star map',
  t2starw: 'T2starw',
  t2w: 'T2w',
  tof: 'TOF',
  unit1: 'UNIT1'
}
type MouseContext = 'desktop' | 'niivue' | null
type SidePanelTab = 'inspect' | 'operations'
type RenderWheelMode = 'zoom' | 'clip-plane'

interface DesktopDragState {
  pointerId: number
  startX: number
  startY: number
  scrollLeft: number
  scrollTop: number
  moved: boolean
}

interface MinimapViewport {
  left: number
  top: number
  width: number
  height: number
}

function loadRecentDatasets(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_DATASETS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return []
  }
}

function persistRecentDatasets(entries: string[]): string[] {
  try {
    window.localStorage.setItem(RECENT_DATASETS_KEY, JSON.stringify(entries))
  } catch {
    // localStorage may be disabled — recents stay in-memory for this session.
  }
  return entries
}

function promoteRecentDataset(entries: string[], path: string): string[] {
  const trimmed = path.trim()
  if (!trimmed) return entries
  const filtered = entries.filter((entry) => entry !== trimmed)
  return [trimmed, ...filtered].slice(0, MAX_RECENT_DATASETS)
}

function loadTerminalOpen(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function loadTerminalHeight(): number {
  try {
    const raw = Number(window.localStorage.getItem(TERMINAL_HEIGHT_KEY))
    if (Number.isFinite(raw) && raw > 0) {
      return clamp(raw, MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT)
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_TERMINAL_HEIGHT
}

function persistTerminalOpen(open: boolean): void {
  try {
    window.localStorage.setItem(TERMINAL_OPEN_KEY, open ? '1' : '0')
  } catch {
    // localStorage may be disabled — state stays in-memory for this session.
  }
}

function persistTerminalHeight(height: number): void {
  try {
    window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(Math.round(height)))
  } catch {
    // localStorage may be disabled.
  }
}

function recentDatasetLabel(path: string): string {
  const stripped = path.replace(/\/+$/, '')
  const segments = stripped.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

export function App(): JSX.Element {
  const splitRef = useRef<HTMLElement | null>(null)
  const manifestRef = useRef<DesktopManifest | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const isOpeningDatasetRef = useRef(false)
  const [serverUrl, setServerUrl] = useState('')
  const [datasetRoot, setDatasetRoot] = useState('')
  const [cacheRoot, setCacheRoot] = useState('')
  const [manifest, setManifest] = useState<DesktopManifest | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [backend, setBackend] = useState<Backend>('webgl2')
  const [colormap, setColormap] = useState('gray')
  const [clipPlanes, setClipPlanes] = useState(defaultClipPlanes)
  const [status, setStatus] = useState('Starting NeuroVue.')
  const [metadataStatus, setMetadataStatus] = useState('No metadata loaded.')
  const [metadata, setMetadata] = useState<VolumeMetadata | null>(null)
  const [query, setQuery] = useState('')
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(() => new Set())
  const [selectedImageTypes, setSelectedImageTypes] = useState<Set<string>>(() => new Set())
  const [selectedFormats, setSelectedFormats] = useState<Set<string>>(() => new Set())
  const [selectedDtypes, setSelectedDtypes] = useState<Set<string>>(() => new Set())
  const [activeFilterItemId, setActiveFilterItemId] = useState<string | null>(null)
  const [splitPercent, setSplitPercent] = useState(52)
  const [desktopZoom, setDesktopZoom] = useState(1)
  const [mouseContext, setMouseContext] = useState<MouseContext>(null)
  const [isFileListCollapsed, setIsFileListCollapsed] = useState(false)
  const [isRenderMaximized, setIsRenderMaximized] = useState(false)
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>('inspect')
  // Empty until a clip plane is selected — the wheel starts bound to zoom, so no
  // plane should read as the wheel's target on first load.
  const [activeClipPlaneId, setActiveClipPlaneId] = useState('')
  const [renderWheelMode, setRenderWheelMode] = useState<RenderWheelMode>('zoom')
  const [isOpeningDataset, setIsOpeningDataset] = useState(false)
  const [recentDatasets, setRecentDatasets] = useState<string[]>(() => loadRecentDatasets())
  const [isRecentMenuOpen, setIsRecentMenuOpen] = useState(false)
  const recentMenuRef = useRef<HTMLDivElement | null>(null)
  const [isTerminalOpen, setIsTerminalOpen] = useState<boolean>(() => loadTerminalOpen())
  const [terminalHeight, setTerminalHeight] = useState<number>(() => loadTerminalHeight())

  function toggleTerminal(): void {
    setIsTerminalOpen((open) => {
      const next = !open
      persistTerminalOpen(next)
      return next
    })
  }

  function updateTerminalHeight(height: number): void {
    const clamped = clamp(height, MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT)
    setTerminalHeight(clamped)
    persistTerminalHeight(clamped)
  }

  useEffect(() => {
    manifestRef.current = manifest
  }, [manifest])

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

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

    async function load(): Promise<void> {
      try {
        const serverInfo = await resolveServerInfo()
        const resolved = serverInfo?.url ?? await resolveServerUrl()
        if (cancelled) return
        setServerUrl(resolved)
        setDatasetRoot(serverInfo?.datasetRoot ?? '')
        setCacheRoot(serverInfo?.cacheRoot ?? '')
        const nextManifest = await fetchDesktopManifest(resolved)
        if (cancelled) return
        setManifest(nextManifest)
        setSelectedId(nextManifest.items[0]?.id ?? null)
        setStatus(`${nextManifest.itemCount} volume item(s) loaded.`)
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | null = null

    void listen('neurovue-open-directory', () => {
      void openLocalDataset()
    }).then((nextUnlisten) => {
      unlisten = nextUnlisten
    }).catch(() => {
      unlisten = null
    })

    return () => {
      unlisten?.()
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

  const items = manifest?.items ?? []
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null
  const activeClipPlane = clipPlanes.find((plane) => plane.id === activeClipPlaneId) ?? clipPlanes[0]
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return items.filter((item) => {
      if (selectedRoles.size > 0 && !selectedRoles.has(volumeRoleLabel(item))) return false
      if (selectedImageTypes.size > 0 && !selectedImageTypes.has(volumeImageTypeLabel(item))) return false
      if (selectedFormats.size > 0 && !selectedFormats.has(volumeFacetValue(item.format))) return false
      if (selectedDtypes.size > 0 && !selectedDtypes.has(volumeFacetValue(item.dtype))) return false
      if (!normalized) return true
      return volumeSearchText(item).includes(normalized)
    })
  }, [items, query, selectedDtypes, selectedFormats, selectedImageTypes, selectedRoles])

  useEffect(() => {
    let cancelled = false

    async function loadMetadata(item: DesktopItem): Promise<void> {
      setMetadata(null)
      setMetadataStatus('Loading metadata.')
      try {
        const nextMetadata = await fetchVolumeMetadata(item)
        if (cancelled) return
        const sidecarCount = nextMetadata.sidecars?.length ?? 0
        setMetadata(nextMetadata)
        setMetadataStatus(
          sidecarCount > 0
            ? `${sidecarCount} JSON sidecar${sidecarCount === 1 ? '' : 's'} loaded.`
            : 'No JSON sidecars discovered.'
        )
      } catch (error) {
        if (cancelled) return
        setMetadata(null)
        setMetadataStatus(error instanceof Error ? error.message : String(error))
      }
    }

    if (!selected) {
      setMetadata(null)
      setMetadataStatus('No volume selected.')
      return () => {
        cancelled = true
      }
    }

    void loadMetadata(selected)
    return () => {
      cancelled = true
    }
  }, [selected?.id, selected?.metadata])

  async function refreshDesktopManifest(selectId?: string): Promise<void> {
    if (!serverUrl) return
    const nextManifest = await fetchDesktopManifest(serverUrl)
    setManifest(nextManifest)
    if (selectId && nextManifest.items.some((item) => item.id === selectId)) {
      setSelectedId(selectId)
    }
    setStatus(`${nextManifest.itemCount} volume item(s) loaded.`)
  }

  async function applyDatasetOpenResult(result: DatasetOpenResult): Promise<void> {
    setManifest(null)
    setSelectedId(null)
    setMetadata(null)
    setMetadataStatus('No metadata loaded.')
    setServerUrl(result.url)
    setDatasetRoot(result.datasetRoot)
    setCacheRoot(result.cacheRoot)
    setQuery('')
    setSelectedRoles(new Set())
    setSelectedImageTypes(new Set())
    setSelectedFormats(new Set())
    setSelectedDtypes(new Set())
    setActiveFilterItemId(null)
    setStatus(`Loading ${result.datasetRoot}.`)

    const nextManifest = await fetchDesktopManifest(result.url)
    setManifest(nextManifest)
    setSelectedId(nextManifest.items[0]?.id ?? null)
    setStatus(`${nextManifest.itemCount} volume item(s) loaded from ${result.datasetRoot}.`)
    setRecentDatasets((previous) => persistRecentDatasets(promoteRecentDataset(previous, result.datasetRoot)))
  }

  async function openLocalDataset(): Promise<void> {
    if (isOpeningDatasetRef.current) return

    isOpeningDatasetRef.current = true
    setIsOpeningDataset(true)
    setStatus('Choosing dataset directory.')
    try {
      const result = await openDatasetDirectory()
      if (!result) {
        setStatus('Open directory cancelled.')
        return
      }
      await applyDatasetOpenResult(result)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      isOpeningDatasetRef.current = false
      setIsOpeningDataset(false)
    }
  }

  async function openRecentDataset(path: string): Promise<void> {
    if (isOpeningDatasetRef.current) return

    isOpeningDatasetRef.current = true
    setIsOpeningDataset(true)
    setIsRecentMenuOpen(false)
    setStatus(`Opening ${path}.`)
    try {
      const result = await openDatasetByPath(path)
      await applyDatasetOpenResult(result)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      isOpeningDatasetRef.current = false
      setIsOpeningDataset(false)
    }
  }

  function removeRecentDataset(path: string): void {
    setRecentDatasets((previous) => persistRecentDatasets(previous.filter((entry) => entry !== path)))
  }

  function bindActiveClipPlane(planeId: string): void {
    setActiveClipPlaneId(planeId)
    setRenderWheelMode('clip-plane')
  }

  useEffect(() => {
    if (!isRenderMaximized) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setIsRenderMaximized(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isRenderMaximized])

  function changeClipPlaneDepth(planeId: string, depth: number): void {
    setClipPlanes((planes) =>
      planes.map((plane) => (plane.id === planeId ? { ...plane, depth } : plane))
    )
  }

  function updateClipPlane(plane: ClipPlane): void {
    bindActiveClipPlane(plane.id)
    setClipPlanes((planes) =>
      planes.map((candidate) => candidate.id === plane.id ? plane : candidate)
    )
  }

  useEffect(() => {
    if (!serverUrl) return
    let cancelled = false

    async function refreshChangedManifest(): Promise<void> {
      try {
        const nextManifest = await fetchDesktopManifest(serverUrl)
        if (cancelled) return
        const currentManifest = manifestRef.current
        if (
          currentManifest &&
          desktopManifestSignature(currentManifest) === desktopManifestSignature(nextManifest)
        ) {
          return
        }

        setManifest(nextManifest)
        const currentSelectedId = selectedIdRef.current
        if (!currentSelectedId || !nextManifest.items.some((item) => item.id === currentSelectedId)) {
          setSelectedId(nextManifest.items[0]?.id ?? null)
        }
        setStatus(`${nextManifest.itemCount} volume item(s) loaded.`)
      } catch {
        const serverInfo = await resolveServerInfo()
        if (cancelled || !serverInfo || serverInfo.url === serverUrl) return

        setServerUrl(serverInfo.url)
        setDatasetRoot(serverInfo.datasetRoot ?? '')
        setCacheRoot(serverInfo.cacheRoot ?? '')
      }
    }

    void refreshChangedManifest()
    const interval = window.setInterval(() => {
      void refreshChangedManifest()
    }, 5000)
    window.addEventListener('focus', refreshChangedManifest)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshChangedManifest)
    }
  }, [serverUrl])

  return (
    <main
      className={`nv-app ${isTerminalOpen ? 'has-terminal' : ''}`}
      style={{ '--terminal-height': `${terminalHeight}px` } as CSSProperties}
    >
      <header className="nv-topbar">
        <div className="nv-brand">
          <div className="nv-mark">
            <img alt="" src={neurovueIconUrl} />
          </div>
          <div>
            <h1>NeuroVue</h1>
            <p>{datasetRoot || serverUrl || 'Resolving local server'}</p>
          </div>
        </div>

        <div className="nv-toolbar" aria-label="Viewer controls">
          <div className="nv-open-group" ref={recentMenuRef}>
            <button
              className="nv-tool-button"
              disabled={isOpeningDataset}
              onClick={() => void openLocalDataset()}
              title={cacheRoot ? `Open dataset directory. Temp cache: ${cacheRoot}` : 'Open dataset directory'}
              type="button"
            >
              <FolderOpen size={15} />
              <span>{isOpeningDataset ? 'Opening' : 'Open'}</span>
            </button>
            <button
              className="nv-icon-button"
              disabled={isOpeningDataset}
              onClick={() => setIsRecentMenuOpen((open) => !open)}
              title="Recent datasets"
              type="button"
              aria-haspopup="menu"
              aria-expanded={isRecentMenuOpen}
            >
              <History size={15} />
            </button>
            {isRecentMenuOpen ? (
              <div className="nv-recent-menu" role="menu">
                {recentDatasets.length === 0 ? (
                  <p className="nv-recent-empty">No recent datasets yet.</p>
                ) : (
                  recentDatasets.map((path) => (
                    <div key={path} className="nv-recent-row">
                      <button
                        className="nv-recent-item"
                        onClick={() => void openRecentDataset(path)}
                        title={path}
                        type="button"
                        role="menuitem"
                      >
                        <span className="nv-recent-item-name">{recentDatasetLabel(path)}</span>
                        <span className="nv-recent-item-path">{path}</span>
                      </button>
                      <button
                        className="nv-recent-remove"
                        onClick={() => removeRecentDataset(path)}
                        title="Remove from recents"
                        type="button"
                        aria-label={`Remove ${path} from recents`}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div className="nv-segmented" aria-label="Backend">
            <button
              className={backend === 'webgl2' ? 'is-active' : ''}
              onClick={() => setBackend('webgl2')}
              type="button"
            >
              WebGL2
            </button>
            <button
              className={backend === 'webgpu' ? 'is-active' : ''}
              onClick={() => setBackend('webgpu')}
              type="button"
            >
              WebGPU
            </button>
          </div>

          <label className="nv-select">
            <span>Map</span>
            <select value={colormap} onChange={(event) => setColormap(event.target.value)}>
              <option value="gray">Gray</option>
              <option value="viridis">Viridis</option>
              <option value="magma">Magma</option>
              <option value="actc">ACTC</option>
            </select>
            <ChevronDown size={14} />
          </label>

          <button
            aria-label="Reset clip planes"
            className="nv-icon-button"
            title="Reset clip planes"
            type="button"
            onClick={() => setClipPlanes(defaultClipPlanes())}
          >
            <RotateCcw size={16} />
          </button>
          <button
            aria-label="Save correction patch"
            className="nv-icon-button"
            title="Save correction patch"
            type="button"
            onClick={() => void savePatch(serverUrl, selected, clipPlanes, backend)}
          >
            <Save size={16} />
          </button>
          <button
            aria-pressed={isTerminalOpen}
            className={`nv-icon-button ${isTerminalOpen ? 'is-active' : ''}`}
            title={isTerminalOpen ? 'Hide Python terminal' : 'Show Python terminal'}
            onClick={toggleTerminal}
            type="button"
          >
            <SquareTerminal size={16} />
          </button>
        </div>
      </header>

      <section className={`nv-workbench ${isFileListCollapsed ? 'is-file-list-collapsed' : ''}`}>
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
              onClearFilters={() => {
                setQuery('')
                setSelectedRoles(new Set())
                setSelectedImageTypes(new Set())
                setSelectedFormats(new Set())
                setSelectedDtypes(new Set())
              }}
              onQueryChange={setQuery}
              onSelect={(item) => setSelectedId(item.id)}
              onToggleDtype={(value) => toggleFilterSet(setSelectedDtypes, value)}
              onToggleFormat={(value) => toggleFilterSet(setSelectedFormats, value)}
              onToggleImageType={(value) => toggleFilterSet(setSelectedImageTypes, value)}
              onToggleRole={(value) => toggleFilterSet(setSelectedRoles, value)}
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
              colormap={colormap}
              isActive={mouseContext === 'niivue'}
              item={selected}
              onClipPlaneDepthChange={changeClipPlaneDepth}
              renderWheelMode={renderWheelMode}
            />
          </section>
        </section>

        <aside className="nv-controls">
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

                <SelectionPanel item={selected} metadataStatus={metadataStatus} />
                <MetadataPanel item={selected} metadata={metadata} status={metadataStatus} />
              </>
            ) : (
              <NiimathOperationsPanel
                item={selected}
                metadata={metadata}
                onDerivedVolume={refreshDesktopManifest}
                onStatus={setStatus}
              />
            )}
          </div>
        </aside>
      </section>

      {isTerminalOpen ? (
        <section className="nv-terminal-dock" aria-label="Python terminal">
          <button
            aria-label="Resize terminal"
            className="nv-hsplitter"
            onPointerDown={(event) => beginVerticalDrag(event, updateTerminalHeight)}
            title="Resize terminal"
            type="button"
          >
            <GripVertical size={16} />
          </button>
          <TerminalPanel datasetRoot={datasetRoot} onStatus={setStatus} />
        </section>
      ) : null}

      <footer className="nv-status">
        <span>
          <CircleDot size={12} />
          {status}
        </span>
        <span>{mouseContextLabel(mouseContext)}</span>
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

function VolumeFilterPanel({
  activeItemId,
  filteredItems,
  items,
  query,
  selected,
  selectedDtypes,
  selectedFormats,
  selectedImageTypes,
  selectedRoles,
  onActiveItem,
  onClearFilters,
  onQueryChange,
  onSelect,
  onToggleDtype,
  onToggleFormat,
  onToggleImageType,
  onToggleRole
}: {
  activeItemId: string | null
  filteredItems: DesktopItem[]
  items: DesktopItem[]
  query: string
  selected: DesktopItem | null
  selectedDtypes: Set<string>
  selectedFormats: Set<string>
  selectedImageTypes: Set<string>
  selectedRoles: Set<string>
  onActiveItem: (id: string | null) => void
  onClearFilters: () => void
  onQueryChange: (query: string) => void
  onSelect: (item: DesktopItem) => void
  onToggleDtype: (value: string) => void
  onToggleFormat: (value: string) => void
  onToggleImageType: (value: string) => void
  onToggleRole: (value: string) => void
}): JSX.Element {
  const roleCounts = useMemo(() => volumeFacetCounts(items, volumeRoleLabel), [items])
  const imageTypeCounts = useMemo(() => volumeFacetCounts(items, volumeImageTypeLabel), [items])
  const formatCounts = useMemo(
    () => volumeFacetCounts(items, (item) => volumeFacetValue(item.format)),
    [items]
  )
  const dtypeCounts = useMemo(
    () => volumeFacetCounts(items, (item) => volumeFacetValue(item.dtype)),
    [items]
  )
  const activeItem =
    filteredItems.find((item) => item.id === activeItemId) ??
    (selected && filteredItems.some((item) => item.id === selected.id) ? selected : null) ??
    filteredItems[0] ??
    null
  const hasFilters =
    query.trim().length > 0 ||
    selectedRoles.size > 0 ||
    selectedImageTypes.size > 0 ||
    selectedFormats.size > 0 ||
    selectedDtypes.size > 0

  return (
    <div className="nv-volume-filter">
      <section className="nv-volume-filter-panel nv-volume-filter-facets" aria-label="Volume filters">
        <div className="nv-filter-search-row">
          <input
            className="nv-search"
            placeholder="Filter volumes"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <button
            className="nv-filter-clear"
            disabled={!hasFilters}
            onClick={onClearFilters}
            type="button"
          >
            Clear
          </button>
        </div>

        <VolumeFacetGroup
          counts={roleCounts}
          selected={selectedRoles}
          title="Role"
          onToggle={onToggleRole}
        />
        <VolumeFacetGroup
          counts={imageTypeCounts}
          selected={selectedImageTypes}
          title="Image"
          onToggle={onToggleImageType}
        />
        <VolumeFacetGroup
          counts={formatCounts}
          selected={selectedFormats}
          title="Format"
          onToggle={onToggleFormat}
        />
        <VolumeFacetGroup
          counts={dtypeCounts}
          selected={selectedDtypes}
          title="Dtype"
          onToggle={onToggleDtype}
        />
      </section>

      <section className="nv-volume-filter-panel nv-volume-results-panel" aria-label="Filtered volumes">
        <div className="nv-filter-panel-title">
          <span>Volumes</span>
          <em>{filteredItems.length}</em>
        </div>

        <div className="nv-volume-list">
          {filteredItems.map((item) => (
            <button
              className={`nv-volume-card ${selected?.id === item.id ? 'is-selected' : ''}`}
              key={item.id}
              onClick={() => onSelect(item)}
              onFocus={() => onActiveItem(item.id)}
              onMouseEnter={() => onActiveItem(item.id)}
              type="button"
            >
              <StablePreviewImage
                src={previewImageForSize(item, SIDEBAR_PREVIEW_SIZE)}
                frameClassName="nv-volume-thumb"
              />
              <span>
                <strong>{item.label}</strong>
                <small>{volumeImageTypeLabel(item)} / {item.shape.join(' x ')} / {item.dtype}</small>
              </span>
            </button>
          ))}
          {filteredItems.length === 0 ? (
            <div className="nv-filter-empty">No matching volumes.</div>
          ) : null}
        </div>
      </section>

      <VolumeFilterDetails item={activeItem} />
    </div>
  )
}

function VolumeFacetGroup({
  counts,
  selected,
  title,
  onToggle
}: {
  counts: Map<string, number>
  selected: Set<string>
  title: string
  onToggle: (value: string) => void
}): JSX.Element {
  const entries = Array.from(counts.entries()).sort((left, right) => left[0].localeCompare(right[0]))

  return (
    <div className="nv-filter-facet-group">
      <div className="nv-filter-panel-title">
        <span>{title}</span>
        <em>{selected.size > 0 ? selected.size : 'all'}</em>
      </div>
      <div className="nv-filter-facet-options">
        {entries.map(([value, count]) => (
          <label className="nv-filter-facet-option" key={value} title={value}>
            <input
              checked={selected.has(value)}
              onChange={() => onToggle(value)}
              type="checkbox"
            />
            <span>{value}</span>
            <em>{count}</em>
          </label>
        ))}
        {entries.length === 0 ? <div className="nv-filter-empty">None</div> : null}
      </div>
    </div>
  )
}

function VolumeFilterDetails({ item }: { item: DesktopItem | null }): JSX.Element {
  return (
    <section className="nv-volume-filter-panel nv-volume-filter-details" aria-label="Volume metadata">
      <div className="nv-filter-panel-title">
        <span>Metadata</span>
        <em>{item ? volumeRoleLabel(item) : 'none'}</em>
      </div>

      {item ? (
        <dl>
          <dt>Label</dt>
          <dd title={item.label}>{item.label}</dd>
          <dt>ID</dt>
          <dd title={item.id}>{item.id}</dd>
          <dt>Format</dt>
          <dd>{volumeFacetValue(item.format)}</dd>
          <dt>Image</dt>
          <dd>{volumeImageTypeLabel(item)}</dd>
          <dt>Dtype</dt>
          <dd>{volumeFacetValue(item.dtype)}</dd>
          <dt>Shape</dt>
          <dd>{item.shape.join(' x ')}</dd>
          <dt>Spacing</dt>
          <dd>{item.spacing.join(' x ')}</dd>
          {item.derivedFrom ? (
            <>
              <dt>Source</dt>
              <dd title={item.derivedFrom}>{item.derivedFrom}</dd>
            </>
          ) : null}
          {item.derivation?.operation ? (
            <>
              <dt>Operation</dt>
              <dd>{item.derivation.operation}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <div className="nv-filter-empty">No volume selected.</div>
      )}
    </section>
  )
}

function DatasetDesktop({
  manifest,
  items,
  selected,
  isActive,
  zoom,
  onZoom,
  onSelect
}: {
  manifest: DesktopManifest | null
  items: DesktopItem[]
  selected: DesktopItem | null
  isActive: boolean
  zoom: number
  onZoom: (zoom: number) => void
  onSelect: (item: DesktopItem) => void
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const minimapRef = useRef<HTMLButtonElement | null>(null)
  const zoomRef = useRef(zoom)
  const dragRef = useRef<DesktopDragState | null>(null)
  const suppressClickRef = useRef(false)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [viewport, setViewport] = useState<MinimapViewport>({
    left: 0,
    top: 0,
    width: 100,
    height: 100
  })
  const world = manifest?.world ?? {
    width: 1,
    height: 1,
    units: 'desktop-px',
    columns: 0,
    rows: 0
  }
  const tileSize = manifest?.tileSize ?? 1024
  const gap = manifest?.gap ?? 96
  const desktopLayout = useMemo(
    () => normalizeDesktopLayout(items, world, tileSize, gap),
    [gap, items, tileSize, world]
  )
  const layoutItems = desktopLayout.items
  const layoutWorld = desktopLayout.world
  const selectedLayoutItem = selected
    ? layoutItems.find((item) => item.id === selected.id) ?? selected
    : null
  const selectedStyle = selectedLayoutItem ? worldRectStyle(selectedLayoutItem.bounds, layoutWorld) : undefined
  const targetPreviewSize = useMemo(
    () => desktopPreviewSize(stageSize, layoutWorld, tileSize, zoom),
    [layoutWorld, stageSize, tileSize, zoom]
  )
  const [previewSize, setPreviewSize] = useState<number>(SIDEBAR_PREVIEW_SIZE)
  const previewLevel = previewLevelForSize(previewSize, layoutItems[0])
  const worldSize = useMemo(
    () => fittedWorldSize(stageSize, layoutWorld, zoom),
    [stageSize, layoutWorld, zoom]
  )
  const sections = useMemo(
    () => desktopSections(layoutItems, layoutWorld),
    [layoutItems, layoutWorld.height, layoutWorld.width]
  )
  const derivedSourceId = selectedLayoutItem && isDerivedItem(selectedLayoutItem)
    ? selectedLayoutItem.derivedFrom
    : null
  const derivedSource = derivedSourceId
    ? layoutItems.find((item) => item.id === derivedSourceId) ?? null
    : null
  const sourceStyle = derivedSource ? worldRectStyle(derivedSource.bounds, layoutWorld) : undefined
  const isOverview = renderedDesktopTileSize(worldSize, layoutWorld, tileSize) < 112

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPreviewSize(targetPreviewSize)
    }, PREVIEW_TIER_SETTLE_MS)

    return () => window.clearTimeout(timeout)
  }, [targetPreviewSize])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const stageElement = stage
    const minimap = minimapRef.current

    function onWheel(event: WheelEvent): void {
      zoomRef.current = zoomDesktopWithWheel(event, stageElement, zoomRef.current, onZoom)
    }

    stageElement.addEventListener('wheel', onWheel, { passive: false })
    minimap?.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      stageElement.removeEventListener('wheel', onWheel)
      minimap?.removeEventListener('wheel', onWheel)
    }
  }, [onZoom])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      updateDesktopViewport(stageRef.current, setViewport)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [layoutItems.length, stageSize.height, stageSize.width, worldSize, zoom])

  return (
    <div className={`nv-osd-stage ${isOverview ? 'is-overview' : ''}`}>
      <div
        className={`nv-osd-scrollport ${isPanning ? 'is-panning' : ''}`}
        onClickCapture={(event) => suppressDesktopClickAfterDrag(event, suppressClickRef)}
        onPointerDown={(event) =>
          beginDesktopPan(event, dragRef, suppressClickRef, setIsPanning)
        }
        onScroll={() => updateDesktopViewport(stageRef.current, setViewport)}
        ref={stageRef}
      >
        <StageResizeObserver stageRef={stageRef} onResize={setStageSize} />
        <div className="nv-osd-world" style={worldSize}>
          {sections.map((section) => (
            <div
              aria-hidden="true"
              className={`nv-osd-section nv-osd-section-${section.id}`}
              key={section.id}
              style={worldRectStyle(section.bounds, layoutWorld)}
            />
          ))}
          {layoutItems.map((item) => (
            <button
              className={desktopTileClassName(item, selected, derivedSourceId)}
              key={item.id}
              onClick={() => onSelect(item)}
              style={worldRectStyle(item.bounds, layoutWorld)}
              type="button"
            >
              <StablePreviewImage
                src={previewImageForSize(item, previewSize)}
                frameClassName="nv-osd-image-frame"
                draggable={false}
              />
              <span className="nv-osd-index">{isDerivedItem(item) ? 'D' : 'L0'}</span>
              <span className="nv-osd-label">{item.label}</span>
            </button>
          ))}
          {sections.map((section) => (
            <div
              aria-hidden="true"
              className={`nv-osd-section-label nv-osd-section-label-${section.id}`}
              key={`${section.id}-label`}
              style={worldRectStyle(section.bounds, layoutWorld)}
            >
              <span>{section.label}</span>
              <em>{section.count}</em>
            </div>
          ))}
          {layoutItems.length === 0 ? <div className="nv-empty-state">No matching volumes.</div> : null}
        </div>
      </div>

      <div className="nv-stage-title nv-osd-title" aria-hidden="true">
        <span>OSD Desktop</span>
        <strong>{manifest?.label ?? 'VolumeDesktop'}</strong>
        <em>{isActive ? 'mouse' : `${Math.round(zoom * 100)}%`}</em>
      </div>

      <footer className="nv-osd-footer" aria-hidden="true">
        <div className="nv-hud">
          <span>zoom {Math.round(zoom * 100)}%</span>
          <span>LOD L{previewLevel}</span>
          <span>{previewSize}px previews</span>
          <span>{layoutItems.length} visible</span>
          <span>{layoutWorld.width} x {layoutWorld.height}</span>
        </div>
        {derivedSource ? (
          <div className="nv-osd-source-key">
            <span className="nv-osd-source-swatch" />
            <strong>Original</strong>
            <span>{derivedSource.label}</span>
          </div>
        ) : (
          <div className="nv-osd-source-key is-muted">
            <span className="nv-osd-source-swatch" />
            <strong>Original</strong>
            <span>none selected</span>
          </div>
        )}
      </footer>

      <button
        aria-label="Click to center the desktop dataset"
        className="nv-minimap"
        onClick={(event) => jumpDesktopToMinimapPoint(event, stageRef, setViewport)}
        onPointerDown={(event) => event.stopPropagation()}
        ref={minimapRef}
        title="Click to center desktop"
        type="button"
      >
        <span className="nv-minimap-map" aria-hidden="true">
          {sourceStyle ? <span className="nv-minimap-source" style={sourceStyle} /> : null}
          {selectedStyle ? <span className="nv-minimap-selection" style={selectedStyle} /> : null}
          <span className="nv-minimap-window" style={minimapViewportStyle(viewport)} />
        </span>
      </button>
    </div>
  )
}

function desktopTileClassName(
  item: DesktopItem,
  selected: DesktopItem | null,
  derivedSourceId: string | null | undefined
): string {
  return [
    'nv-osd-tile',
    selected?.id === item.id ? 'is-selected' : '',
    isDerivedItem(item) ? 'is-derived' : '',
    derivedSourceId === item.id ? 'is-derived-source' : ''
  ]
    .filter(Boolean)
    .join(' ')
}

function isDerivedItem(item: DesktopItem): boolean {
  return item.role === 'derived' || Boolean(item.derivedFrom || item.derivation)
}

function volumeRoleLabel(item: DesktopItem): string {
  return isDerivedItem(item) ? 'Derived' : 'Source'
}

function volumeImageTypeLabel(item: DesktopItem): string {
  const tokens = volumeIdentityCandidates(item).flatMap(volumeIdentityTokens)
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const label = BIDS_IMAGE_TYPE_LABELS[tokens[index]]
    if (label) return label
  }
  return 'Unknown'
}

function volumeFacetValue(value: string | null | undefined): string {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : 'Unknown'
}

function volumeSearchText(item: DesktopItem): string {
  return [
    item.label,
    item.id,
    item.type,
    item.format,
    item.dtype,
    volumeRoleLabel(item),
    volumeImageTypeLabel(item),
    item.shape.join(' x '),
    item.spacing.join(' x '),
    item.derivedFrom ?? '',
    item.derivation?.operation ?? ''
  ]
    .join(' ')
    .toLowerCase()
}

function volumeIdentityCandidates(item: DesktopItem): string[] {
  return [
    item.label,
    item.id,
    item.manifest,
    item.metadata,
    item.preview.image,
    item.preview.service,
    item.derivedFrom ?? '',
    item.derivation?.sourcePath ?? '',
    item.derivation?.outputPath ?? ''
  ].filter((value) => value.length > 0)
}

function volumeIdentityTokens(value: string): string[] {
  const decoded = safeDecodeURIComponent(value)
  const withoutQuery = decoded.split(/[?#]/)[0]
  const filename = withoutQuery.split(/[\\/]/).pop() ?? withoutQuery
  const stem = filename
    .replace(/\.nii(\.gz)?$/i, '')
    .replace(/\.json$/i, '')
    .replace(/\.png$/i, '')

  return stem
    .split(/[_\s.-]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean)
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function volumeFacetCounts(
  items: DesktopItem[],
  valueForItem: (item: DesktopItem) => string
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const value = valueForItem(item)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

function toggleFilterSet(
  setter: Dispatch<SetStateAction<Set<string>>>,
  value: string
): void {
  setter((current) => {
    const next = new Set(current)
    if (next.has(value)) {
      next.delete(value)
    } else {
      next.add(value)
    }
    return next
  })
}

function desktopManifestSignature(manifest: DesktopManifest): string {
  return [
    manifest.itemCount,
    manifest.world.width,
    manifest.world.height,
    ...manifest.items.map((item) => `${item.id}:${item.role ?? 'source'}:${item.derivedFrom ?? ''}`)
  ].join('|')
}

function StageResizeObserver({
  stageRef,
  onResize
}: {
  stageRef: RefObject<HTMLDivElement>
  onResize: (size: { width: number; height: number }) => void
}): null {
  const lastSizeRef = useRef({ width: 0, height: 0 })

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const stageElement = stage

    function update(): void {
      const nextSize = {
        width: stageElement.clientWidth,
        height: stageElement.clientHeight
      }
      const lastSize = lastSizeRef.current
      if (lastSize.width === nextSize.width && lastSize.height === nextSize.height) return
      lastSizeRef.current = nextSize
      onResize(nextSize)
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(stageElement)
    return () => observer.disconnect()
  }, [onResize, stageRef])

  return null
}

function StablePreviewImage({
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
  // volume — see acquirePreviewSlot.
  const [currentSrc, setCurrentSrc] = useState<string | null>(null)
  const [pendingSrc, setPendingSrc] = useState<string | null>(null)
  const releaseRef = useRef<(() => void) | null>(null)

  function releaseSlot(): void {
    releaseRef.current?.()
    releaseRef.current = null
  }

  useEffect(() => {
    if (src === currentSrc) {
      releaseSlot()
      setPendingSrc(null)
      return
    }

    // Drop the slot held by any now-stale pending load before queueing the new
    // one; replacing the <img> src cancels the in-flight request anyway.
    releaseSlot()

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
  }, [currentSrc, src])

  // Release the slot if we unmount mid-load so it can never leak.
  useEffect(() => releaseSlot, [])

  function commitPendingSrc(): void {
    setCurrentSrc((previous) => (pendingSrc ? pendingSrc : previous))
    setPendingSrc(null)
    releaseSlot()
  }

  function abandonPendingSrc(): void {
    setPendingSrc(null)
    releaseSlot()
  }

  return (
    <span className={frameClassName}>
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

function NiimathOperationsPanel({
  item,
  metadata,
  onDerivedVolume,
  onStatus
}: {
  item: DesktopItem | null
  metadata: VolumeMetadata | null
  onDerivedVolume: (volumeId: string) => Promise<void>
  onStatus: (status: string) => void
}): JSX.Element {
  const [operation, setOperation] = useState<NiimathOperation>('smooth')
  const [operand, setOperand] = useState('2')
  const [maskPath, setMaskPath] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [taskStatus, setTaskStatus] = useState('Ready.')
  const [result, setResult] = useState<NiimathTaskResult | null>(null)
  const selectedOperation = NIIMATH_OPERATIONS.find((candidate) => candidate.id === operation) ?? NIIMATH_OPERATIONS[0]
  const sourcePath = typeof metadata?.sourcePath === 'string' ? metadata.sourcePath : ''
  const parsedOperand = Number(operand)
  const hasOperand = !selectedOperation.needsOperand || Number.isFinite(parsedOperand)
  const hasMask = !selectedOperation.needsMask || maskPath.trim().length > 0
  const canRun = Boolean(item && sourcePath && hasOperand && hasMask && !isRunning)

  async function runTask(): Promise<void> {
    if (!item || !sourcePath || !canRun) return

    setIsRunning(true)
    setResult(null)
    setTaskStatus(`Running ${selectedOperation.label.toLowerCase()}.`)
    onStatus(`Running niimath ${selectedOperation.label.toLowerCase()} on ${item.label}.`)

    try {
      const nextResult = await runNiimathTask({
        sourcePath,
        operation,
        operand: selectedOperation.needsOperand ? parsedOperand : undefined,
        maskPath: selectedOperation.needsMask ? maskPath.trim() : undefined
      })
      setResult(nextResult)
      setTaskStatus('Done.')
      onStatus(`niimath wrote ${nextResult.outputPath}.`)
      await onDerivedVolume(nextResult.volumeId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTaskStatus(message)
      onStatus(message)
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <section className="nv-control-section nv-operation-panel">
      <div className="nv-panel-heading">
        <span>
          <Calculator size={15} />
          Operations
        </span>
        <em>niimath</em>
      </div>

      <div className="nv-operation-grid">
        <label className="nv-field">
          <span>Task</span>
          <select value={operation} onChange={(event) => setOperation(event.target.value as NiimathOperation)}>
            {NIIMATH_OPERATIONS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>

        {selectedOperation.needsOperand ? (
          <label className="nv-field">
            <span>Value</span>
            <input
              className="nv-text-input"
              inputMode="decimal"
              onChange={(event) => setOperand(event.target.value)}
              type="number"
              value={operand}
            />
          </label>
        ) : null}

        {selectedOperation.needsMask ? (
          <label className="nv-field nv-field-wide">
            <span>Mask Path</span>
            <input
              className="nv-text-input"
              onChange={(event) => setMaskPath(event.target.value)}
              placeholder="/path/to/mask.nii.gz"
              type="text"
              value={maskPath}
            />
          </label>
        ) : null}
      </div>

      <p className="nv-operation-help">{selectedOperation.help}</p>

      <button
        className="nv-primary-action"
        disabled={!canRun}
        onClick={() => void runTask()}
        type="button"
      >
        <Play size={14} />
        <span>{isRunning ? 'Running' : 'Run'}</span>
      </button>

      <div className="nv-task-status">
        <strong>{sourcePath ? item?.label : 'No source volume'}</strong>
        <span>{sourcePath ? taskStatus : 'Select a local NIfTI volume.'}</span>
        {result ? (
          <code title={result.outputPath}>{result.outputPath}</code>
        ) : null}
      </div>
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
  // Footer is a fixed 34px row; the dock fills the gap between the pointer and it.
  const footerHeight = 34

  function update(clientY: number): void {
    onChange(window.innerHeight - footerHeight - clientY)
  }

  function onMove(moveEvent: PointerEvent): void {
    update(moveEvent.clientY)
  }

  function onUp(): void {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId)
    }
  }

  update(event.clientY)
  handle.setPointerCapture(pointerId)
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

function beginDesktopPan(
  event: ReactPointerEvent<HTMLDivElement>,
  dragRef: MutableRefObject<DesktopDragState | null>,
  suppressClickRef: MutableRefObject<boolean>,
  setIsPanning: (isPanning: boolean) => void
): void {
  if (event.button !== 0) return
  const stage = event.currentTarget
  const pointerId = event.pointerId

  dragRef.current = {
    pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: stage.scrollLeft,
    scrollTop: stage.scrollTop,
    moved: false
  }

  function onMove(moveEvent: PointerEvent): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== pointerId) return

    const deltaX = moveEvent.clientX - drag.startX
    const deltaY = moveEvent.clientY - drag.startY
    const hasMoved = Math.hypot(deltaX, deltaY) > 3
    if (!hasMoved && !drag.moved) return

    moveEvent.preventDefault()
    stage.scrollLeft = drag.scrollLeft - deltaX
    stage.scrollTop = drag.scrollTop - deltaY
    if (!drag.moved) {
      drag.moved = true
      setIsPanning(true)
    }
  }

  function onEnd(): void {
    const drag = dragRef.current
    if (drag?.pointerId === pointerId) {
      suppressClickRef.current = drag.moved
      dragRef.current = null
      setIsPanning(false)
    }

    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
  }

  window.addEventListener('pointermove', onMove, { passive: false })
  window.addEventListener('pointerup', onEnd)
  window.addEventListener('pointercancel', onEnd)
}

function suppressDesktopClickAfterDrag(
  event: ReactMouseEvent<HTMLDivElement>,
  suppressClickRef: MutableRefObject<boolean>
): void {
  if (!suppressClickRef.current) return
  suppressClickRef.current = false
  event.preventDefault()
  event.stopPropagation()
}

function zoomDesktopWithWheel(
  event: WheelEvent,
  stage: HTMLDivElement,
  zoom: number,
  onZoom: (zoom: number) => void
): number {
  event.preventDefault()
  const nextZoom = zoomBy(zoom, event.deltaY < 0 ? 1.12 : 0.89)
  if (nextZoom === zoom) return zoom

  const rect = stage.getBoundingClientRect()
  const viewportX = event.clientX - rect.left
  const viewportY = event.clientY - rect.top
  const anchorX = stage.scrollLeft + viewportX
  const anchorY = stage.scrollTop + viewportY
  const ratio = nextZoom / zoom

  flushSync(() => {
    onZoom(nextZoom)
  })
  stage.scrollLeft = anchorX * ratio - viewportX
  stage.scrollTop = anchorY * ratio - viewportY

  return nextZoom
}

function jumpDesktopToMinimapPoint(
  event: ReactMouseEvent<HTMLElement>,
  stageRef: RefObject<HTMLDivElement>,
  setViewport: Dispatch<SetStateAction<MinimapViewport>>
): void {
  const stage = stageRef.current
  if (!stage) return

  event.preventDefault()
  event.stopPropagation()

  const minimap = event.currentTarget
  const map = minimap.querySelector<HTMLElement>('.nv-minimap-map')
  const rect = (map ?? minimap).getBoundingClientRect()
  const x = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1)
  const y = clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1)

  centerDesktopAtFraction(stage, x, y)
  updateDesktopViewport(stage, setViewport)
}

function centerDesktopAtFraction(stage: HTMLDivElement, x: number, y: number): void {
  const maxScrollLeft = Math.max(stage.scrollWidth - stage.clientWidth, 0)
  const maxScrollTop = Math.max(stage.scrollHeight - stage.clientHeight, 0)

  stage.scrollLeft = clamp(x * stage.scrollWidth - stage.clientWidth / 2, 0, maxScrollLeft)
  stage.scrollTop = clamp(y * stage.scrollHeight - stage.clientHeight / 2, 0, maxScrollTop)
}

function updateDesktopViewport(
  stage: HTMLDivElement | null,
  setViewport: Dispatch<SetStateAction<MinimapViewport>>
): void {
  if (!stage) return
  const next = desktopViewportFromStage(stage)
  setViewport((current) => (sameMinimapViewport(current, next) ? current : next))
}

function desktopViewportFromStage(stage: HTMLDivElement): MinimapViewport {
  const scrollWidth = Math.max(stage.scrollWidth, stage.clientWidth, 1)
  const scrollHeight = Math.max(stage.scrollHeight, stage.clientHeight, 1)
  const width = clamp((stage.clientWidth / scrollWidth) * 100, 0, 100)
  const height = clamp((stage.clientHeight / scrollHeight) * 100, 0, 100)

  return {
    left: clamp((stage.scrollLeft / scrollWidth) * 100, 0, 100 - width),
    top: clamp((stage.scrollTop / scrollHeight) * 100, 0, 100 - height),
    width,
    height
  }
}

function sameMinimapViewport(left: MinimapViewport, right: MinimapViewport): boolean {
  return (
    Math.abs(left.left - right.left) < 0.1 &&
    Math.abs(left.top - right.top) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1 &&
    Math.abs(left.height - right.height) < 0.1
  )
}

function minimapViewportStyle(viewport: MinimapViewport): CSSProperties {
  return {
    left: `${viewport.left}%`,
    top: `${viewport.top}%`,
    width: `${viewport.width}%`,
    height: `${viewport.height}%`
  }
}

function normalizeDesktopLayout(
  items: DesktopItem[],
  world: DesktopManifest['world'],
  tileSize: number,
  gap: number
): { items: DesktopItem[]; world: DesktopManifest['world'] } {
  if (items.length === 0) return { items, world }
  const sources = items.filter((item) => !isDerivedItem(item))
  const derivatives = items.filter((item) => isDerivedItem(item))
  const layoutCount = Math.max(sources.length, derivatives.length, 1)
  const columns = Math.max(1, Math.ceil(Math.sqrt(layoutCount)))
  const sourceRows = layoutRows(sources.length, columns)
  const derivedRows = layoutRows(derivatives.length, columns)
  const pitch = tileSize + gap
  const sectionLabelSpace = tileSize * 2
  const sectionGap = Math.max(Math.round(tileSize / 2), gap)
  const sourceTop = sectionLabelSpace
  const sourceHeight = layoutGridHeight(sourceRows, tileSize, gap)
  const derivedTop = derivatives.length > 0
    ? sourceTop + sourceHeight + sectionGap + sectionLabelSpace
    : 0
  const derivedHeight = layoutGridHeight(derivedRows, tileSize, gap)
  const nextBounds = new Map<string, WorldRect>()

  function placeGroup(group: DesktopItem[], top: number): void {
    group.forEach((item, index) => {
      const col = index % columns
      const row = Math.floor(index / columns)
      nextBounds.set(item.id, {
        x: col * pitch,
        y: top + row * pitch,
        width: tileSize,
        height: tileSize
      })
    })
  }

  placeGroup(sources, sourceTop)
  placeGroup(derivatives, derivedTop)

  const width = columns * tileSize + Math.max(columns - 1, 0) * gap
  const height = Math.max(
    derivatives.length > 0
      ? derivedTop + derivedHeight
      : sourceTop + sourceHeight,
    tileSize
  )

  return {
    items: items.map((item) => ({
      ...item,
      bounds: nextBounds.get(item.id) ?? item.bounds
    })),
    world: {
      ...world,
      width,
      height,
      columns,
      rows: sourceRows + derivedRows
    }
  }
}

function layoutRows(count: number, columns: number): number {
  return count === 0 ? 0 : Math.ceil(count / Math.max(columns, 1))
}

function layoutGridHeight(rows: number, tileSize: number, gap: number): number {
  return rows === 0 ? 0 : rows * tileSize + Math.max(rows - 1, 0) * gap
}

function desktopSections(
  items: DesktopItem[],
  world: DesktopManifest['world']
): Array<{ id: 'sources' | 'derived'; label: string; count: number; bounds: WorldRect }> {
  return [
    desktopSectionForRole(items.filter((item) => !isDerivedItem(item)), world, 'sources', 'Source Volumes'),
    desktopSectionForRole(items.filter((item) => isDerivedItem(item)), world, 'derived', 'Working Derivatives')
  ].filter((section): section is { id: 'sources' | 'derived'; label: string; count: number; bounds: WorldRect } => Boolean(section))
}

function desktopSectionForRole(
  items: DesktopItem[],
  world: DesktopManifest['world'],
  id: 'sources' | 'derived',
  label: string
): { id: 'sources' | 'derived'; label: string; count: number; bounds: WorldRect } | null {
  if (items.length === 0) return null
  const minY = Math.min(...items.map((item) => item.bounds.y))
  const maxY = Math.max(...items.map((item) => item.bounds.y + item.bounds.height))
  const headerSpace = (items[0]?.bounds.height ?? 1024) * 2
  const topPadding = Math.min(headerSpace, minY)
  const bottomPadding = 56

  return {
    id,
    label,
    count: items.length,
    bounds: {
      x: 0,
      y: Math.max(0, minY - topPadding),
      width: Math.max(world.width, 1),
      height: Math.max(maxY - minY + topPadding + bottomPadding, 1)
    }
  }
}

function worldRectStyle(
  rect: WorldRect,
  world: DesktopManifest['world']
): CSSProperties {
  const width = Math.max(world.width, 1)
  const height = Math.max(world.height, 1)

  return {
    left: `${(rect.x / width) * 100}%`,
    top: `${(rect.y / height) * 100}%`,
    width: `${(rect.width / width) * 100}%`,
    height: `${(rect.height / height) * 100}%`
  }
}

function fittedWorldSize(
  stageSize: { width: number; height: number },
  world: DesktopManifest['world'],
  zoom: number
): CSSProperties {
  const dimensions = fittedWorldDimensions(stageSize, world, zoom)
  return {
    width: `${dimensions.width}px`,
    height: `${dimensions.height}px`
  }
}

function renderedDesktopTileSize(
  worldSize: CSSProperties,
  world: DesktopManifest['world'],
  tileSize: number
): number {
  const renderedWorldWidth = Number.parseFloat(String(worldSize.width ?? '0'))
  const renderedWorldHeight = Number.parseFloat(String(worldSize.height ?? '0'))
  const tileWidth = renderedWorldWidth * tileSize / Math.max(world.width, 1)
  const tileHeight = renderedWorldHeight * tileSize / Math.max(world.height, 1)

  return Math.min(tileWidth, tileHeight)
}

function fittedWorldDimensions(
  stageSize: { width: number; height: number },
  world: DesktopManifest['world'],
  zoom: number
): { width: number; height: number } {
  const availableWidth = Math.max(stageSize.width - 44, 180)
  const availableHeight = Math.max(stageSize.height - 44, 180)
  const aspect = Math.max(world.width, 1) / Math.max(world.height, 1)
  let fitWidth = availableWidth
  let fitHeight = fitWidth / aspect

  if (fitHeight > availableHeight) {
    fitHeight = availableHeight
    fitWidth = fitHeight * aspect
  }

  return {
    width: Math.max(160, fitWidth * zoom),
    height: Math.max(160, fitHeight * zoom)
  }
}

function desktopPreviewSize(
  stageSize: { width: number; height: number },
  world: DesktopManifest['world'],
  tileSize: number,
  zoom: number
): number {
  const dimensions = fittedWorldDimensions(stageSize, world, zoom)
  const renderedTileWidth = dimensions.width * tileSize / Math.max(world.width, 1)
  const renderedTileHeight = dimensions.height * tileSize / Math.max(world.height, 1)
  const density = typeof window === 'undefined' ? 1 : Math.max(window.devicePixelRatio || 1, 1)
  const targetPixels = Math.max(renderedTileWidth, renderedTileHeight) * density

  return (
    DESKTOP_PREVIEW_TIERS.find((tier) => tier >= targetPixels) ??
    DESKTOP_PREVIEW_TIERS[DESKTOP_PREVIEW_TIERS.length - 1]
  )
}

function previewImageForSize(item: DesktopItem, size: number): string {
  if (!item.preview.service) return item.preview.image
  const level = previewLevelForSize(size, item)
  return `${item.preview.service}/full/${size},${size}/0/default.png?level=${level}&v=${PREVIEW_IMAGE_VERSION}`
}

function previewLevelForSize(size: number, item?: DesktopItem): number {
  const requestedLevel = size <= 192 ? 2 : size <= 384 ? 1 : 0
  const availableLevels = item?.levels?.map((level) => level.level) ?? [0]
  const maxLevel = Math.max(0, ...availableLevels)
  return Math.min(requestedLevel, maxLevel)
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

function zoomBy(zoom: number, factor: number): number {
  return clamp(Number((zoom * factor).toFixed(2)), MIN_DESKTOP_ZOOM, MAX_DESKTOP_ZOOM)
}

function mouseContextLabel(context: MouseContext): string {
  if (context === 'desktop') return 'Mouse: desktop grid controls'
  if (context === 'niivue') return 'Mouse: NiiVue controls'
  return 'Mouse: no pane'
}

async function savePatch(
  serverUrl: string,
  item: DesktopItem | null,
  clipPlanes: ClipPlane[],
  backend: Backend
): Promise<void> {
  if (!serverUrl || !item) return

  await fetch(`${serverUrl}/session/correction.patch.json`, {
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
}
