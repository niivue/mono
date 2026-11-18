import { expect, test } from 'bun:test'
import NiiVue, { SLICE_TYPE } from '@/index'
import type { AnnotationChangedDetail } from '@/NVEvents'
import type { VectorAnnotation } from '@/NVTypes'
import { annotationDelta } from './delta'
import { storeAnnotation } from './index'

function square(id: string, min = 0, max = 10, label = 1): VectorAnnotation {
  return {
    id,
    label,
    group: 'g',
    sliceType: SLICE_TYPE.AXIAL,
    slicePosition: 0,
    polygons: [
      {
        outer: [
          { x: min, y: min },
          { x: max, y: min },
          { x: max, y: max },
          { x: min, y: max },
        ],
        holes: [],
      },
    ],
    style: {
      fillColor: [1, 0, 0, 0.3],
      strokeColor: [1, 0, 0, 1],
      strokeWidth: 2,
    },
  }
}

test('reports added, changed and removed ids; unchanged clones are not updates', () => {
  const a = square('a')
  const before = [a, square('b'), square('c'), square('e')]
  const after = [
    a,
    { ...square('b'), text: 'note' },
    structuredClone(before[3]),
    square('d'),
  ]
  expect(annotationDelta(before, after)).toEqual({
    added: ['d'],
    updated: ['b'],
    removed: ['c'],
  })
})

test('a draw that merges reports the absorbed annotation as removed', () => {
  const before = [square('old', 0, 10), square('far', 50, 60)]
  const after = storeAnnotation(before, square('new', 5, 15), true)
  expect(annotationDelta(before, after)).toEqual({
    added: ['new'],
    updated: [],
    removed: ['old'],
  })
})

test('a draw cuts only the other-label annotations it overlaps', () => {
  const before = [square('hit', 0, 10, 2), square('miss', 50, 60, 2)]
  const after = storeAnnotation(before, square('new', 5, 15), true)
  expect(annotationDelta(before, after)).toEqual({
    added: ['new'],
    updated: ['hit'],
    removed: [],
  })
})

function listen(nv: NiiVue): AnnotationChangedDetail[] {
  const seen: AnnotationChangedDetail[] = []
  nv.addEventListener('annotationChanged', (e) => seen.push(e.detail))
  return seen
}

test('controller edits emit their ids', () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.addAnnotation(square('a'))
  nv.addAnnotation(square('b'))
  const seen = listen(nv)

  nv._annotationUndoStack.push(nv.model.annotations)
  nv.setAnnotationText('a', 'note')
  nv.annotationUndo()
  nv.annotationRedo()
  nv.clearAnnotations()

  expect(seen).toEqual([
    { action: 'move', added: [], updated: ['a'], removed: [] },
    { action: 'undo', added: [], updated: ['a'], removed: [] },
    { action: 'redo', added: [], updated: ['a'], removed: [] },
    { action: 'clear', added: [], updated: [], removed: ['a', 'b'] },
  ])
})

test('undo of a removal reports the restored id as added', () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.addAnnotation(square('a'))
  nv._annotationUndoStack.push(nv.model.annotations)
  nv.removeAnnotation('a')
  const seen = listen(nv)
  nv.annotationUndo()
  expect(seen).toEqual([
    { action: 'undo', added: ['a'], updated: [], removed: [] },
  ])
})

// A host mirrors each recorded step (annotationHistoryPush) in its own undo
// history: a batch removal is one step, and one undo brings all back.
test('undoable batch removal records one step and undoes as one', () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.addAnnotation(square('a'))
  nv.addAnnotation(square('b'))
  let pushes = 0
  nv.addEventListener('annotationHistoryPush', () => pushes++)
  const seen = listen(nv)
  nv.removeAnnotations(['a', 'b'], true)
  nv.annotationUndo()
  expect(pushes).toBe(1)
  expect(seen.map((d) => [d.action, d.removed, d.added])).toEqual([
    ['delete', ['a', 'b'], []],
    ['undo', [], ['a', 'b']],
  ])
})

test('removing the selected annotation clears the selection', () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.addAnnotation(square('a'))
  nv.addAnnotation(square('b'))
  nv.selectAnnotation('a')
  nv.removeAnnotation('a')
  const afterOne = nv.selectedAnnotation
  nv.selectAnnotation('b')
  nv.removeAnnotations(['b'])
  expect([afterOne, nv.selectedAnnotation]).toEqual([null, null])
})

test('clear and undo drop a selection whose annotation is gone', () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.addAnnotation(square('a'))
  nv.selectAnnotation('a')
  nv.clearAnnotations()
  const afterClear = nv.selectedAnnotation
  nv._annotationUndoStack.push(nv.model.annotations)
  nv.addAnnotation(square('b'))
  nv.selectAnnotation('b')
  nv.annotationUndo()
  expect([afterClear, nv.selectedAnnotation]).toEqual([null, null])
})
