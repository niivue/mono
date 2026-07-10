import { describe, expect, test } from 'bun:test'
import { NIFTI1, NIFTI2 } from 'nifti-reader-js'
import {
  hdrFromTransferable,
  hdrToTransferable,
  isTransferableHdr,
} from './hdrTransfer'

describe('hdrTransfer', () => {
  test('a raw NIfTI header is NOT structured-cloneable (the bug)', () => {
    // nifti-reader-js declares these as class fields, so they are own properties
    // and postMessage rejects the object. This is why the volume-load worker
    // always failed over to a main-thread decode.
    const hdr = new NIFTI1()
    const ownFns = Object.getOwnPropertyNames(hdr).filter(
      (k) =>
        typeof (hdr as unknown as Record<string, unknown>)[k] === 'function',
    )
    expect(ownFns.length).toBeGreaterThan(0)
    expect(() => structuredClone(hdr)).toThrow()
  })

  test('a snapshot survives structuredClone and rebuilds with its methods', () => {
    const hdr = new NIFTI1()
    hdr.datatypeCode = 2
    hdr.dims = [3, 4, 5, 6, 1, 1, 1, 1]
    hdr.pixDims = [1, 2, 2, 2, 1, 1, 1, 1]
    hdr.scl_slope = 1.5
    hdr.scl_inter = -3

    const wire = hdrToTransferable(hdr)
    const cloned = structuredClone(wire) // exactly what postMessage does
    const back = hdrFromTransferable(cloned)

    expect(back).toBeInstanceOf(NIFTI1)
    const m = back as unknown as {
      getDatatypeCodeString: (c: number) => string
      toFormattedString: () => string
    }
    expect(back.datatypeCode).toBe(2)
    expect(back.dims).toEqual([3, 4, 5, 6, 1, 1, 1, 1])
    expect(back.pixDims).toEqual([1, 2, 2, 2, 1, 1, 1, 1])
    expect(back.scl_slope).toBe(1.5)
    expect(back.scl_inter).toBe(-3)
    // The methods came back with the fresh instance.
    expect(typeof m.getDatatypeCodeString).toBe('function')
    expect(m.getDatatypeCodeString(2)).toBe('1-Byte Unsigned Integer')
    expect(typeof m.toFormattedString).toBe('function')
  })

  test('NIFTI2 round-trips as a NIFTI2, not a NIFTI1', () => {
    const hdr = new NIFTI2()
    hdr.datatypeCode = 16
    hdr.dims = [3, 8, 8, 8, 1, 1, 1, 1]

    const back = hdrFromTransferable(structuredClone(hdrToTransferable(hdr)))
    expect(back).toBeInstanceOf(NIFTI2)
    expect(back.datatypeCode).toBe(16)
    expect(back.dims).toEqual([3, 8, 8, 8, 1, 1, 1, 1])
  })

  test('the snapshot carries no functions', () => {
    const wire = hdrToTransferable(new NIFTI1())
    const fns = Object.values(wire).filter((v) => typeof v === 'function')
    expect(fns).toHaveLength(0)
    expect(wire.__hdrKind).toBe('NIFTI1')
  })

  test('header extensions survive the round-trip', () => {
    // MRSI/NIfTI-MRS reads ecode 44 off hdr.extensions; only its data is used.
    const hdr = new NIFTI1()
    ;(hdr as unknown as { extensions: unknown[] }).extensions = [
      { esize: 16, ecode: 44, edata: new Uint8Array([1, 2, 3]).buffer },
    ]
    const back = hdrFromTransferable(structuredClone(hdrToTransferable(hdr)))
    const exts = (back as unknown as { extensions: { ecode: number }[] })
      .extensions
    expect(exts).toHaveLength(1)
    expect(exts[0].ecode).toBe(44)
  })

  test('isTransferableHdr discriminates snapshots from live headers', () => {
    expect(isTransferableHdr(hdrToTransferable(new NIFTI1()))).toBe(true)
    expect(isTransferableHdr(hdrToTransferable(new NIFTI2()))).toBe(true)
    expect(isTransferableHdr(new NIFTI1())).toBe(false)
    expect(isTransferableHdr(null)).toBe(false)
    expect(isTransferableHdr({})).toBe(false)
    expect(isTransferableHdr({ __hdrKind: 'NOPE' })).toBe(false)
  })
})
