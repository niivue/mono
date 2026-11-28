import type { NiiVue, VectorAnnotation } from '@niivue/niivue'

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
