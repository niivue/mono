import { expect, spyOn, test } from 'bun:test'
import NiiVue from '@/index'
import * as NVMesh from '@/mesh/NVMesh'
import { devImageUrl, documentFile } from '@/testing/headless'

// Linked documents through serializeDocument({ linkData, linkUrl }) and
// loadDocument({ resolveUrl }): volumes and meshes saved by bundle id and
// mapped back to fetchable URLs on load.

const SPHERE = devImageUrl('volumes/sphere.nii.gz')
const LH = devImageUrl('meshes/BrainMesh_ICBM152.lh.mz3')
const CURV = devImageUrl('meshes/BrainMesh_ICBM152.lh.curv')
const SCALARS = devImageUrl('meshes/CIT168.mz3')
const JCON = devImageUrl('meshes/connectome.jcon')
const TRACT = devImageUrl('meshes/tract.SLF1_R.tck')

type Doc = {
  volumes: { url?: string; data?: unknown }[]
  meshes: {
    url?: string
    data?: unknown
    connectomeData?: unknown
    tractData?: unknown
    layers?: { url?: string; data?: unknown }[]
  }[]
}
const toJson = (bytes: Uint8Array): Doc =>
  JSON.parse(new TextDecoder().decode(bytes))

// Bundle ids keep the file extension: the mesh loader dispatches on it.
const ids = new Map([
  [SPHERE, 't1.nii.gz'],
  [LH, 'm1.mz3'],
  [JCON, 'c1.jcon'],
])
const urls = new Map([...ids].map(([url, id]) => [id, url]))
const linkUrl = (url: string) => ids.get(url) ?? null
const resolveUrl = (id: string) => urls.get(id) ?? id

test('linkUrl writes bundle ids that resolveUrl maps back: volume and mesh with a layer', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: SPHERE, calMin: 10 }])
  await nv.loadMeshes([
    { url: LH, layers: [{ url: CURV, colormap: 'hot', opacity: 0.6 }] },
  ])
  await nv.setMeshLayerProperty(0, 0, { calMax: 0.4 })
  const src = nv.meshes[0]

  const doc = toJson(
    nv.serializeDocument({ linkData: true, linkUrl, format: 'json' }),
  )
  // Layer values are embedded and the url is omitted, so an older reader
  // (which refetches layer urls on the URL path) skips the layer, not the mesh.
  expect(doc.meshes[0].layers?.length).toBe(1)
  expect(doc.meshes[0].layers?.[0]?.url).toBeUndefined()

  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(JSON.stringify(doc), 'doc.json'), {
    resolveUrl,
  })
  const m = nv2.meshes[0]

  expect(doc.volumes[0]).toMatchObject({ url: 't1.nii.gz' })
  expect(doc.volumes[0].data).toBeUndefined()
  expect(doc.meshes[0]).toMatchObject({ url: 'm1.mz3' })
  expect(doc.meshes[0].data).toBeUndefined()
  expect(nv2.volumes[0]?.url).toBe(SPHERE)
  expect(nv2.volumes[0]?.calMin).toBe(10)
  expect(m?.url).toBe(LH)
  expect(m?.layers.length).toBe(1)
  expect(m?.layers[0]).toMatchObject({
    colormap: 'hot',
    opacity: 0.6,
    calMax: 0.4,
  })
  expect(m?.layers[0].values).toEqual(src.layers[0].values)
  expect(m?.colors).toEqual(src.colors)
})

test('a linked mesh whose file scalars were removed does not regain them', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadMeshes([{ url: SCALARS }])
  const fileLayers = nv.meshes[0].layers.length
  await nv.removeMeshLayer(0, 0)
  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(nv.serializeDocument({ linkData: true })))
  expect(fileLayers).toBe(1) // the reader's inline scalars
  expect(nv2.meshes[0]?.url).toBe(SCALARS)
  expect(nv2.meshes[0]?.layers.length).toBe(0)
  expect(nv2.meshes[0]?.colors).toEqual(nv.meshes[0].colors)
})

test('a linked connectome keeps its options and hidden flag', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadMeshes([{ url: JCON, connectomeOptions: { nodeScale: 7 } }])
  await nv.setMesh(0, { visible: false, isLegendVisible: false })
  const bytes = nv.serializeDocument({ linkData: true, linkUrl })
  const doc = toJson(
    nv.serializeDocument({ linkData: true, linkUrl, format: 'json' }),
  )

  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(bytes), { resolveUrl })
  const m = nv2.meshes[0]

  expect(doc.meshes[0].url).toBe('c1.jcon')
  expect(doc.meshes[0].connectomeData).toBeUndefined()
  expect(m?.kind).toBe('connectome')
  expect(m?.connectomeOptions?.nodeScale).toBe(7)
  expect(m?.visible).toBe(false)
  expect(m?.isLegendVisible).toBe(false)
  expect(m?.positions).toEqual(nv.meshes[0].positions)
})

test('a tract embeds under linkData: its load-time scalars are not recorded', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadMeshes([{ url: TRACT }])
  const seen: string[] = []
  const doc = toJson(
    nv.serializeDocument({
      linkData: true,
      linkUrl: (url) => {
        seen.push(url)
        return 'x.tck'
      },
      format: 'json',
    }),
  )
  expect(seen).toEqual([])
  expect(doc.meshes[0].url).toBe(TRACT)
  expect(doc.meshes[0].tractData).toBeDefined()
})

test('a volume and a mesh with no fetchable URL embed, and linkUrl is not asked', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: SPHERE }])
  await nv.loadMeshes([{ url: LH }])
  // As from a drag-drop: an object URL that will not outlive the page.
  nv.volumes[0].url = 'blob:https://app/1'
  nv.meshes[0].url = 'blob:https://app/2'
  const seen: string[] = []
  const bytes = nv.serializeDocument({
    linkData: true,
    linkUrl: (url) => {
      seen.push(url)
      return url
    },
  })
  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(bytes), { resolveUrl: () => null })

  expect(seen).toEqual([])
  expect(nv2.volumes[0]?.img?.length).toBe(nv.volumes[0].img?.length)
  expect(nv2.meshes[0]?.positions).toEqual(nv.meshes[0].positions)
})

test('linkUrl returning null embeds that volume and mesh', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: SPHERE }])
  await nv.loadMeshes([{ url: LH }])
  const bytes = nv.serializeDocument({ linkData: true, linkUrl: () => null })
  const doc = toJson(
    nv.serializeDocument({
      linkData: true,
      linkUrl: () => null,
      format: 'json',
    }),
  )
  // A resolver that refuses every link proves nothing is refetched.
  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(bytes), { resolveUrl: () => null })

  expect(doc.volumes[0].data).toBeDefined()
  expect(doc.meshes[0].data).toBeDefined()
  expect(nv2.volumes[0]?.img?.length).toBe(nv.volumes[0].img?.length)
  expect(nv2.meshes[0]?.positions).toEqual(nv.meshes[0].positions)
})

test('linked meshes reload in document order', async () => {
  const make = (url: string) =>
    NVMesh.createMesh(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      new Uint32Array([0, 1, 2]),
      new Uint32Array(3),
      { url, name: url },
    )
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.meshes.push(make('slow.mz3'), make('fast.mz3'))
  const doc = nv.serializeDocument({ linkData: true })
  const spy = spyOn(NVMesh, 'loadMesh').mockImplementation(async (opts) => {
    const url = String(opts.url)
    if (url === 'slow.mz3') await Bun.sleep(20)
    return make(url)
  })
  try {
    const nv2 = new NiiVue({ backend: 'webgl2' })
    await nv2.loadDocument(documentFile(doc))
    expect(nv2.meshes.map((m) => m.name)).toEqual(['slow.mz3', 'fast.mz3'])
  } finally {
    spy.mockRestore()
  }
})
