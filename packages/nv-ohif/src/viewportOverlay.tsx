// Corner text as on cornerstone viewports (OHIF's viewport overlay): study
// date + series description upper left, window/level lower left, and for a 2D
// slice in the acquisition plane its instance number and stack position lower
// right.
import type { CSSProperties } from 'react'
import { rasToLps } from './commands'
import type { OhifDisplaySet } from './ohif-types'
import { frameAt, type SliceFrames } from './sliceFrames'

export type WindowLevel = { window: number; level: number }
export type StackPosition = {
  instanceNumber?: number
  index: number
  total: number
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')

/** DICOM DA (YYYYMMDD) as OHIF shows it (22-May-2014); other text as is. */
export function studyDateLabel(da: unknown): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(da ?? ''))
  if (!m) return da ? String(da) : undefined
  return `${m[3]}-${MONTHS[Number(m[2]) - 1] ?? m[2]}-${m[1]}`
}

/**
 * The DICOM instance behind the slice under an RAS point: NiiVue reorients
 * volumes to RAS, so the slice index alone is not the acquisition position;
 * the slice -> frame map (built from each frame's DICOM position) is.
 */
export function stackPosition(
  ds: OhifDisplaySet | undefined,
  sf: SliceFrames | undefined,
  mmRas: ArrayLike<number>,
  volumeOrder = false,
): StackPosition | undefined {
  if (!ds || !sf) return undefined
  const frame = frameAt(sf, [
    rasToLps([mmRas[0] ?? 0, mmRas[1] ?? 0, mmRas[2] ?? 0]),
  ])
  if (!frame) return undefined
  const instances = (ds.instances ?? []) as Array<{
    SOPInstanceUID?: string
    InstanceNumber?: unknown
    NumberOfFrames?: unknown
  }>
  const i = instances.findIndex(
    (inst) => inst.SOPInstanceUID === frame.SOPInstanceUID,
  )
  if (i < 0) return undefined
  const frames = Number(instances[i]?.NumberOfFrames) || 1
  // Cornerstone counts a volume viewport's position along the volume
  // (inferior -> superior for axial), a stack viewport's in display-set order.
  if (volumeOrder)
    return {
      instanceNumber: Number(instances[i]?.InstanceNumber) || undefined,
      index: sf.frames.indexOf(frame) + 1,
      total: sf.frames.length,
    }
  // A multi-frame instance is one stack: its frame is the position.
  return instances.length === 1 && frames > 1
    ? { index: frame.frameNumber, total: frames }
    : {
        instanceNumber: Number(instances[i]?.InstanceNumber) || undefined,
        index: i + 1,
        total: instances.length,
      }
}

const corner = (pos: CSSProperties): CSSProperties => ({
  position: 'absolute',
  ...pos,
  color: '#d1d5db',
  fontSize: 14,
  lineHeight: 1.4,
  pointerEvents: 'none',
  textShadow: '0 0 2px #000',
})

export function StudyLabel({ ds }: { ds: OhifDisplaySet | undefined }) {
  const inst = ds?.instances?.[0] as { StudyDate?: unknown } | undefined
  const date = studyDateLabel(
    (ds as { StudyDate?: unknown } | undefined)?.StudyDate ?? inst?.StudyDate,
  )
  if (!date && !ds?.SeriesDescription) return null
  return (
    <div style={corner({ left: 12, top: 40 })}>
      {date ? <div>{date}</div> : null}
      {ds?.SeriesDescription ? <div>{ds.SeriesDescription}</div> : null}
    </div>
  )
}

export function StackPositionReadout({
  instanceNumber,
  index,
  total,
}: StackPosition) {
  return (
    <div style={corner({ right: 12, bottom: 8 })}>
      {`I:${instanceNumber ?? index} (${index}/${total})`}
    </div>
  )
}

/** Lower-left "W: L:" readout with a contrast glyph, as on cornerstone viewports. */
export function WindowLevelReadout({ window, level }: WindowLevel) {
  return (
    <div style={corner({ left: 12, bottom: 8 })}>
      <div>{`W: ${Math.round(window)}  L: ${Math.round(level)}`}</div>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle
          cx="9"
          cy="9"
          r="7.5"
          fill="none"
          stroke="#5acce6"
          strokeWidth="1.5"
        />
        <path d="M9 1.5a7.5 7.5 0 0 0 0 15z" fill="#5acce6" />
      </svg>
    </div>
  )
}
