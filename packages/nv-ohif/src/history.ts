// NiiVue annotation edits in OHIF's undo history: cornerstone's
// DefaultHistoryMemo drives OHIF's undo/redo commands and toolbar buttons, so
// each step core records (annotationHistoryPush) becomes one memo there and
// both viewers undo in one order. OHIF's "delete all" records its own group
// (annotation memos + tracking state); the NiiVue rows it cleared are removed
// as one step that joins that group, so a single undo restores them all.
import type { NiiVue } from '@niivue/niivue'
import { useEffect } from 'react'
import { removeAnnotationsForRows } from './commands'
import type { OhifExtensionManager, OhifServicesManager } from './ohif-types'

type Memo = { id: string; restoreMemo: (undo?: boolean) => void }
type HistoryMemo = {
  push: (memo: Memo) => void
  // Internal ring; read only to join a group OHIF has just recorded (groups
  // do not nest, so it cannot be wrapped from outside).
  ring?: unknown[]
  position?: number
}

const CORNERSTONE_COMMON = '@ohif/extension-cornerstone.utilityModule.common'

export function historyMemo(
  extensionManager: OhifExtensionManager | undefined,
): HistoryMemo | undefined {
  const entry = extensionManager?.getModuleEntry(CORNERSTONE_COMMON) as
    | { exports?: { getCornerstoneLibraries?: () => unknown } }
    | undefined
  const libs = entry?.exports?.getCornerstoneLibraries?.() as
    | {
        cornerstone?: {
          utilities?: { HistoryMemo?: { DefaultHistoryMemo?: HistoryMemo } }
        }
      }
    | undefined
  return libs?.cornerstone?.utilities?.HistoryMemo?.DefaultHistoryMemo
}

// Set while "delete all" removes its NiiVue rows: their step joins OHIF's group.
let joinGroupAt: number | undefined

function record(memo: HistoryMemo, nv: NiiVue, seq: number): void {
  // Replays only its own step: one cleared (series swap) or evicted (core keeps
  // fewer steps than OHIF) is never on top again, so it is inert rather than
  // undoing or redoing another step.
  const step: Memo = {
    id: crypto.randomUUID(),
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
  else memo.push(step)
}

/** Mirror `nv`'s recorded annotation steps in OHIF's undo history. */
export function useAnnotationHistory(
  nv: NiiVue | null,
  extensionManager: OhifExtensionManager | undefined,
): void {
  useEffect(() => {
    const memo = historyMemo(extensionManager)
    if (!nv || !memo) return
    const onPush = (e: Event) =>
      record(memo, nv, (e as CustomEvent<{ seq: number }>).detail.seq)
    nv.addEventListener('annotationHistoryPush', onPush)
    return () => nv.removeEventListener('annotationHistoryPush', onPush)
  }, [nv, extensionManager])
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
