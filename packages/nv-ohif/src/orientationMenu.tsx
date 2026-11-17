import type { NiiVue } from '@niivue/niivue'
import { SLICE_TYPE, VOLUME_RENDER_MODE } from '@niivue/niivue'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { NIIVUE_SLICE_TYPES } from './commands'
import { NIIVUE_VR_PRESETS } from './vrPresets'

const VIEWS: Array<[label: string, sliceType: string]> = [
  ['Axial', 'axial'],
  ['Sagittal', 'sagittal'],
  ['Coronal', 'coronal'],
  ['Multiplanar', 'multiplanar'],
  ['3D', 'render'],
  ['3D Cinematic', 'cinematic'],
]
const CINEMATIC = VOLUME_RENDER_MODE.CINEMATIC as number

// '3D' is the plain composite render; '3D Cinematic' the path tracer.
const isActive = (key: string, sliceType: number | undefined, mode: number) =>
  key === 'cinematic'
    ? sliceType === SLICE_TYPE.RENDER && mode === CINEMATIC
    : NIIVUE_SLICE_TYPES[key] === sliceType &&
      !(key === 'render' && mode === CINEMATIC)
const PRIMARY = '#5acce6'

const item = (active: boolean): CSSProperties => ({
  display: 'block',
  width: '100%',
  padding: '4px 12px',
  textAlign: 'left',
  background: active ? 'rgba(90, 204, 230, 0.2)' : 'transparent',
  color: active ? PRIMARY : '#d1d5db',
  border: 0,
  font: 'inherit',
  cursor: 'pointer',
})

// OHIF's OrientationSwitch glyph: a plane with its normal.
const Glyph = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke={PRIMARY}
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <path d="M2 12 L8 15 L16 11 L10 8 Z" />
    <path d="M9 11.5 V2.5 M7 4.5 L9 2.5 L11 4.5" />
  </svg>
)

/**
 * The pane's upper-left orientation menu, as cornerstone's viewport action
 * corner (OHIF draws that only inside its cornerstone viewport): shown while
 * the pointer is over the pane, it sets this pane's view. A CT pane in 3D also
 * lists cornerstone's volume-rendering presets (VIEWPORT_PRESETS names).
 */
export function OrientationMenu({
  nv,
  isCT,
}: {
  nv: NiiVue | null
  isCT?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  const [sliceType, setSliceType] = useState<number | undefined>(nv?.sliceType)
  const [renderMode, setRenderMode] = useState(0)
  const [preset, setPreset] = useState<string>()
  useEffect(() => {
    // The menu (and so the ref) mounts only once nv is set.
    const pane = nv && ref.current?.parentElement
    if (!pane) return
    const enter = () => setHover(true)
    const leave = () => {
      setHover(false)
      setOpen(false)
    }
    // Mounted under a pointer already over the pane: no pointerenter will come.
    if (pane.matches(':hover')) enter()
    pane.addEventListener('pointerenter', enter)
    pane.addEventListener('pointerleave', leave)
    return () => {
      pane.removeEventListener('pointerenter', enter)
      pane.removeEventListener('pointerleave', leave)
    }
  }, [nv])
  if (!nv) return null
  return (
    <div
      ref={ref}
      style={{ position: 'absolute', left: 8, top: 6, zIndex: 2, fontSize: 14 }}
    >
      {hover || open ? (
        <button
          type="button"
          title="Change viewport orientation"
          data-cy="niivue-orientation-menu"
          onClick={() => {
            setSliceType(nv.sliceType)
            setRenderMode(nv.volumeRenderMode)
            setOpen((o) => !o)
          }}
          style={{
            background: 'transparent',
            border: 0,
            padding: 2,
            cursor: 'pointer',
            display: 'flex',
          }}
        >
          <Glyph />
        </button>
      ) : null}
      {open ? (
        <div
          style={{
            marginTop: 4,
            minWidth: 140,
            padding: '4px 0',
            background: '#090c29',
            border: '1px solid #3a3f99',
            borderRadius: 6,
          }}
        >
          {VIEWS.map(([label, key]) => (
            <button
              key={key}
              type="button"
              style={item(isActive(key, sliceType, renderMode))}
              onClick={() => {
                // Any pick but '3D Cinematic' restores the plain render, so a
                // later 3D view (toolbar, hotkey, multiplanar tile) is not path traced.
                nv.volumeRenderMode =
                  key === 'cinematic'
                    ? CINEMATIC
                    : (VOLUME_RENDER_MODE.COMPOSITE as number)
                nv.sliceType = (NIIVUE_SLICE_TYPES[key] ??
                  SLICE_TYPE.RENDER) as number
                setOpen(false)
              }}
            >
              {label}
            </button>
          ))}
          {isCT && sliceType === SLICE_TYPE.RENDER
            ? Object.entries(NIIVUE_VR_PRESETS).map(([name, colormap], i) => (
                <button
                  key={name}
                  type="button"
                  style={{
                    ...item(name === preset),
                    ...(i === 0 ? { borderTop: '1px solid #3a3f99' } : {}),
                  }}
                  onClick={() => {
                    // A CT colormap carries its own Hounsfield window.
                    void nv.setVolume(0, { colormap })
                    setPreset(name)
                    setOpen(false)
                  }}
                >
                  {name}
                </button>
              ))
            : null}
        </div>
      ) : null}
    </div>
  )
}
