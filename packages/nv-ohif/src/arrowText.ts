// An arrow's free text through OHIF's own dialog, as cornerstone's
// ArrowAnnotate asks for it (its getTextCallback / changeTextCallback run the
// 'arrowTextCallback' command): when one is drawn, and on a double-click of the
// selected arrow. The text becomes the annotation's, so the row label follows.
import type { NiiVue, VectorAnnotation } from '@niivue/niivue'
import { useEffect } from 'react'
import { annotationAt } from './annotationHit'
import type { OhifCommandsManager } from './ohif-types'
import { onAnnotationsDrawn } from './toolBridge'

export function useArrowText(
  nv: NiiVue | null,
  commandsManager: OhifCommandsManager | undefined,
): void {
  useEffect(() => {
    if (!nv || !commandsManager) return
    // A new arrow saved with empty text is dropped, as cornerstone's
    // ArrowAnnotate does; an existing one keeps its edit.
    const ask = (id: string, label: string, isNew: boolean) =>
      commandsManager.runCommand('arrowTextCallback', {
        callback: (text: unknown) => {
          if (typeof text !== 'string') return
          if (isNew && !text) nv.removeAnnotation(id)
          else nv.setAnnotationText(id, text)
        },
        data: { data: { label } },
      })
    // Only an arrow the user draws asks: one SR import adds does not.
    const onDrawn = (a: VectorAnnotation) => {
      if (a.shape?.type === 'arrow') ask(a.id, '', true)
    }
    const onDoubleClick = (e: MouseEvent) => {
      const a = annotationAt(nv, e, (x) => x.shape?.type === 'arrow')
      if (a) ask(a.id, a.text ?? '', false)
    }
    const canvas = nv.canvas
    const offDrawn = onAnnotationsDrawn(nv, onDrawn)
    canvas?.addEventListener('dblclick', onDoubleClick)
    return () => {
      offDrawn()
      canvas?.removeEventListener('dblclick', onDoubleClick)
    }
  }, [nv, commandsManager])
}
