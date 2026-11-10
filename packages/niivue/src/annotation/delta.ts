import type { VectorAnnotation } from '@/NVTypes'

export type AnnotationDelta = {
  added: string[]
  updated: string[]
  removed: string[]
}

/**
 * Ids added, updated or removed between two annotation lists. Untouched
 * annotations keep their object, so identity settles most; content is
 * compared only for replaced objects and for undo/redo clones.
 */
export function annotationDelta(
  before: readonly VectorAnnotation[],
  after: readonly VectorAnnotation[],
): AnnotationDelta {
  const old = new Map(before.map((a) => [a.id, a]))
  const added: string[] = []
  const updated: string[] = []
  for (const ann of after) {
    const prev = old.get(ann.id)
    if (!prev) added.push(ann.id)
    // ponytail: O(points) per replaced annotation; undo already clones that much.
    else if (prev !== ann && JSON.stringify(prev) !== JSON.stringify(ann))
      updated.push(ann.id)
    old.delete(ann.id)
  }
  return { added, updated, removed: [...old.keys()] }
}
