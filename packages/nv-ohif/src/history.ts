// NiiVue annotation edits in OHIF's undo history: cornerstone's
// DefaultHistoryMemo drives OHIF's undo/redo commands and toolbar buttons, so
// each step core records (annotationHistoryPush) becomes one memo there and
// both viewers undo in one order. OHIF's "delete all" records its own group
// (annotation memos + tracking state); the NiiVue rows it cleared are removed
// as one step that joins that group, so a single undo restores them all.
import type { NiiVue } from '@niivue/niivue'
import { useEffect } from 'react'
import { removeAnnotationsForRows } from './commands'
import { cornerstoneLibraries } from './niivueRegistry'
import type { OhifExtensionManager, OhifServicesManager } from './ohif-types'

type Memo = {
  id: string
  restoreMemo: (undo?: boolean) => void
  source?: object
  seq?: number
  // The ring as the push found it: a withdrawn step puts it back (redo too).
  before?: { slot: unknown; undoAvailable: number; redoAvailable: number }
}
type HistoryMemo = {
  push: (memo: Memo) => void
  // Internal ring; read only to join a group OHIF has just recorded (groups
  // do not nest, so it cannot be wrapped from outside).
  ring?: unknown[]
  position?: number
  size?: number
  undoAvailable?: number
  redoAvailable?: number
}

export function historyMemo(
  extensionManager: OhifExtensionManager | undefined,
): HistoryMemo | undefined {
  const libs = cornerstoneLibraries<{
    cornerstone?: {
      utilities?: { HistoryMemo?: { DefaultHistoryMemo?: HistoryMemo } }
    }
  }>(extensionManager)
  return libs?.cornerstone?.utilities?.HistoryMemo?.DefaultHistoryMemo
}

/** A recorder of annotation steps: a NiiVue, or a slide's NVSlideAnnotations
 * (point edits only: its adds and removes are not steps). */
type StepSource = Pick<
  NiiVue,
  | 'annotationUndoTop'
  | 'annotationRedoTop'
  | 'annotationUndo'
  | 'annotationRedo'
> &
  Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

// Set while "delete all" removes its NiiVue rows: their step joins OHIF's group.
let joinGroupAt: number | undefined

function record(memo: HistoryMemo, nv: StepSource, seq: number): void {
  // Replays only its own step: one cleared (series swap) or evicted (core keeps
  // fewer steps than OHIF) is never on top again, so it is inert rather than
  // undoing or redoing another step.
  const step: Memo = {
    id: crypto.randomUUID(),
    source: nv,
    seq,
    restoreMemo: (undo) => {
      if (undo && nv.annotationUndoTop === seq) nv.annotationUndo()
      else if (!undo && nv.annotationRedoTop === seq) nv.annotationRedo()
    },
  }
  const group =
    joinGroupAt !== undefined && memo.position === joinGroupAt
      ? memo.ring?.[joinGroupAt]
      : undefined
  // First in the group: undo restores a group last-first, so the rows return
  // after OHIF has restored the tracking state they belong to.
  if (Array.isArray(group)) group.unshift(step)
  else {
    const { ring, position, size, undoAvailable, redoAvailable } = memo
    if (ring && position !== undefined && size)
      step.before = {
        slot: ring[(position + 1) % size],
        undoAvailable: undoAvailable ?? 0,
        redoAvailable: redoAvailable ?? 0,
      }
    memo.push(step)
  }
}

/** Mirror `nv`'s recorded annotation steps in OHIF's undo history; returns the unbinder. */
export function mirrorAnnotationHistory(
  nv: StepSource,
  extensionManager: OhifExtensionManager | undefined,
): () => void {
  const memo = historyMemo(extensionManager)
  if (!memo) return () => {}
  const onPush = (e: Event) =>
    record(memo, nv, (e as CustomEvent<{ seq: number }>).detail.seq)
  nv.addEventListener('annotationHistoryPush', onPush)
  return () => nv.removeEventListener('annotationHistoryPush', onPush)
}

/**
 * Take back the step `nv` recorded for an add a handler withdraws as it lands
 * (a CalibrationLine), and its OHIF memo, so no Undo is spent on it and the
 * Redo the step cleared comes back. The handler has already removed the add.
 */
export function withdrawLastStep(
  nv: Pick<NiiVue, 'annotationUndoTop' | '_annotationUndoStack'>,
  extensionManager: OhifExtensionManager | undefined,
): void {
  const seq = nv.annotationUndoTop
  if (seq === undefined) return
  nv._annotationUndoStack.discard(seq)
  const memo = historyMemo(extensionManager)
  const { ring, position, size } = memo ?? {}
  if (!memo || !ring || position === undefined || !size) return
  const top = ring[position] as Memo | undefined
  if (top?.source !== nv || top.seq !== seq || !top.before) return
  ring[position] = top.before.slot
  memo.position = (position - 1 + size) % size
  memo.undoAvailable = top.before.undoAvailable
  memo.redoAvailable = top.before.redoAvailable
}

/** {@link mirrorAnnotationHistory} for a viewport's NiiVue. */
export function useAnnotationHistory(
  nv: NiiVue | null,
  extensionManager: OhifExtensionManager | undefined,
): void {
  useEffect(
    () => (nv ? mirrorAnnotationHistory(nv, extensionManager) : undefined),
    [nv, extensionManager],
  )
}

type Row = { uid: string; source?: { name?: string } }
type MeasurementService = {
  getMeasurements: () => Row[]
  getMeasurement: (uid: string) => Row | undefined
  clearMeasurements: (...args: unknown[]) => unknown
  __nvClear?: true
}

/** Make OHIF's clearMeasurements remove its NiiVue rows' annotations (once). */
export function installClearHistory(
  servicesManager: OhifServicesManager | undefined,
  extensionManager: OhifExtensionManager | undefined,
): void {
  const ms = servicesManager?.services?.measurementService as
    | MeasurementService
    | undefined
  if (!ms?.clearMeasurements || ms.__nvClear) return
  ms.__nvClear = true
  const clear = ms.clearMeasurements.bind(ms)
  ms.clearMeasurements = (...args) => {
    const niivueRows = ms
      .getMeasurements()
      .filter((m) => m.source?.name === 'NiiVue')
    const memo = historyMemo(extensionManager)
    const before = memo?.position
    const result = clear(...args)
    const gone = niivueRows
      .map((m) => m.uid)
      .filter((uid) => !ms.getMeasurement(uid))
    // OHIF recorded a group during the clear: join it.
    joinGroupAt = memo?.position !== before ? memo?.position : undefined
    try {
      removeAnnotationsForRows(gone)
    } finally {
      joinGroupAt = undefined
    }
    return result
  }
}
