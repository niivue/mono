import { describe, expect, test } from 'bun:test'
import { AnnotationUndoStack } from './undoRedo'

describe('AnnotationUndoStack', () => {
  test('canUndo_initiallyFalse', () => {
    const stack = new AnnotationUndoStack()
    expect(stack.canUndo).toBe(false)
  })

  test('canRedo_initiallyFalse', () => {
    const stack = new AnnotationUndoStack()
    expect(stack.canRedo).toBe(false)
  })

  test('push_then_canUndo_isTrue', () => {
    const stack = new AnnotationUndoStack()
    stack.push([])
    expect(stack.canUndo).toBe(true)
  })

  test('undo_restoresPreviousSnapshot', () => {
    const stack = new AnnotationUndoStack()
    const snapshot1 = [
      {
        id: 'a',
        label: 1,
        group: 'g',
        sliceType: 0,
        slicePosition: 0,
        polygons: [],
        style: {
          fillColor: [1, 0, 0, 1] as [number, number, number, number],
          strokeColor: [1, 0, 0, 1] as [number, number, number, number],
          strokeWidth: 2,
        },
      },
    ]
    stack.push(snapshot1)
    const current = [
      {
        id: 'b',
        label: 2,
        group: 'g',
        sliceType: 0,
        slicePosition: 0,
        polygons: [],
        style: {
          fillColor: [0, 1, 0, 1] as [number, number, number, number],
          strokeColor: [0, 1, 0, 1] as [number, number, number, number],
          strokeWidth: 2,
        },
      },
    ]
    const restored = stack.undo(current)
    expect(restored).not.toBeNull()
    expect(restored?.[0].id).toBe('a')
  })

  test('redo_afterUndo_restoresUndoneState', () => {
    const stack = new AnnotationUndoStack()
    const snap = [
      {
        id: 'a',
        label: 1,
        group: 'g',
        sliceType: 0,
        slicePosition: 0,
        polygons: [],
        style: {
          fillColor: [1, 0, 0, 1] as [number, number, number, number],
          strokeColor: [1, 0, 0, 1] as [number, number, number, number],
          strokeWidth: 2,
        },
      },
    ]
    stack.push(snap)
    const current = [
      {
        id: 'b',
        label: 2,
        group: 'g',
        sliceType: 0,
        slicePosition: 0,
        polygons: [],
        style: {
          fillColor: [0, 1, 0, 1] as [number, number, number, number],
          strokeColor: [0, 1, 0, 1] as [number, number, number, number],
          strokeWidth: 2,
        },
      },
    ]
    const undone = stack.undo(current)
    expect(undone).not.toBeNull()
    expect(stack.canRedo).toBe(true)
    const redone = stack.redo(undone ?? [])
    expect(redone).not.toBeNull()
    expect(redone?.[0].id).toBe('b')
  })

  test('push_clearsRedoStack', () => {
    const stack = new AnnotationUndoStack()
    stack.push([])
    stack.undo([])
    expect(stack.canRedo).toBe(true)
    stack.push([])
    expect(stack.canRedo).toBe(false)
  })

  test('push_exceedsMaxSnapshots_dropsOldest', () => {
    const stack = new AnnotationUndoStack(3)
    stack.push([{ id: '1' }] as never)
    stack.push([{ id: '2' }] as never)
    stack.push([{ id: '3' }] as never)
    stack.push([{ id: '4' }] as never) // should evict '1'
    // Undo 3 times: should get 4, 3, 2 (not 1)
    const r1 = stack.undo([])
    expect(r1?.[0].id).toBe('4')
    const r2 = stack.undo(r1 ?? [])
    expect(r2?.[0].id).toBe('3')
    const r3 = stack.undo(r2 ?? [])
    expect(r3?.[0].id).toBe('2')
    // No more undos
    const r4 = stack.undo(r3 ?? [])
    expect(r4).toBeNull()
  })

  test('clear_resetsStacks', () => {
    const stack = new AnnotationUndoStack()
    stack.push([])
    stack.push([])
    stack.clear()
    expect(stack.canUndo).toBe(false)
    expect(stack.canRedo).toBe(false)
  })

  test('undo_emptyStack_returnsNull', () => {
    const stack = new AnnotationUndoStack()
    expect(stack.undo([])).toBeNull()
  })

  test('redo_emptyStack_returnsNull', () => {
    const stack = new AnnotationUndoStack()
    expect(stack.redo([])).toBeNull()
  })
})
