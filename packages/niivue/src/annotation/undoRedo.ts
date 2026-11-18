import type { VectorAnnotation } from '@/NVTypes'

type Entry<T> = { seq: number; snapshot: T }

/** Snapshots of an annotation list (volume, or a slide's `SlideAnnotation[]`). */
export class AnnotationUndoStack<T = VectorAnnotation[]> {
  private _undoStack: Entry<T>[] = []
  private _redoStack: Entry<T>[] = []
  private _maxSnapshots: number
  private _seq = 0
  /**
   * Called with each recorded step's sequence number. A host mirroring steps
   * in its own history replays one only while it is on top (undoTop/redoTop),
   * so a cleared or evicted step is never applied to another.
   */
  onPush?: (seq: number) => void

  constructor(maxSnapshots = 32) {
    this._maxSnapshots = maxSnapshots
  }

  push(snapshot: T): void {
    const seq = ++this._seq
    this._undoStack.push({ seq, snapshot: structuredClone(snapshot) })
    if (this._undoStack.length > this._maxSnapshots) {
      this._undoStack.shift()
    }
    this._redoStack.length = 0
    this.onPush?.(seq)
  }

  undo(current: T): T | null {
    const top = this._undoStack.pop()
    if (!top) return null
    // The step keeps its number on the redo side.
    this._redoStack.push({ seq: top.seq, snapshot: structuredClone(current) })
    return top.snapshot
  }

  redo(current: T): T | null {
    const top = this._redoStack.pop()
    if (!top) return null
    this._undoStack.push({ seq: top.seq, snapshot: structuredClone(current) })
    return top.snapshot
  }

  clear(): void {
    this._undoStack.length = 0
    this._redoStack.length = 0
  }

  get canUndo(): boolean {
    return this._undoStack.length > 0
  }

  get canRedo(): boolean {
    return this._redoStack.length > 0
  }

  /** Sequence number of the step the next undo reverts, if any. */
  get undoTop(): number | undefined {
    return this._undoStack.at(-1)?.seq
  }

  /** Sequence number of the step the next redo reapplies, if any. */
  get redoTop(): number | undefined {
    return this._redoStack.at(-1)?.seq
  }
}
