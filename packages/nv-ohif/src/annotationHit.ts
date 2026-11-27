import {
  type AnnotationPoint,
  type NiiVue,
  slice2DToMM,
  type VectorAnnotation,
} from '@niivue/niivue'

/** Canvas px of a slice-2D point of `a`, or null off the layout. */
export function toCanvas(
  nv: NiiVue,
  a: VectorAnnotation,
  p: AnnotationPoint,
): AnnotationPoint | null {
  return nv.mmToCanvas(slice2DToMM(p, a.slicePosition, a.sliceType))
}

/** The drawn annotation under a pointer event (core's pickAnnotation). */
export function annotationAt(
  nv: NiiVue,
  e: MouseEvent,
  accept?: (a: VectorAnnotation) => boolean,
): VectorAnnotation | undefined {
  const xy = nv.clientToCanvas(e.clientX, e.clientY)
  return (
    (xy && nv.pickAnnotation(xy[0], xy[1], { accept })?.annotation) || undefined
  )
}
