import { useEffect, useReducer, useState } from 'react'
import {
  anyFramesPane,
  groupPanes,
  isComputedShown,
  onFrame,
  paneFrames,
  setFrame,
} from './frames4D'
import { ohifCommandsManager, ohifServices } from './niivueRegistry'
import type { OhifCine, OhifExtensionParams } from './ohif-types'
import { onQuantChange } from './petQuant'
import { RoiQuantPanel, TacPanel, TmtvPanel } from './quantPanels'

// OHIF's 4D controls (cornerstone-dynamic-volume's play/pause, frame and fps
// 1-50) for NiiVue panes: play and fps go through OHIF's cineService, frames
// through frames4D. Acts on the active pane's 4D series, else the first shown.

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

export function DynamicVolumePanel({
  servicesManager,
  commandsManager,
}: OhifExtensionParams) {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => onFrame(rerender), [])
  useEffect(() => onQuantChange(rerender), [])
  const [range, setRange] = useState<[number, number]>([1, 0])
  const { viewportGridService: grid, cineService: cine } =
    ohifServices(servicesManager) ?? {}
  // The active pane picks the series. Events fire before the grid's state
  // updates (segHydration.tsx), so the reread waits a tick.
  useEffect(() => {
    const event = grid?.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED
    const sub = event
      ? grid?.subscribe?.(event, () => setTimeout(rerender))
      : undefined
    return () => sub?.unsubscribe()
  }, [grid])
  const active = grid?.getActiveViewportId?.() ?? undefined
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
  const setCine = (patch: OhifCine) => {
    for (const i of ids)
      cine?.setCine?.({ id: i, frameRate, isPlaying, ...patch })
    rerender()
  }
  const toFrame = (f: number) => void setFrame(frames.group, f - 1)
  // OHIF's computed-image range, 1-based, defaulting to every frame; clamped
  // because it outlives a switch to a shorter series.
  const last = Math.min(range[1] || frames.count, frames.count)
  const first = Math.min(range[0], last - 1)
  const run = (name: string, options?: Record<string, unknown>) =>
    ohifCommandsManager(commandsManager)?.runCommand?.(name, options)
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
      <Stepper
        label="From"
        value={first}
        min={1}
        max={last - 1}
        onChange={(v) => setRange([v, last])}
      />
      <Stepper
        label="To"
        value={last}
        min={first + 1}
        max={frames.count}
        onChange={(v) => setRange([first, v])}
      />
      <div style={box} data-cy="niivue-4d-compute">
        {(['SUM', 'AVERAGE', 'SUBTRACT'] as const).map((operation) => (
          <button
            key={operation}
            type="button"
            style={button}
            onClick={() =>
              run('niivueComputeVolume', { operation, start: first, end: last })
            }
          >
            {operation}
          </button>
        ))}
      </div>
      {isComputedShown(frames.group) ? (
        <button
          type="button"
          style={button}
          data-cy="niivue-4d-dynamic"
          onClick={() => run('niivueShowFrames')}
        >
          4D
        </button>
      ) : null}
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
  {
    name: 'tmtv',
    iconName: 'tab-segmentation',
    iconLabel: 'TMTV',
    label: 'TMTV',
    component: () => <TmtvPanel {...params} />,
  },
  {
    name: 'roi-quantification',
    iconName: 'tab-segmentation',
    iconLabel: 'Segmentation',
    label: 'ROI Quantification',
    component: () => <RoiQuantPanel {...params} />,
  },
  {
    name: 'time-activity',
    iconName: 'tab-4d',
    iconLabel: 'Kinetics',
    label: 'Time-Activity',
    component: () => <TacPanel {...params} />,
  },
]
