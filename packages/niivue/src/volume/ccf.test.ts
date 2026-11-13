import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { documentFile, parseJsonDocument } from '@/testing/headless'
import {
  allenIds,
  allenStructures,
  ccfColormap,
  readCcfNrrd,
} from '@/volume/ccf'

// 2x2x2 uint32 annotation as Allen writes it: unitless 25 um spacing, LPS.
const RAW = [0, 0, 7, 2097152, 614454277, 4294967295, 7, 999]
const nrrd = (): ArrayBuffer => {
  const header = new TextEncoder().encode(
    'NRRD0004\ntype: unsigned int\ndimension: 3\nspace: left-posterior-superior\nsizes: 2 2 2\nspace directions: (25,0,0) (0,25,0) (0,0,25)\nendian: little\nencoding: raw\nspace origin: (0,0,0)\n\n',
  )
  const out = new Uint8Array(header.length + RAW.length * 4)
  out.set(header)
  out.set(new Uint8Array(Uint32Array.from(RAW).buffer), header.length)
  return out.buffer
}
const node = (id: number, acronym: string, hex: string) => ({
  id,
  acronym,
  name: `${acronym} name`,
  color_hex_triplet: hex,
})
// 999 is absent from the ontology.
const structures = allenStructures({
  msg: [
    {
      ...node(7, 'A', 'FF0000'),
      children: [
        node(2097152, 'B', '00FF00'),
        node(614454277, 'C', '0000FF'),
        node(4294967295, 'D', '010203'),
      ],
    },
  ],
})

test('CCF annotation: large IDs compact losslessly, scale is mm, orientation PIR, labels carry Allen IDs', async () => {
  const { volume, ids } = await readCcfNrrd(nrrd(), 'annotation')
  if (!ids) throw new Error('annotation must return ids')
  const { colormap, missing } = ccfColormap(ids, structures)
  const compact = volume.img as Uint16Array

  expect(compact).toBeInstanceOf(Uint16Array)
  expect(compact[0]).toBe(0)
  expect([...allenIds(compact, ids)]).toEqual(RAW)
  expect(missing).toEqual([999])
  expect(volume.hdr.pixDims.slice(1, 4)).toEqual([0.025, 0.025, 0.025])
  // PIR: R = +axis 2, A = -axis 0, S = -axis 1.
  expect(volume.hdr.affine.slice(0, 3).map((r) => r.slice(0, 3))).toEqual([
    [0, 0, 0.025],
    [-0.025, 0, 0],
    [0, -0.025, 0],
  ])
  expect(colormap.A[0]).toBe(0)
  const k = ids.indexOf(614454277)
  expect(colormap.labels?.[k]).toBe('C C name (614454277)')
  expect([colormap.R[k], colormap.G[k], colormap.B[k]]).toEqual([0, 0, 255])
})

test('CCF annotation: a saved document restores the mapping and scale', async () => {
  const { volume, ids } = await readCcfNrrd(nrrd(), 'annotation')
  if (!ids) throw new Error('annotation must return ids')
  const nv = new NiiVue({ backend: 'webgl2' })
  volume.colormap = nv.addColormap(
    'ccf-test',
    ccfColormap(ids, structures).colormap,
  )
  await nv.loadVolumes([volume])

  const json = nv.serializeDocument({ format: 'json' })
  // The registry is page-wide, so check the document itself carries the table.
  const saved = parseJsonDocument(json) as {
    colormaps: Record<string, { labels: string[] }>
  }
  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(json, 'ccf.json'))
  const restored = nv2.volumes[0]
  const lut = restored.colormapLabel

  expect(saved.colormaps[volume.colormap].labels).toContain(
    'B B name (2097152)',
  )
  expect(restored.hdr.pixDims.slice(1, 4)).toEqual([0.025, 0.025, 0.025])
  expect(restored.hdr.affine).toEqual(volume.hdr.affine)
  expect(lut?.labels?.[ids.indexOf(2097152)]).toBe('B B name (2097152)')
  expect([...allenIds(restored.img as Uint16Array, ids)]).toEqual(RAW)
})
