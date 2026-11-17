import { useEffect, useReducer, useState } from 'react'
import { ohifCommandsManager } from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'
import {
  DEFAULT_THRESHOLD,
  type NamedStats,
  onQuantChange,
  quantState,
  type ThresholdConfig,
  tmtvStats,
} from './petQuant'

// OHIF's TMTV panel (ROI threshold options, TMTV, CSV) and the 4D ROI
// quantification / kinetic panels, for NiiVue panes. Values also sit in
// data-* attributes for the e2e parity scripts.

const text = { padding: 8, fontSize: 13, color: '#d1d5db' } as const
const row = { display: 'flex', alignItems: 'center', gap: 6 } as const
const button = {
  padding: '2px 8px',
  borderRadius: 4,
  background: '#1c2a4d',
  color: '#d1d5db',
} as const
const input = { width: 64, background: '#0b1a42', color: '#d1d5db' } as const

function useQuant() {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => onQuantChange(rerender), [])
}

const run = (
  params: OhifExtensionParams,
  name: string,
  options?: Record<string, unknown>,
) => ohifCommandsManager(params.commandsManager)?.runCommand?.(name, options)

function Num(props: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label style={row}>
      <span style={{ width: 72 }}>{props.label}</span>
      <input
        type="number"
        step="any"
        style={input}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}

/** OHIF's ROIThresholdConfiguration: Max% or Range, start/end slice, Run. */
function ThresholdControls(params: OhifExtensionParams) {
  const [c, setC] = useState<Required<ThresholdConfig>>(DEFAULT_THRESHOLD)
  const set = (patch: ThresholdConfig) => setC({ ...c, ...patch })
  const { roiSlices } = quantState(params.servicesManager)
  const slice = (p?: number[]) =>
    p ? p.map((v) => v.toFixed(1)).join(', ') : '-'
  return (
    <div style={{ display: 'grid', gap: 6 }} data-cy="niivue-roi-threshold">
      <div style={row}>
        {(['roi_stat', 'range'] as const).map((s) => (
          <button
            key={s}
            type="button"
            style={{
              ...button,
              outline: c.strategy === s ? '1px solid #5acce6' : 'none',
            }}
            onClick={() => set({ strategy: s })}
          >
            {s === 'roi_stat' ? 'Max' : 'Range'}
          </button>
        ))}
      </div>
      {c.strategy === 'roi_stat' ? (
        <Num
          label="Weight"
          value={c.weight}
          onChange={(weight) => set({ weight })}
        />
      ) : (
        <>
          <Num
            label="PT lower"
            value={c.ptLower}
            onChange={(ptLower) => set({ ptLower })}
          />
          <Num
            label="PT upper"
            value={c.ptUpper}
            onChange={(ptUpper) => set({ ptUpper })}
          />
          <Num
            label="CT lower"
            value={c.ctLower}
            onChange={(ctLower) => set({ ctLower })}
          />
          <Num
            label="CT upper"
            value={c.ctUpper}
            onChange={(ctUpper) => set({ ctUpper })}
          />
        </>
      )}
      {(['start', 'end'] as const).map((which) => (
        <div key={which} style={row}>
          <button
            type="button"
            style={button}
            data-cy={`niivue-roi-${which}`}
            onClick={() => run(params, 'niivueSetROIThresholdSlice', { which })}
          >
            {which === 'start' ? 'Start slice' : 'End slice'}
          </button>
          <span>{slice(roiSlices[which])}</span>
        </div>
      ))}
      <button
        type="button"
        style={{ ...button, width: 80 }}
        data-cy="niivue-roi-run"
        onClick={() => run(params, 'niivueROIThreshold', c)}
      >
        Run
      </button>
    </div>
  )
}

function SegmentTable({ segments }: { segments: NamedStats[] }) {
  return (
    <div data-measurements="">
      {segments.map((s) => (
        <div
          key={s.value}
          style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 4 }}
          data-segment={s.value}
          data-count={s.count}
          data-volume={s.volume}
          data-mean={s.mean}
          data-max={s.max}
          data-peak={s.peak}
          data-lesion-glycolysis={s.lesionGlycolysis}
        >
          <span>{s.label}</span>
          <span>
            {(s.volume / 1000).toFixed(3)} mL, mean {s.mean.toFixed(2)}, peak{' '}
            {s.peak.toFixed(2)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function TmtvPanel(params: OhifExtensionParams) {
  useQuant()
  const stats = tmtvStats(params.servicesManager)
  return (
    <div
      style={{ ...text, display: 'grid', gap: 10 }}
      data-cy="niivue-tmtv-panel"
      data-tmtv={stats?.tmtv}
      data-tlg={stats?.tlg}
    >
      <ThresholdControls {...params} />
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span>
          <b>TMTV:</b> {stats?.tmtv ? `${stats.tmtv.toFixed(3)} mL` : ''}
        </span>
        <button
          type="button"
          style={button}
          data-cy="exportTmtvCsvReport"
          onClick={() => run(params, 'niivueExportTMTVCSV')}
        >
          CSV
        </button>
      </div>
      <SegmentTable segments={stats?.segments ?? []} />
    </div>
  )
}

/** 4D step 3: segments, threshold brush range, ROI threshold, CSV exports. */
export function RoiQuantPanel(params: OhifExtensionParams) {
  useQuant()
  const { names, activeSegment, thresholdRange } = quantState(
    params.servicesManager,
  )
  const stats = tmtvStats(params.servicesManager)
  return (
    <div
      style={{ ...text, display: 'grid', gap: 10 }}
      data-cy="niivue-roi-panel"
    >
      <div style={{ display: 'grid', gap: 4 }}>
        {names.slice(1).map((name, i) => (
          <button
            key={name}
            type="button"
            style={{
              ...button,
              textAlign: 'left',
              outline: activeSegment === i + 1 ? '1px solid #5acce6' : 'none',
            }}
            onClick={() =>
              run(params, 'niivueSetActiveSegment', { segmentIndex: i + 1 })
            }
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          style={button}
          onClick={() => run(params, 'niivueAddSegment')}
        >
          + Segment
        </button>
      </div>
      <div style={row}>
        <span>Threshold brush</span>
        {[0, 1].map((k) => (
          <input
            key={k}
            type="number"
            step="any"
            style={input}
            value={thresholdRange[k]}
            onChange={(e) => {
              const range: [number, number] = [...thresholdRange]
              range[k] = Number(e.target.value)
              run(params, 'niivueSetThresholdRange', { range })
            }}
          />
        ))}
      </div>
      <ThresholdControls {...params} />
      <SegmentTable segments={stats?.segments ?? []} />
      <div style={row}>
        <button
          type="button"
          style={button}
          onClick={() =>
            run(params, 'niivueExportTimeReportCSV', {
              filename: 'TimeData.csv',
            })
          }
        >
          Time Data
        </button>
        <button
          type="button"
          style={button}
          onClick={() =>
            run(params, 'niivueExportTimeReportCSV', {
              summaryStats: true,
              filename: 'ROIStats.csv',
            })
          }
        >
          ROI Stats
        </button>
      </div>
    </div>
  )
}

type Tac = {
  timePoints: number[]
  unit: string
  curves: { value: number; label: string; mean: number[] }[]
}
const COLORS = [
  '#e6194b',
  '#3cb44b',
  '#ffe119',
  '#4363d8',
  '#f58231',
  '#911eb4',
]

/** 4D step 4: each segment's mean time-activity curve. */
export function TacPanel(params: OhifExtensionParams) {
  const [tac, setTac] = useState<Tac>()
  useEffect(() => {
    let live = true
    const load = () =>
      void Promise.resolve(run(params, 'niivueTimeActivity')).then(
        (t) => live && setTac(t as Tac | undefined),
      )
    load()
    const off = onQuantChange(load)
    return () => {
      live = false
      off()
    }
  }, [params])
  const pts = tac?.timePoints ?? []
  const all = tac?.curves.flatMap((c) => c.mean) ?? []
  if (!tac || !pts.length || !all.length)
    return <div style={text}>No segment to chart.</div>
  const [w, h] = [260, 160]
  const [x0, x1] = [Math.min(...pts), Math.max(...pts)]
  const [y0, y1] = [Math.min(0, ...all), Math.max(...all)]
  const px = (t: number) => ((t - x0) / (x1 - x0 || 1)) * w
  const py = (v: number) => h - ((v - y0) / (y1 - y0 || 1)) * h
  return (
    <div style={text} data-cy="niivue-tac-panel">
      <svg
        width={w}
        height={h}
        style={{ background: '#0b1a42' }}
        role="img"
        aria-label="Time-activity curves"
      >
        {tac.curves.map((c, k) => (
          <polyline
            key={c.value}
            fill="none"
            stroke={COLORS[k % COLORS.length]}
            points={c.mean
              .map((v, i) => `${px(pts[i] ?? 0)},${py(v)}`)
              .join(' ')}
          />
        ))}
      </svg>
      <div>Time ({tac.unit})</div>
      {tac.curves.map((c, k) => (
        <div
          key={c.value}
          style={{ color: COLORS[k % COLORS.length] }}
          data-tac={c.value}
          data-mean={c.mean.join(',')}
        >
          {c.label}
        </div>
      ))}
    </div>
  )
}
