import type { VectorAnnotation } from "@/NVTypes"

export class AnnotationUndoStack {
  private _undoStack: VectorAnnotation[][] = []
  private _redoStack: VectorAnnotation[][] = []
  private _maxSnapshots: number

  constructor(maxSnapshots = 32) {
    this._maxSnapshots = maxSnapshots
  }

  push(snapshot: VectorAnnotation[]): void {
    this._undoStack.push(structuredClone(snapshot))
    if (this._undoStack.length > this._maxSnapshots) {
      this._undoStack.shift()
    }
    this._redoStack.length = 0
  }

  undo(current: VectorAnnotation[]): VectorAnnotation[] | null {
    if (this._undoStack.length === 0) return null
    this._redoStack.push(structuredClone(current))
    return this._undoStack.pop()!
  }

  redo(current: VectorAnnotation[]): VectorAnnotation[] | null {
    if (this._redoStack.length === 0) return null
    this._undoStack.push(structuredClone(current))
    return this._redoStack.pop()!
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
}
