import { useState } from 'react'
import { Calculator, FileSearch, Play } from 'lucide-react'
import type { DesktopItem, VolumeMetadata } from '../domain/desktop'
import {
  pickNiimathMaskPath,
  runNiimathTask,
  type NiimathOperation,
  type NiimathTaskResult
} from '../domain/niimath'

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

export function NiimathOperationsPanel({
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
  const [isPickingMask, setIsPickingMask] = useState(false)
  const [taskStatus, setTaskStatus] = useState('Ready.')
  const [result, setResult] = useState<NiimathTaskResult | null>(null)
  const selectedOperation = NIIMATH_OPERATIONS.find((candidate) => candidate.id === operation) ?? NIIMATH_OPERATIONS[0]
  const sourcePath = typeof metadata?.sourcePath === 'string' ? metadata.sourcePath : ''
  const parsedOperand = Number(operand)
  const hasOperand = !selectedOperation.needsOperand || Number.isFinite(parsedOperand)
  const hasMask = !selectedOperation.needsMask || maskPath.trim().length > 0
  const canRun = Boolean(item && sourcePath && hasOperand && hasMask && !isRunning)

  async function chooseMask(): Promise<void> {
    if (isRunning || isPickingMask) return

    setIsPickingMask(true)
    setTaskStatus('Choosing mask volume.')
    try {
      const nextMaskPath = await pickNiimathMaskPath()
      if (!nextMaskPath) {
        setTaskStatus('Mask selection cancelled.')
        return
      }
      setMaskPath(nextMaskPath)
      setTaskStatus('Mask volume selected.')
      onStatus(`Selected niimath mask ${nextMaskPath}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTaskStatus(message)
      onStatus(message)
    } finally {
      setIsPickingMask(false)
    }
  }

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
            <span>Mask Volume</span>
            <span className="nv-path-picker">
              <input
                aria-label="Selected mask volume"
                className="nv-text-input"
                placeholder="Choose a mask volume"
                readOnly
                title={maskPath || undefined}
                type="text"
                value={maskPath}
              />
              <button
                aria-label="Choose mask volume"
                className="nv-icon-button nv-path-picker-button"
                disabled={isRunning || isPickingMask}
                onClick={() => void chooseMask()}
                title="Choose mask volume"
                type="button"
              >
                <FileSearch size={15} />
              </button>
            </span>
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
