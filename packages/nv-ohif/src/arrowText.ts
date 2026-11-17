// An arrow's free text through OHIF's own dialog, as cornerstone's
// ArrowAnnotate asks for it (its getTextCallback / changeTextCallback run the
// 'arrowTextCallback' command): when one is drawn, and on a double-click of the
// selected arrow. The text becomes the annotation's, so the row label follows.
import type { NiiVue } from '@niivue/niivue'
import { useEffect } from 'react'
import { annotationAt } from './annotationHit'
import type { OhifCommandsManager } from './ohif-types'

/** Ids being added by code right now (SR import): no prompt for those. */
export const programmaticAnnotations = new Set<string>()

export function useArrowText(
  nv: NiiVue | null,
  viewportId: string,
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
    const onAdded = (e: Event) => {
      const a = (
        e as CustomEvent<{
          annotation?: { id: string; shape?: { type?: string } }
        }>
      ).detail?.annotation
      if (a?.shape?.type !== 'arrow' || programmaticAnnotations.has(a.id))
        return
      ask(a.id, '', true)
    }
    const onDoubleClick = (e: MouseEvent) => {
      const a = annotationAt(
        nv,
        viewportId,
        e,
        (x) => x.shape?.type === 'arrow',
      )
      if (a) ask(a.id, a.text ?? '', false)
    }
    const canvas = nv.canvas
    nv.addEventListener('annotationAdded', onAdded)
    canvas?.addEventListener('dblclick', onDoubleClick)
    return () => {
      nv.removeEventListener('annotationAdded', onAdded)
      canvas?.removeEventListener('dblclick', onDoubleClick)
    }
  }, [nv, viewportId, commandsManager])
}
