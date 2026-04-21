import earcut from 'earcut'
import type { AnnotationPoint } from '@/NVTypes'

export function triangulatePolygon(
  outer: AnnotationPoint[],
  holes?: AnnotationPoint[][],
): { vertices: Float32Array; indices: Uint32Array } {
  const coords: number[] = []
  const holeIndices: number[] = []

  for (const p of outer) {
    coords.push(p.x, p.y)
  }

  if (holes) {
    for (const hole of holes) {
      holeIndices.push(coords.length / 2)
      for (const p of hole) {
        coords.push(p.x, p.y)
      }
    }
  }

  const indices = earcut(
    coords,
    holeIndices.length > 0 ? holeIndices : undefined,
    2,
  )
  return {
    vertices: new Float32Array(coords),
    indices: new Uint32Array(indices),
  }
}
