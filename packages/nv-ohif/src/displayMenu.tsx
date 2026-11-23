import type NiiVue from '@niivue/niivue'
import type { PropertyChangeDetail } from '@niivue/niivue'
import { SLICE_TYPE, VOLUME_RENDER_MODE } from '@niivue/niivue'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import {
  applyWindowLevelPreset,
  baseModality,
  niivueColormapName,
  setViewportColormap,
  windowLevelPresets,
} from './commands'
import { getNiivueEntry, ohifServices } from './niivueRegistry'
import type { OhifServicesManager } from './ohif-types'
import { CINEMATIC_LIGHTING } from './vrPresets'

// cornerstone's viewport action corners (bottom-left windowLevelMenu,
// bottom-middle AdvancedRenderingControls: W/L presets and manual VOI, Color
// LUT, colorbar, overlay opacity and threshold) read a cornerstone viewport,
// so OHIF draws none on a NiiVue pane: this menu sets the same on NiiVue.

const PRIMARY = '#5acce6'
const row: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  padding: '3px 12px',
  color: '#d1d5db',
}
const item: CSSProperties = {
  ...row,
  width: '100%',
  background: 'transparent',
  border: 0,
  font: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
}
const heading: CSSProperties = { ...row, color: PRIMARY, fontWeight: 600 }

type Colormaps = { colormaps?: Array<{ Name?: string; name?: string }> }

export function DisplayMenu({
  viewportId,
  isLoaded,
  servicesManager,
}: {
  viewportId: string
  isLoaded: boolean
  servicesManager: OhifServicesManager | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  const [, redraw] = useState(0)
  useEffect(() => {
    const pane = isLoaded && ref.current?.parentElement
    if (!pane) return
    const enter = () => setHover(true)
    const leave = () => {
      setHover(false)
      setOpen(false)
    }
    if (pane.matches(':hover')) enter()
    pane.addEventListener('pointerenter', enter)
    pane.addEventListener('pointerleave', leave)
    return () => {
      pane.removeEventListener('pointerenter', enter)
      pane.removeEventListener('pointerleave', leave)
    }
  }, [isLoaded])
  const entry = isLoaded ? getNiivueEntry(viewportId) : undefined
  if (!entry) return <div ref={ref} hidden />
  const nv: NiiVue = entry.nv
  const base = nv.volumes[0]
  const overlay = nv.volumes.length > 1 ? nv.volumes.length - 1 : 0
  const ov = overlay ? nv.volumes[overlay] : undefined
  const presets =
    windowLevelPresets(servicesManager)[baseModality(entry) ?? ''] ?? []
  const custom = (
    ohifServices(servicesManager)?.customizationService as
      | { getCustomization?: (id: string) => unknown }
      | undefined
  )?.getCustomization?.('cornerstone.colorbar') as Colormaps | undefined
  const colormaps = (custom?.colormaps ?? [])
    .map((c) => c.Name ?? c.name ?? '')
    .filter((n) => niivueColormapName(nv.colormaps, n))
  const width = base ? base.calMax - base.calMin : 0
  const level = base ? (base.calMax + base.calMin) / 2 : 0
  const setVoi = (w: number, l: number) => {
    if (w > 0) void nv.setVolume(0, { calMin: l - w / 2, calMax: l + w / 2 })
    redraw((n) => n + 1)
  }
  return (
    <div
      ref={ref}
      // Bottom middle, as cornerstone's AdvancedRenderingControls (the lower
      // left holds the W/L readout).
      style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 6,
        zIndex: 2,
        fontSize: 13,
      }}
    >
      {open ? (
        <div
          data-cy="niivue-display-menu"
          style={{
            marginBottom: 4,
            minWidth: 200,
            maxHeight: 360,
            overflowY: 'auto',
            padding: '4px 0',
            background: '#090c29',
            border: '1px solid #3a3f99',
            borderRadius: 6,
          }}
        >
          {nv.sliceType === SLICE_TYPE.RENDER ? (
            // A 3D pane: cornerstone's Volume Rendering Options only.
            <RenderingOptions nv={nv} redraw={() => redraw((n) => n + 1)} />
          ) : (
            <>
              {presets.length ? (
                <div style={heading}>Modality Window Presets</div>
              ) : null}
              {presets.map((p, i) => (
                <button
                  key={p.id ?? i}
                  type="button"
                  style={item}
                  onClick={() => {
                    applyWindowLevelPreset(entry, servicesManager, p.id, i)
                    setOpen(false)
                  }}
                >
                  {p.description ?? p.id} ({p.window} / {p.level})
                </button>
              ))}
              <div style={heading}>Window / Level</div>
              <label style={row}>
                W
                <input
                  aria-label="Window width"
                  type="number"
                  defaultValue={Math.round(width)}
                  onChange={(e) => setVoi(Number(e.target.value), level)}
                  style={{ width: 70 }}
                />
                L
                <input
                  aria-label="Window level"
                  type="number"
                  defaultValue={Math.round(level)}
                  onChange={(e) => setVoi(width, Number(e.target.value))}
                  style={{ width: 70 }}
                />
              </label>
              <label style={row}>
                <input
                  type="checkbox"
                  checked={nv.isColorbarVisible}
                  onChange={(e) => {
                    nv.isColorbarVisible = e.target.checked
                    redraw((n) => n + 1)
                  }}
                />
                Colorbar
              </label>
              {ov ? (
                <>
                  <label style={row}>
                    Opacity
                    <input
                      aria-label="Overlay opacity"
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      defaultValue={ov.opacity}
                      onChange={(e) =>
                        void nv.setVolume(overlay, {
                          opacity: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label style={row}>
                    Threshold
                    <input
                      aria-label="Overlay threshold"
                      type="number"
                      defaultValue={ov.calMin}
                      onChange={(e) =>
                        void nv.setVolume(overlay, {
                          calMin: Number(e.target.value),
                        })
                      }
                      style={{ width: 80 }}
                    />
                  </label>
                </>
              ) : null}
              {colormaps.length ? <div style={heading}>Color LUT</div> : null}
              {colormaps.map((name) => (
                <button
                  key={name}
                  type="button"
                  style={item}
                  onClick={() => {
                    setViewportColormap(entry, { colormap: name })
                    setOpen(false)
                  }}
                >
                  {name}
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}
      {hover || open ? (
        <button
          type="button"
          title="Display options"
          data-cy="niivue-display-menu-btn"
          onClick={() => setOpen((o) => !o)}
          style={{
            background: 'transparent',
            border: 0,
            padding: 2,
            cursor: 'pointer',
            color: PRIMARY,
            font: 'inherit',
          }}
        >
          {nv.sliceType === SLICE_TYPE.RENDER ? '3D' : 'W/L'}
        </button>
      ) : null}
    </div>
  )
}

const MENU_PROPERTIES = new Set([
  'volumeRenderMode',
  'volumeCinematic',
  'volumeIllumination',
  'volumeSampleRate',
])

/**
 * cornerstone's Volume Rendering Options (quality, shift, shade, lighting) on a NiiVue
 * 3D pane, through the same commands as OHIF's menu would run.
 */
export function RenderingOptions({
  nv,
  redraw,
}: {
  nv: NiiVue
  redraw: () => void
}) {
  const vol = nv.volumes[0]
  const width = vol ? Math.max(1, vol.calMax - vol.calMin) : 1
  const [shift, setShift] = useState(0)
  // Each lighting slider's max: 2, or the highest value it has shown, so a
  // lowered value can return.
  const lightingMax = useRef<Record<string, number>>({})
  // Follow changes made elsewhere (commands, the orientation menu's 3D Cinematic).
  const [, refresh] = useState(0)
  useEffect(() => {
    // Only what the menu shows; crosshair and azimuth changes fire per frame.
    const update = (e: CustomEvent<PropertyChangeDetail>) => {
      if (MENU_PROPERTIES.has(e.detail.property)) refresh((n) => n + 1)
    }
    nv.addEventListener('change', update)
    return () => nv.removeEventListener('change', update)
  }, [nv])
  // cornerstone disables its lighting sliders without shade; these need the
  // path tracer, the only NiiVue renderer with separate lighting terms.
  const cinematic = nv.volumeRenderMode === VOLUME_RENDER_MODE.CINEMATIC
  return (
    <>
      <div style={heading}>Rendering</div>
      <label style={row}>
        Quality
        <input
          aria-label="Volume rendering quality"
          type="range"
          min={1}
          max={4}
          step={1}
          value={nv.volumeSampleRate}
          onChange={(e) => {
            nv.volumeSampleRate = Number(e.target.value)
            redraw()
          }}
        />
      </label>
      <label style={row}>
        Shift
        <input
          aria-label="Volume opacity shift"
          type="range"
          min={-width}
          max={width}
          step={width / 100}
          value={shift}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (vol)
              void nv.setVolume(0, {
                calMin: vol.calMin + next - shift,
                calMax: vol.calMax + next - shift,
              })
            setShift(next)
          }}
        />
      </label>
      <label style={row}>
        <input
          type="checkbox"
          checked={nv.volumeIllumination > 0}
          onChange={(e) => {
            nv.volumeIllumination = e.target.checked ? 0.6 : 0
            redraw()
          }}
        />
        Shade
      </label>
      {Object.entries(CINEMATIC_LIGHTING).map(([name, key]) => (
        <label
          key={name}
          style={row}
          title={cinematic ? undefined : 'Lighting applies in 3D Cinematic'}
        >
          {name.charAt(0).toUpperCase() + name.slice(1)}
          <input
            aria-label={`Volume lighting ${name}`}
            type="range"
            min={0}
            max={
              (lightingMax.current[key] = Math.max(
                lightingMax.current[key] ?? 2,
                nv.volumeCinematic[key],
              ))
            }
            step={0.1}
            disabled={!cinematic}
            value={nv.volumeCinematic[key]}
            onChange={(e) => {
              nv.volumeCinematic = { [key]: Number(e.target.value) }
              redraw()
            }}
          />
        </label>
      ))}
    </>
  )
}
