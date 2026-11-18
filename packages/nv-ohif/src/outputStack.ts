// A series dcm2niix converts to several single-slice outputs (orthogonal
// localizers) shows one at a time; as a cornerstone stack, the wheel steps
// through them in instance order and a jump to an image in another one
// switches to it.
import type { NiiVue } from '@niivue/niivue'
import { useEffect, useRef } from 'react'
import { centerCrosshair } from './commands'
import type { DicomConversion } from './dicomToNiivue'
import { updateNiivueViewport } from './niivueRegistry'
import type { OhifDisplaySet } from './ohif-types'
import { acquisitionSliceType } from './standardCommands'

/**
 * Cornerstone draws an image as stored. NiiVue's radiological view (patient
 * right on screen left: NIfTI +x is right, DICOM +x left) mirrors one without
 * orientation (a secondary capture lacking ImageOrientationPatient: dcm2niix
 * writes qform/sform code 0 with voxel i along +x), so such an image is shown
 * unflipped, without orientation labels.
 */
export function matchStoredOrientation(nv: NiiVue): void {
  const h = nv.volumes[0]?.hdr
  const isOriented = !(h && !h.qform_code && !h.sform_code)
  nv.isRadiological = isOriented
  // No patient directions to label, as cornerstone shows none.
  nv.isOrientationTextVisible = isOriented
}

export function useOutputStack(
  nv: NiiVue | null,
  viewportId: string,
  ds: OhifDisplaySet | undefined,
  conversion: DicomConversion | null,
  /** After an output swaps in (its overlay planes follow it). */
  onOutput?: (o: Pick<DicomConversion, 'overlayPlanes'>) => void,
): void {
  // Latest callback, read at swap time: a new closure must not re-run the effect.
  const onOutputRef = useRef(onOutput)
  onOutputRef.current = onOutput
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
    // Requests queue behind the load in flight; only the latest one loads.
    let latest = 0
    let queue: Promise<void> | undefined
    // Set on cleanup (a new series): a pending load must not install over it.
    let cancelled = false
    const load = async (i: number, request: number) => {
      const o = outputs[i]
      if (!o || cancelled || request !== latest || i === at) return
      // Keep the window the user has.
      const calMin = nv.volumes[0]?.cal_min as number | undefined
      const calMax = nv.volumes[0]?.cal_max as number | undefined
      const v = await nv.prepareVolume({
        url: o.image,
        name: o.image.name,
        calMin,
        calMax,
      })
      if (cancelled) return
      await nv.loadVolumes([v])
      if (cancelled) return
      matchStoredOrientation(nv)
      at = i
      updateNiivueViewport(viewportId, { sliceFrames: o.sliceFrames })
      const plane = acquisitionSliceType(nv)
      if (plane !== undefined) nv.sliceType = plane
      centerCrosshair(nv)
      onOutputRef.current?.(o)
    }
    // Resolves true once output i is shown, if no later request came meanwhile.
    const show = (i: number): Promise<boolean> | undefined => {
      if (!outputs[i] || (i === at && !queue)) return undefined
      const request = ++latest
      const done = queue ? queue.then(() => load(i, request)) : load(i, request)
      const tail: Promise<void> = done
        .catch(() => {})
        .then(() => {
          if (queue === tail) queue = undefined
        })
      queue = tail
      return done.then(() => !cancelled && request === latest)
    }
    const onWheel = (e: WheelEvent) => {
      // A single slice has nowhere to scroll: step to the next output.
      if (nv.volumes[0]?.dims?.[3] !== 1 || !e.deltaY) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void show(at + Math.sign(e.deltaY))
    }
    canvas.addEventListener('wheel', onWheel, { capture: true, passive: false })
    updateNiivueViewport(viewportId, {
      outputFrames: outputs.flatMap((o) =>
        o.sliceFrames ? [o.sliceFrames] : [],
      ),
      switchToInstance: (sop, frameNumber) =>
        show(
          outputs.findIndex((o) =>
            o.sliceFrames?.frames.some(
              (f) =>
                f?.SOPInstanceUID === sop &&
                (frameNumber === undefined || f.frameNumber === frameNumber),
            ),
          ),
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
