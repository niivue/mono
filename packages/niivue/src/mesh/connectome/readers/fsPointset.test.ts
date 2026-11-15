import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { devImageUrl } from '@/testing/headless'
import { read } from './fsPointset'

// FreeSurfer pointsets (Freeview control points) read as node-only
// connectomes; `.json` is generic, so the content picks the reader.

const POINTS = devImageUrl('meshes/fs/FreeSurferControlPoints.json')
const bytes = (json: unknown) =>
  new TextEncoder().encode(JSON.stringify(json)).buffer

test('a pointset reads as named nodes with no edges', async () => {
  const buffer = await (await fetch(POINTS)).arrayBuffer()
  const { data, options } = await read(buffer)
  expect(data.nodes.map((n) => n.name).slice(0, 2)).toEqual([
    'Anterior Commissure',
    'Insula',
  ])
  expect(data.nodes).toHaveLength(4)
  expect(data.nodes[0].x).toBeCloseTo(-0.5207, 3)
  expect(data.edges).toEqual([])
  expect(options.nodeColormap).toBe('warm')
})

test('a JCON saved as .json still reads; other JSON is refused', async () => {
  const jcon = { nodes: [{ name: 'a', x: 1, y: 2, z: 3 }], edges: [] }
  expect((await read(bytes(jcon))).data.nodes[0].name).toBe('a')
  await expect(read(bytes({ EchoTime: 0.03 }))).rejects.toThrow(
    'neither a FreeSurfer pointset',
  )
})

test('a pointset loads by URL and from a dropped file', async () => {
  const byUrl = new NiiVue({ backend: 'webgl2' })
  await byUrl.loadMeshes([{ url: POINTS }])
  expect(byUrl.meshes[0].kind).toBe('connectome')

  // loadFiles (drag and drop): the pointset loads; a real sidecar does not.
  const dropped = new NiiVue({ backend: 'webgl2' })
  const file = new File([await (await fetch(POINTS)).arrayBuffer()], 'cp.json')
  const sidecar = new File([JSON.stringify({ EchoTime: 0.03 })], 'x.json')
  await dropped.loadFiles([file, sidecar])
  expect(dropped.meshes.map((m) => m.kind)).toEqual(['connectome'])
})
