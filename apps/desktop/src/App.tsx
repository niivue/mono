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
import {
  ChevronDown,
  CircleDot,
  Database,
  Eye,
  FileJson,
  GripVertical,
  Layers3,
  Maximize2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { NiivueStage } from './components/NiivueStage'
import type {
  Backend,
  ClipPlane,
  DesktopItem,
  DesktopManifest,
  VolumeMetadata,
  WorldRect
} from './domain/desktop'
import {
  defaultClipPlanes,
  fetchDesktopManifest,
  fetchVolumeMetadata,
  resolveServerUrl
} from './domain/desktop'

const MIN_SPLIT = 34
const MAX_SPLIT = 68
const MIN_DESKTOP_ZOOM = 0.5
const MAX_DESKTOP_ZOOM = 4
type MouseContext = 'desktop' | 'niivue' | null

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

export function App(): JSX.Element {
  const splitRef = useRef<HTMLElement | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [manifest, setManifest] = useState<DesktopManifest | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [backend, setBackend] = useState<Backend>('webgl2')
  const [colormap, setColormap] = useState('gray')
  const [clipPlanes, setClipPlanes] = useState(defaultClipPlanes)
  const [status, setStatus] = useState('Starting NeuroVue.')
  const [metadataStatus, setMetadataStatus] = useState('No metadata loaded.')
  const [metadata, setMetadata] = useState<VolumeMetadata | null>(null)
  const [query, setQuery] = useState('')
  const [splitPercent, setSplitPercent] = useState(52)
  const [desktopZoom, setDesktopZoom] = useState(1)
  const [mouseContext, setMouseContext] = useState<MouseContext>(null)

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      try {
        const resolved = await resolveServerUrl()
        if (cancelled) return
        setServerUrl(resolved)
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

  const items = manifest?.items ?? []
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return items
    return items.filter((item) =>
      [item.label, item.id, item.format, item.dtype].join(' ').toLowerCase().includes(normalized)
    )
  }, [items, query])

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

  return (
    <main className="nv-app">
      <header className="nv-topbar">
        <div className="nv-brand">
          <div className="nv-mark">
            <Layers3 size={18} />
          </div>
          <div>
            <h1>NeuroVue</h1>
            <p>{serverUrl || 'Resolving local server'}</p>
          </div>
        </div>

        <div className="nv-toolbar" aria-label="Viewer controls">
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
            className="nv-icon-button"
            title="Reset clip planes"
            onClick={() => setClipPlanes(defaultClipPlanes())}
          >
            <RotateCcw size={16} />
          </button>
          <button
            className="nv-icon-button"
            title="Save correction patch"
            onClick={() => void savePatch(serverUrl, selected, clipPlanes, backend)}
          >
            <Save size={16} />
          </button>
        </div>
      </header>

      <section className="nv-workbench">
        <aside className="nv-sidebar">
          <div className="nv-panel-heading">
            <span>
              <Database size={15} />
              Dataset
            </span>
            <em>{filteredItems.length}/{items.length}</em>
          </div>

          <input
            className="nv-search"
            placeholder="Filter volumes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          <div className="nv-volume-list">
            {filteredItems.map((item) => (
              <button
                className={`nv-volume-card ${selected?.id === item.id ? 'is-selected' : ''}`}
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                type="button"
              >
                <img src={item.preview.image} alt="" />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.shape.join(' x ')} / {item.dtype}</small>
                </span>
              </button>
            ))}
          </div>
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
            className={`nv-niivue-pane ${mouseContext === 'niivue' ? 'is-context-active' : ''}`}
            aria-label="NiiVue render window"
            onPointerEnter={() => setMouseContext('niivue')}
            onPointerLeave={() => setMouseContext(null)}
          >
            <div className="nv-stage-title nv-niivue-title" aria-hidden="true">
              <span>NiiVue Window</span>
              <strong>{selected?.label ?? 'No selection'}</strong>
              <em>{mouseContext === 'niivue' ? 'mouse' : backend.toUpperCase()}</em>
            </div>
            <NiivueStage
              backend={backend}
              clipPlanes={clipPlanes}
              colormap={colormap}
              item={selected}
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

          <SelectionPanel item={selected} metadataStatus={metadataStatus} />
          <MetadataPanel item={selected} metadata={metadata} status={metadataStatus} />

          <section className="nv-control-section">
            <div className="nv-panel-heading">
              <span>
                <SlidersHorizontal size={15} />
                Clip Planes
              </span>
              <em>{clipPlanes.filter((plane) => plane.enabled).length}</em>
            </div>

            <div className="nv-clip-list">
              {clipPlanes.map((plane) => (
                <ClipPlaneEditor
                  key={plane.id}
                  plane={plane}
                  onChange={(nextPlane) => {
                    setClipPlanes((planes) =>
                      planes.map((candidate) => candidate.id === plane.id ? nextPlane : candidate)
                    )
                  }}
                />
              ))}
            </div>
          </section>
        </aside>
      </section>

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
  const selectedStyle = selected ? worldRectStyle(selected.bounds, world) : undefined
  const worldSize = useMemo(
    () => fittedWorldSize(stageSize, world, zoom),
    [stageSize, world, zoom]
  )

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

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
  }, [items.length, stageSize.height, stageSize.width, worldSize, zoom])

  return (
    <div className="nv-osd-stage">
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
          {items.map((item) => (
            <button
              className={`nv-osd-tile ${selected?.id === item.id ? 'is-selected' : ''}`}
              key={item.id}
              onClick={() => onSelect(item)}
              style={worldRectStyle(item.bounds, world)}
              type="button"
            >
              <img src={item.preview.image} alt="" draggable={false} />
              <span className="nv-osd-index">L0</span>
              <span className="nv-osd-label">{item.label}</span>
            </button>
          ))}
          {items.length === 0 ? <div className="nv-empty-state">No matching volumes.</div> : null}
        </div>
      </div>

      <div className="nv-stage-title" aria-hidden="true">
        <span>OSD Desktop</span>
        <strong>{manifest?.label ?? 'VolumeDesktop'}</strong>
        <em>{isActive ? 'mouse' : `${Math.round(zoom * 100)}%`}</em>
      </div>

      <div className="nv-hud" aria-hidden="true">
        <span>zoom {Math.round(zoom * 100)}%</span>
        <span>{isActive ? 'wheel zoom / drag pan' : 'idle'}</span>
        <span>{items.length} visible</span>
        <span>{world.width} x {world.height}</span>
      </div>

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
          {selectedStyle ? <span className="nv-minimap-selection" style={selectedStyle} /> : null}
          <span className="nv-minimap-window" style={minimapViewportStyle(viewport)} />
        </span>
      </button>
    </div>
  )
}

function StageResizeObserver({
  stageRef,
  onResize
}: {
  stageRef: RefObject<HTMLDivElement>
  onResize: (size: { width: number; height: number }) => void
}): null {
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const stageElement = stage

    function update(): void {
      onResize({
        width: stageElement.clientWidth,
        height: stageElement.clientHeight
      })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(stageElement)
    return () => observer.disconnect()
  }, [onResize, stageRef])

  return null
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
              <dd>{metadata.sourcePath}</dd>
            </dl>
          ) : null}
          {sidecars.length > 0 ? (
            <div className="nv-sidecar-list">
              {sidecars.map((sidecar) => (
                <details className="nv-sidecar" key={sidecar.path ?? sidecar.name} open>
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
              <details className="nv-sidecar" open={sidecars.length === 0}>
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
  plane,
  onChange
}: {
  plane: ClipPlane
  onChange: (plane: ClipPlane) => void
}): JSX.Element {
  return (
    <section className="nv-clip-card">
      <label className="nv-toggle">
        <input
          checked={plane.enabled}
          onChange={(event) => onChange({ ...plane, enabled: event.target.checked })}
          type="checkbox"
        />
        <span>{plane.label}</span>
      </label>

      <Slider label="Depth" max={1} min={0} step={0.01} value={plane.depth} onChange={(depth) => onChange({ ...plane, depth })} />
      <Slider label="Azimuth" max={360} min={-360} step={1} value={plane.azimuth} onChange={(azimuth) => onChange({ ...plane, azimuth })} />
      <Slider label="Elevation" max={180} min={-180} step={1} value={plane.elevation} onChange={(elevation) => onChange({ ...plane, elevation })} />
    </section>
  )
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
      <code>{value.toFixed(step < 1 ? 2 : 0)}</code>
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
    width: `${Math.max(160, fitWidth * zoom)}px`,
    height: `${Math.max(160, fitHeight * zoom)}px`
  }
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
