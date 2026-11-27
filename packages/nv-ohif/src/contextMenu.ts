// Right-click on a NiiVue annotation opens OHIF's measurement context menu,
// as cornerstone's viewport click commands do (showCornerstoneContextMenu ->
// showContextMenu with 'measurementsContextMenu'); its items (delete, add
// label) act on the annotation's OHIF row, which syncs back to the canvas.
import type { NiiVue } from '@niivue/niivue'
import { useEffect } from 'react'
import { annotationAt } from './annotationHit'
import { isContourAnnotation } from './contourSeg'
import { reflectedRowUid } from './measurementReflection'
import type { OhifCommandsManager } from './ohif-types'
import { ANNOTATION_TO_OHIF } from './toolBridge'

export function useAnnotationContextMenu(
  nv: NiiVue | null,
  commandsManager: OhifCommandsManager | undefined,
): void {
  useEffect(() => {
    const canvas = nv?.canvas
    if (!nv || !canvas || !commandsManager) return
    const onContextMenu = (e: MouseEvent) => {
      // A half-drawn contour: Delete cancels it, as cornerstone's menu does.
      if (nv.isAnnotationInProgress) {
        e.preventDefault()
        commandsManager.runCommand('showContextMenu', {
          menus: [
            {
              id: 'niivueInProgress',
              items: [
                {
                  label: 'Delete',
                  commands: [{ commandName: 'niivueCancelAnnotation' }],
                },
              ],
            },
          ],
          element: canvas.parentElement,
          event: e,
          selectorProps: {},
        })
        return
      }
      // Measurements only: a contour segment under the pointer is not a row.
      const a = annotationAt(nv, e, (x) => !isContourAnnotation(x))
      const uid = a && reflectedRowUid(a.id)
      if (!a || !uid) return
      e.preventDefault()
      const toolName = ANNOTATION_TO_OHIF[a.shape?.type ?? 'freehand']?.toolName
      const nearbyToolData = { annotationUID: uid, metadata: { toolName } }
      commandsManager.runCommand('showContextMenu', {
        menuCustomizationId: 'measurementsContextMenu',
        element: canvas.parentElement,
        event: e,
        selectorProps: { nearbyToolData, value: nearbyToolData, uid, toolName },
      })
    }
    canvas.addEventListener('contextmenu', onContextMenu)
    return () => canvas.removeEventListener('contextmenu', onContextMenu)
  }, [nv, commandsManager])
}
