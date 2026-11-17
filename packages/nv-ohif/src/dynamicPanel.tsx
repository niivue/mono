import { useEffect, useReducer } from 'react'
import {
  anyFramesPane,
  type Cine,
  type CineServiceLike,
  groupPanes,
  onFrame,
  paneFrames,
  setFrame,
} from './frames4D'
import { ohifServices } from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'

// OHIF's 4D controls (cornerstone-dynamic-volume's play/pause, frame and fps
// 1-50) for NiiVue panes: play and fps go through OHIF's cineService, frames
// through frames4D. Acts on the active pane's 4D series, else the first shown.

type Services = {
  viewportGridService?: { getActiveViewportId?: () => string | undefined }
  cineService?: CineServiceLike
}

const box = { display: 'flex', alignItems: 'center', gap: 6 } as const
const button = {
  minWidth: 28,
  padding: '2px 8px',
  borderRadius: 4,
  background: '#1c2a4d',
  color: '#d1d5db',
} as const

function Stepper(props: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  const { label, value, min, max, onChange } = props
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)))
  return (
    <div style={box} data-cy={`niivue-4d-${label.toLowerCase()}`}>
      <span style={{ width: 44 }}>{label}</span>
      <button type="button" style={button} onClick={() => set(value - 1)}>
        ‹
      </button>
      <span style={{ minWidth: 24, textAlign: 'center' }}>{value}</span>
      <button type="button" style={button} onClick={() => set(value + 1)}>
        ›
      </button>
    </div>
  )
}

export function DynamicVolumePanel({ servicesManager }: OhifExtensionParams) {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => onFrame(rerender), [])
  const { viewportGridService: grid, cineService: cine } = (ohifServices(
    servicesManager,
  ) ?? {}) as Services
  const active = grid?.getActiveViewportId?.()
  const id = paneFrames(active) ? active : anyFramesPane()
  const frames = paneFrames(id)
  if (!id || !frames)
    return (
      <div style={{ padding: 8, color: '#d1d5db' }}>No 4D series shown.</div>
    )
  // Cine is per pane, frames per series: control every pane showing it.
  const ids = groupPanes(frames.group)
  const cines = cine?.getState?.()?.cines ?? {}
  const isPlaying = ids.some((i) => cines[i]?.isPlaying)
  const frameRate = cines[id]?.frameRate ?? 24
  const setCine = (patch: Cine) => {
    for (const i of ids)
      cine?.setCine?.({ id: i, frameRate, isPlaying, ...patch })
    rerender()
  }
  const toFrame = (f: number) => void setFrame(frames.group, f - 1)
  return (
    <div
      data-cy="niivue-dynamic-volume-panel"
      style={{
        display: 'grid',
        gap: 8,
        padding: 8,
        fontSize: 13,
        color: '#d1d5db',
      }}
    >
      <div style={box}>
        <button
          type="button"
          data-cy="niivue-4d-play"
          style={{ ...button, width: 64 }}
          onClick={() => setCine({ isPlaying: !isPlaying })}
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <span>
          Frame {frames.frame + 1}/{frames.count}
        </span>
      </div>
      <input
        type="range"
        aria-label="Frame"
        min={1}
        max={frames.count}
        value={frames.frame + 1}
        onChange={(e) => toFrame(Number(e.target.value))}
      />
      <Stepper
        label="Frame"
        value={frames.frame + 1}
        min={1}
        max={frames.count}
        onChange={toFrame}
      />
      <Stepper
        label="FPS"
        value={frameRate}
        min={1}
        max={50}
        onChange={(v) => setCine({ frameRate: v })}
      />
    </div>
  )
}

export const getNiivuePanelModule = (params: OhifExtensionParams) => [
  {
    name: 'dynamic-volume',
    iconName: 'tab-4d',
    iconLabel: '4D',
    label: '4D Workflow',
    component: () => <DynamicVolumePanel {...params} />,
  },
]
