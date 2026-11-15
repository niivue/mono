import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { devImageUrl } from '@/testing/headless'
import { read } from './annot'

/** A big-endian FreeSurfer .annot: vertex colours, then a colour table. */
function annot(
  vertexStruct: number[],
  table: [name: string, r: number, g: number, b: number, a: number][],
): ArrayBuffer {
  const enc = new TextEncoder()
  const names = table.map(([n]) => enc.encode(`${n}\0`))
  const size =
    4 +
    8 * vertexStruct.length +
    16 +
    4 +
    4 +
    names.reduce((s, n) => s + 8 + n.length + 16, 0)
  const view = new DataView(new ArrayBuffer(size))
  let p = 0
  const i32 = (v: number) => {
    view.setInt32(p, v, false)
    p += 4
  }
  i32(vertexStruct.length)
  vertexStruct.forEach((s, v) => {
    const [, r, g, b] = table[s]
    i32(v)
    i32(r + (g << 8) + (b << 16))
  })
  i32(1) // tag: colour table
  i32(-2) // current version
  i32(table.length) // max structure
  i32(0) // no file name
  i32(table.length)
  table.forEach(([, r, g, b, a], s) => {
    i32(s)
    i32(names[s].length)
    new Uint8Array(view.buffer, p, names[s].length).set(names[s])
    p += names[s].length
    for (const c of [r, g, b, a]) i32(c)
  })
  return view.buffer
}

test('vertices take their structure index, named by the colour table', () => {
  const buf = annot(
    [1, 0, 2, 1],
    [
      ['unknown', 25, 5, 25, 255],
      ['insula', 255, 192, 32, 0],
      ['cuneus', 220, 180, 140, 128],
    ],
  )
  const { values, colormapLabel } = read(buf, 4)
  expect(Array.from(values)).toEqual([1, 0, 2, 1])
  expect(colormapLabel?.labels).toEqual(['unknown', 'insula', 'cuneus'])
  // The fourth table channel is transparency: 255 transparent, 0 opaque.
  const alpha = [0, 1, 2].map((s) => colormapLabel?.lut[s * 4 + 3])
  expect(alpha).toEqual([0, 255, 127])
})

test('a vertex count that does not match the mesh is refused', () => {
  expect(() => read(annot([0], [['unknown', 1, 2, 3, 255]]), 2)).toThrow(
    'ANNOT has 1 vertices but the mesh has 2',
  )
})

test('a FreeSurfer annotation layers onto its surface', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadMeshes([
    {
      url: devImageUrl('meshes/fs/lh.pial'),
      layers: [{ url: devImageUrl('meshes/fs/boggle.lh.annot') }],
    },
  ])
  const layer = nv.meshes[0].layers[0]
  expect(layer.colormapLabel?.labels?.slice(0, 2)).toEqual([
    'unknown',
    'bankssts',
  ])
  expect(new Set(layer.values).size).toBeGreaterThan(30)
})
