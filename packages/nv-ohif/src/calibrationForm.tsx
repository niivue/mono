import { useEffect, useState } from 'react'
import {
  calibrationEvents,
  calibrationScale,
  setCalibrationScale,
} from './calibration'
import type { OhifServices } from './ohif-types'

// OHIF's CalibrationLine dialog (callInputDialog in CalibrationLineTool.ts),
// which nv-ohif cannot import: the actual distance, defaulting to the measured.
function CalibrationForm({
  value,
  done,
}: {
  value: string
  done: (text: string | null) => void
}) {
  const [text, setText] = useState(value)
  return (
    <form
      data-cy="niivue-calibration-form"
      style={{ display: 'flex', gap: 8, color: '#d1d5db' }}
      onSubmit={(e) => {
        e.preventDefault()
        done(text)
      }}
    >
      <input
        data-cy="calibration-distance"
        // biome-ignore lint/a11y/noAutofocus: the dialog's only field
        autoFocus
        // Typing replaces the prefilled distance rather than appending to it.
        onFocus={(e) => e.currentTarget.select()}
        placeholder="Actual Physical distance (mm)"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="button" onClick={() => done(null)}>
        Cancel
      </button>
      <button type="submit">Save</button>
    </form>
  )
}

/** Resolves the entered text, or null when cancelled. */
export function askCalibrationDistance(
  services: OhifServices | undefined,
  value: string,
): Promise<string | null> {
  const modal = services?.uiModalService
  if (!modal?.show) return Promise.resolve(window.prompt('Calibration', value))
  return new Promise((resolve) =>
    modal.show?.({
      content: CalibrationForm,
      title: 'Calibration',
      contentProps: {
        value,
        done: (text: string | null) => {
          modal.hide?.()
          resolve(text)
        },
      },
      // A modal closed from its X resolves nothing; the line is already gone.
    }),
  )
}

/** The pane's Calibrated marker; its button returns to native measurements. */
export function CalibratedMarker({
  displaySetUID,
}: {
  displaySetUID?: string
}) {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const update = () => setScale(calibrationScale(displaySetUID))
    update()
    calibrationEvents.addEventListener('change', update)
    return () => calibrationEvents.removeEventListener('change', update)
  }, [displaySetUID])
  if (scale === 1 || !displaySetUID) return null
  return (
    <div
      data-calibration-scale={scale}
      style={{
        position: 'absolute',
        // Above the display menu's W/L button, which shares the bottom centre.
        bottom: 28,
        left: '50%',
        transform: 'translateX(-50%)',
        color: '#fbbf24',
        font: '12px sans-serif',
      }}
    >
      Calibrated{' '}
      <button
        type="button"
        data-cy="calibration-reset"
        title="Reset to native measurements"
        onClick={() => setCalibrationScale(displaySetUID, 1)}
      >
        Reset
      </button>
    </div>
  )
}
