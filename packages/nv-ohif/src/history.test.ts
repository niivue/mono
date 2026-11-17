import { expect, mock, test } from 'bun:test'
import NiiVue from '@niivue/niivue'
import * as React from 'react'

const effects: Array<() => void> = []
mock.module('react', () => ({
  ...React,
  useEffect: (fn: () => void) => effects.push(fn),
}))
const { useAnnotationHistory } = await import('./history')

// OHIF's history: a stack of memos replayed undo-first / redo-first.
function hostMemo() {
  const done: Array<{ restoreMemo: (u?: boolean) => void }> = []
  const undone: typeof done = []
  return {
    push: (m: (typeof done)[number]) => {
      done.push(m)
      undone.length = 0
    },
    undo: () => {
      const m = done.pop()
      if (!m) return
      m.restoreMemo(true)
      undone.push(m)
    },
    redo: () => {
      const m = undone.pop()
      if (!m) return
      m.restoreMemo(false)
      done.push(m)
    },
  }
}

function usePane(memo: ReturnType<typeof hostMemo>, ids: string[]) {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  nv.model.annotations = ids.map((id) => ({ id })) as never
  const libs = {
    cornerstone: { utilities: { HistoryMemo: { DefaultHistoryMemo: memo } } },
  }
  useAnnotationHistory(nv, {
    getModuleEntry: () => ({
      exports: { getCornerstoneLibraries: () => libs },
    }),
  })
  effects.pop()?.()
  return nv
}
const ids = (nv: NiiVue) => nv.annotations.map((a) => a.id)

// R14 audit: a memo whose step was cleared (series swap) or evicted (core
// keeps 32 steps) must be inert, never replaying another step.
test('stale and evicted memos never replay another step', () => {
  const swap = hostMemo()
  const a = usePane(swap, ['old'])
  a.removeAnnotation('old', true)
  a.clearAnnotations() // a series swap
  a.model.annotations = [{ id: 'new' }] as never
  a.removeAnnotation('new', true)
  swap.undo()
  swap.undo()
  expect(ids(a)).toEqual(['new'])
  swap.redo() // the old series' deletion: inert
  expect(ids(a)).toEqual(['new'])
  swap.redo()
  expect(ids(a)).toEqual([])

  const evict = hostMemo()
  const names = Array.from({ length: 33 }, (_, i) => `a${i}`)
  const b = usePane(evict, names)
  for (const id of names) b.removeAnnotation(id, true)
  for (let i = 0; i < 33; i++) evict.undo()
  expect(ids(b)).toEqual(names.slice(1)) // a0's step was evicted
  evict.redo() // a0's deletion: inert, does not delete a1
  expect(ids(b)).toEqual(names.slice(1))
})
