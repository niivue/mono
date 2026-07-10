/**
 * Make a NIfTI header survive `postMessage`.
 *
 * nifti-reader-js defines several of NIFTI1's methods as CLASS FIELDS
 * (`getDatatypeCodeString = function (code) {...}`), so they are own properties
 * of every instance, not prototype methods. The structured clone algorithm walks
 * own enumerable properties and throws on a function — so posting an `NVImage`
 * straight out of the volume-load worker always failed with "could not be
 * cloned", and every volume silently fell back to a main-thread decode.
 *
 * The fix is a data-only snapshot across the wire, rehydrated into a real
 * instance on the far side so the header keeps its methods (`toFormattedString`,
 * `getDatatypeCodeString`, ...). Functions live on the fresh instance; only data
 * is copied over them.
 */

// The runtime classes, used to rebuild an instance and to discriminate the two.
// NiiVue's own `NIFTIHeader` (NVTypes) is a STRUCTURAL type — both NIFTI1 and
// NIFTI2 alias it — so the signatures below speak in that type.
import { NIFTI1 as NIFTI1Class, NIFTI2 as NIFTI2Class } from 'nifti-reader-js'
import type { NIFTIHeader } from '@/NVTypes'

/** Data-only header snapshot, plus the class needed to rebuild it. */
export type TransferableHdr = Record<string, unknown> & {
  __hdrKind: 'NIFTI1' | 'NIFTI2'
}

/** Strip the own-property functions so the header is structured-cloneable. */
export function hdrToTransferable(hdr: NIFTIHeader): TransferableHdr {
  const out: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(hdr)) {
    const value = (hdr as unknown as Record<string, unknown>)[key]
    if (typeof value === 'function') continue
    out[key] = value
  }
  out.__hdrKind = hdr instanceof NIFTI2Class ? 'NIFTI2' : 'NIFTI1'
  return out as TransferableHdr
}

/**
 * Rebuild a header instance from a snapshot. The fresh instance supplies the
 * methods; `Object.assign` copies the data fields over them (the snapshot never
 * contains functions, so it cannot clobber a method).
 */
export function hdrFromTransferable(plain: TransferableHdr): NIFTIHeader {
  const { __hdrKind, ...data } = plain
  const hdr = __hdrKind === 'NIFTI2' ? new NIFTI2Class() : new NIFTI1Class()
  Object.assign(hdr, data)
  return hdr as unknown as NIFTIHeader
}

/** True when `value` looks like a snapshot produced by `hdrToTransferable`. */
export function isTransferableHdr(value: unknown): value is TransferableHdr {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { __hdrKind?: unknown }).__hdrKind
  return kind === 'NIFTI1' || kind === 'NIFTI2'
}
