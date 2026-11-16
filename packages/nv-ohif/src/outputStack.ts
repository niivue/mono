// A series dcm2niix converts to several single-slice outputs (orthogonal
// localizers) shows one at a time; as a cornerstone stack, the wheel steps
// through them in instance order and a jump to an image in another one
// switches to it.
import type { NiiVue } from '@niivue/niivue'
import { useEffect } from 'react'
import { centerCrosshair } from './commands'
import type { DicomConversion } from './dicomToNiivue'
import { updateNiivueViewport } from './niivueRegistry'
import type { OhifDisplaySet } from './ohif-types'
import { acquisitionSliceType } from './standardCommands'

export function useOutputStack(
  nv: NiiVue | null,
  viewportId: string,
  ds: OhifDisplaySet | undefined,
  conversion: DicomConversion | null,
): void {
  useEffect(() => {
    const canvas = nv?.canvas
    if (!nv || !canvas || !conversion?.alternates?.length) return
    const instances = (ds?.instances ?? []) as Array<{
      SOPInstanceUID?: string
    }>
    const order = (o: { sliceFrames?: DicomConversion['sliceFrames'] }) =>
      instances.findIndex(
        (i) => i.SOPInstanceUID === o.sliceFrames?.frames[0]?.SOPInstanceUID,
      )
    const outputs = [conversion, ...conversion.alternates].sort(
      (a, b) => order(a) - order(b),
    )
    let at = outputs.indexOf(conversion)
    let busy = false
    // Set on cleanup (a new series): a pending load must not install over it.
    let cancelled = false
    updateNiivueViewport(viewportId, {
      outputFrames: outputs.flatMap((o) =>
        o.sliceFrames ? [o.sliceFrames] : [],
      ),
    })
    const show = (i: number, then?: () => void): boolean => {
      const o = outputs[i]
      if (busy || i === at || !o) return false
      busy = true
      // Keep the window the user has.
      const calMin = nv.volumes[0]?.cal_min as number | undefined
      const calMax = nv.volumes[0]?.cal_max as number | undefined
      void nv
        .prepareVolume({ url: o.image, name: o.image.name, calMin, calMax })
        .then((v) => (cancelled ? undefined : nv.loadVolumes([v])))
        .then(() => {
          if (cancelled) return
          at = i
          updateNiivueViewport(viewportId, { sliceFrames: o.sliceFrames })
          const plane = acquisitionSliceType(nv)
          if (plane !== undefined) nv.sliceType = plane
          centerCrosshair(nv)
          then?.()
        })
        .finally(() => {
          busy = false
        })
      return true
    }
    const onWheel = (e: WheelEvent) => {
      // A single slice has nowhere to scroll: step to the next output.
      if (nv.volumes[0]?.dims?.[3] !== 1 || !e.deltaY) return
      e.preventDefault()
      e.stopImmediatePropagation()
      show(at + Math.sign(e.deltaY))
    }
    canvas.addEventListener('wheel', onWheel, { capture: true, passive: false })
    updateNiivueViewport(viewportId, {
      switchToInstance: (sop, then) =>
        show(
          outputs.findIndex((o) =>
            o.sliceFrames?.frames.some((f) => f?.SOPInstanceUID === sop),
          ),
          then,
        ),
    })
    return () => {
      cancelled = true
      canvas.removeEventListener('wheel', onWheel, { capture: true })
      updateNiivueViewport(viewportId, {
        switchToInstance: undefined,
        outputFrames: undefined,
      })
    }
  }, [nv, viewportId, ds, conversion])
}
