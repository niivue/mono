import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NVSignalSpectroscopyRaw } from '@/NVTypes'
import { parseSidecar } from '../sidecar'
import { read } from './nii'

const SIGNALS_DIR = join(
  import.meta.dir,
  '../../../../dev-images/images/signals',
)

function toArrayBuffer(stem: string): ArrayBuffer {
  const buf = readFileSync(join(SIGNALS_DIR, stem))
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer
}

describe('nii signal reader (real NIfTI-MRS SVS)', () => {
  test('parsesComplexFidGeometry', async () => {
    const buffer = toArrayBuffer('svs_se_30.nii.gz')
    const raw = (await read(buffer)) as NVSignalSpectroscopyRaw
    expect(raw.kind).toBe('spectroscopy')
    expect(raw.nPoints).toBe(1024)
    expect(raw.nTransients).toBe(64)
    // complex64: interleaved real/imag => 2 floats per complex sample
    expect(raw.fid.length).toBe(1024 * 64 * 2)
    expect(raw.dwell).toBeCloseTo(0.0005, 7)
    // First complex sample from the fixture (real, imag).
    expect(raw.fid[0]).toBeCloseTo(33184.0234375, 2)
    expect(raw.fid[1]).toBe(0)
  })

  test('mergesMrsSidecar', async () => {
    const buffer = toArrayBuffer('svs_se_30.nii.gz')
    const json = JSON.parse(
      readFileSync(join(SIGNALS_DIR, 'svs_se_30.json'), 'utf8'),
    )
    const raw = (await read(
      buffer,
      'svs_se_30.nii.gz',
      parseSidecar(json),
    )) as NVSignalSpectroscopyRaw
    expect(raw.spectrometerFreq).toBeCloseTo(297.155, 3)
    expect(raw.nucleus).toBe('1H')
  })

  test('defaultsNucleusWithoutSidecar', async () => {
    const buffer = toArrayBuffer('svs_se_30.nii.gz')
    const raw = (await read(buffer)) as NVSignalSpectroscopyRaw
    expect(raw.spectrometerFreq).toBeNull()
    expect(raw.nucleus).toBe('1H')
  })
})
