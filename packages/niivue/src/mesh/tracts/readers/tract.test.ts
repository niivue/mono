import { describe, expect, test } from 'bun:test'
import NiiVue from '@/index'
import { loadMesh, meshExtensions } from '@/mesh/NVMesh'
import { getFileExt } from '@/NVLoader'
import { documentFile } from '@/testing/headless'
import { nimlTract } from '@/testing/nimlTract'
import { read } from './tract'

function replaceHeader(from: string, to: string): ArrayBuffer {
  const data = Buffer.from(nimlTract())
  const pos = data.indexOf(from)
  expect(pos).toBeGreaterThanOrEqual(0)
  return Uint8Array.from(
    Buffer.concat([
      data.subarray(0, pos),
      Buffer.from(to),
      data.subarray(pos + from.length),
    ]),
  ).buffer
}

describe('AFNI NIML tracts', () => {
  for (const littleEndian of [true, false]) {
    test(`reads ${littleEndian ? 'little' : 'big'} endian bundles in RAS mm`, async () => {
      const data = await read(nimlTract(littleEndian).buffer)
      expect(Array.from(data.vertices)).toEqual([
        -1, -2, 3, -4, -5, 6, -7, -8, 9, -10, -11, 12, -13, -14, 15, 1, 2, -3,
        4, 5, -6,
      ])
      expect(Array.from(data.offsets)).toEqual([0, 2, 5, 7])
      expect(Array.from(data.dps.tract)).toEqual([21, 21, 47])
    })
  }

  test('keeps distinct int32 bundle tags above 2^24, across a document round-trip', async () => {
    const bytes = Buffer.from(
      replaceHeader('Bundle_Tag="21"', 'Bundle_Tag="16777216"'),
    )
    const at = bytes.indexOf('Bundle_Tag="47"')
    const tagged = Buffer.concat([
      bytes.subarray(0, at),
      Buffer.from('Bundle_Tag="16777217"'),
      bytes.subarray(at + 'Bundle_Tag="47"'.length),
    ])
    const expected = [16777216, 16777216, 16777217]
    const data = await read(Uint8Array.from(tagged).buffer)
    expect(Array.from(data.dps.tract)).toEqual(expected)

    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.loadMeshes([{ url: new File([tagged], 'big.niml.tract') }])
    const nv2 = new NiiVue({ backend: 'webgl2' })
    await nv2.loadDocument(documentFile(nv.serializeDocument(), 'big.nvd'))
    const tract = nv2.meshes[0]?.trx?.dps.tract
    expect(tract).toBeInstanceOf(Int32Array)
    expect(Array.from(tract ?? [])).toEqual(expected)
  })

  test('rejects a bundle tag outside int32', async () => {
    await expect(
      read(replaceHeader('Bundle_Tag="21"', 'Bundle_Tag="2147483648"')),
    ).rejects.toThrow('NIML tract bundle')
  })

  test('routes a local .niml.tract through the shared mesh loader', async () => {
    const file = new File([nimlTract()], 'bundles.niml.tract')
    expect(meshExtensions()).toContain(getFileExt(file))
    expect(getFileExt('https://example.org/bundles.niml.tract?v=1')).toBe(
      'TRACT',
    )
    const mesh = await loadMesh({
      url: file,
      tractOptions: { colorBy: 'dps:tract' },
    })
    expect(mesh.kind).toBe('tract')
    expect(mesh.trx?.offsets).toEqual(new Uint32Array([0, 2, 5, 7]))
    expect(mesh.trx?.dpsMeta.tract).toEqual({ globalMin: 21, globalMax: 47 })
    expect(mesh.positions.length).toBeGreaterThan(0)
    expect(mesh.indices.length).toBeGreaterThan(0)
  })

  for (const [from, to] of [
    ['N_tracts="3"', 'N_tracts="9999999999"'],
    ['N_tracts="3"', 'N_tracts="-1"'],
    ['N_tracts="3"', 'N_tracts="NaN"'],
    ['ni_dimen="2"', 'ni_dimen="4"'],
    ['ni_dimen="2"', 'ni_dimen="-1"'],
    ['ni_dimen="2"', 'ni_dimen="1.5"'],
    ['binary.lsbfirst', 'text'],
    ['TAYLOR_TRACT_DATUM', '3*float'],
    ['</tracts>', '</network>'],
  ]) {
    test(`rejects ${to}`, async () => {
      await expect(read(replaceHeader(from, to))).rejects.toThrow('NIML')
    })
  }

  for (const count of [-3, 5, 0x7fffffff]) {
    test(`rejects invalid coordinate count ${count}`, async () => {
      const bytes = nimlTract()
      const start =
        Buffer.from(bytes).indexOf('Bundle_Tag="21">') +
        'Bundle_Tag="21">'.length
      new DataView(bytes.buffer).setInt32(start + 4, count, true)
      await expect(read(bytes.buffer)).rejects.toThrow('point count')
    })
  }

  test('rejects truncated headers and records', async () => {
    const bytes = nimlTract()
    const start =
      Buffer.from(bytes).indexOf('Bundle_Tag="21">') + 'Bundle_Tag="21">'.length
    for (const end of [0, 20, start + 4, start + 12, bytes.length - 30]) {
      await expect(read(bytes.slice(0, end).buffer)).rejects.toThrow('NIML')
    }
  })
})
