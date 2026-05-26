import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import {
  Box,
  ChevronDown,
  CircleDot,
  Database,
  Eye,
  Layers3,
  RotateCcw,
  Save,
  SlidersHorizontal
} from 'lucide-react'
import { NiivueStage } from './components/NiivueStage'
import type { Backend, ClipPlane, DesktopItem, DesktopManifest } from './domain/desktop'
import {
  defaultClipPlanes,
  fetchDesktopManifest,
  resolveServerUrl
} from './domain/desktop'

export function App(): JSX.Element {
  const [serverUrl, setServerUrl] = useState('')
  const [manifest, setManifest] = useState<DesktopManifest | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [backend, setBackend] = useState<Backend>('webgl2')
  const [colormap, setColormap] = useState('gray')
  const [clipPlanes, setClipPlanes] = useState(defaultClipPlanes)
  const [status, setStatus] = useState('Starting NeuroVue.')
  const [query, setQuery] = useState('')

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

          <button className="nv-icon-button" title="Reset clip planes" onClick={() => setClipPlanes(defaultClipPlanes())}>
            <RotateCcw size={16} />
          </button>
          <button className="nv-icon-button" title="Save correction patch" onClick={() => void savePatch(serverUrl, selected, clipPlanes, backend)}>
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
            <em>{items.length}</em>
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

        <section className="nv-center">
          <div className="nv-desktop-strip" aria-label="OSD desktop preview">
            {items.map((item) => (
              <button
                className={`nv-desktop-tile ${selected?.id === item.id ? 'is-selected' : ''}`}
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                style={{
                  '--tile-x': item.bounds.x,
                  '--tile-y': item.bounds.y
                } as CSSProperties}
                type="button"
              >
                <img src={item.preview.image} alt="" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <NiivueStage
            backend={backend}
            clipPlanes={clipPlanes}
            colormap={colormap}
            item={selected}
          />
        </section>

        <aside className="nv-controls">
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

          <section className="nv-readout">
            <h2>
              <Eye size={15} />
              Selection
            </h2>
            {selected ? (
              <dl>
                <dt>ID</dt>
                <dd>{selected.id}</dd>
                <dt>Format</dt>
                <dd>{selected.format}</dd>
                <dt>Spacing</dt>
                <dd>{selected.spacing.join(' x ')}</dd>
                <dt>Manifest</dt>
                <dd>{selected.manifest}</dd>
              </dl>
            ) : (
              <p>No volume selected.</p>
            )}
          </section>
        </aside>
      </section>

      <footer className="nv-status">
        <span>
          <CircleDot size={12} />
          {status}
        </span>
        <span>{manifest?.label ?? 'VolumeDesktop manifest'}</span>
      </footer>
    </main>
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
