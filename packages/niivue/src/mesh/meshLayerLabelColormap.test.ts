import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import {
  captureWarnings,
  devImageUrl,
  documentFile,
  serveDevImages,
} from '@/testing/headless'

// A mesh layer given a label colormap looks colours up by ID, as a volume
// does: label 0 stays transparent and IDs do not blend. At load a layer keeps
// the label table its file carried unless a label colormap replaces it; later
// a change to a continuous colormap clears it.

const MESH = devImageUrl('meshes/cortex_5124.mz3')
const N_VERT = 5124 // vertices in cortex_5124.mz3

/** A GIfTI label layer holding `id(i)` at vertex i, with or without a table. */
function giftiLabels(id: (i: number) => number, withTable: boolean): string {
  const ids = Array.from({ length: N_VERT }, (_, i) => id(i)).join(' ')
  const table = withTable
    ? '<LabelTable>\n' +
      '<Label Key="0" Red="0" Green="0" Blue="0" Alpha="0"><![CDATA[bg]]></Label>\n' +
      '<Label Key="1" Red="1" Green="0" Blue="0" Alpha="1"><![CDATA[a]]></Label>\n' +
      '<Label Key="2" Red="0" Green="1" Blue="0" Alpha="1"><![CDATA[b]]></Label>\n' +
      '</LabelTable>\n'
    : ''
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<GIFTI Version="1.0" NumberOfDataArrays="1">\n' +
    table +
    '<DataArray Intent="NIFTI_INTENT_LABEL" DataType="NIFTI_TYPE_INT32" ' +
    `ArrayIndexingOrder="RowMajorOrder" Dimensionality="1" Dim0="${N_VERT}" ` +
    'Encoding="ASCII" Endian="LittleEndian" ExternalFileName="" ExternalFileOffset="">\n' +
    `<Data>${ids}</Data>\n</DataArray>\n</GIFTI>\n`
  )
}

// IDs 0, 1, 2 repeating, as a GIfTI label file with its own table.
const gifti = (withTable: boolean) =>
  new File(
    [giftiLabels((i) => i % 3, withTable)],
    withTable ? 'table.label.gii' : 'plain.label.gii',
  )

// Layers that load with the mesh, or from a URL document, come by URL.
const server = serveDevImages({
  '/fixture/table.label.gii': giftiLabels((i) => i % 3, true),
  '/fixture/binary.label.gii': giftiLabels((i) => i % 2, false),
})

const lut = (l: { colormapLabel?: { min?: number; max?: number } | null }) =>
  l.colormapLabel ? [l.colormapLabel.min, l.colormapLabel.max] : null
const rgb = (c: number) => [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff]

async function loadMesh(): Promise<NiiVue> {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadMeshes([{ url: MESH }])
  expect(nv.meshes[0].positions.length / 3).toBe(N_VERT)
  return nv
}

test('mesh layers follow label colormaps', async () => {
  const nv = await loadMesh()
  const m = nv.meshes[0]
  const base = m.colors[0]
  nv.addColormap('meshLayerLabels', {
    R: [0, 0, 0],
    G: [0, 0, 0],
    B: [0, 0, 255],
    A: [0, 0, 255],
    labels: ['bg', 'none', 'blue'],
  })

  // addMeshLayer with a label colormap: label 0 shows the base colour.
  await nv.addMeshLayer(0, {
    url: gifti(false),
    colormap: 'meshLayerLabels',
    opacity: 1,
  })
  const added = {
    lut: lut(m.layers[0]),
    label0IsBase: m.colors[0] === base,
    label2: rgb(m.colors[2]),
  }

  // setMeshLayerProperty: a continuous colormap clears, a label one restores.
  await nv.setMeshLayerProperty(0, 0, { colormap: 'warm' })
  const continuous = lut(m.layers[0])
  await nv.setMeshLayerProperty(0, 0, { colormap: 'Random' })
  const random = { lut: lut(m.layers[0]), label0IsBase: m.colors[0] === base }
  await nv.removeMeshLayer(0, 0)

  // A file label table survives a load without a colormap and later edits
  // that do not name one.
  await nv.addMeshLayer(0, { url: gifti(true) })
  const fromFile = lut(m.layers[0])
  await nv.setMeshLayerProperty(0, 0, { opacity: 0.4 })
  const afterOpacity = lut(m.layers[0])
  // Resending the current colormap (as a threshold slider does) keeps it.
  await nv.setMeshLayerProperty(0, 0, {
    colormap: m.layers[0].colormap,
    calMin: 0,
  })
  const afterSameColormap = lut(m.layers[0])
  await nv.removeMeshLayer(0, 0)

  // A continuous colormap at load leaves the file's table; a different one
  // set later clears it.
  await nv.addMeshLayer(0, { url: gifti(true), colormap: 'warm' })
  const fileKept = lut(m.layers[0])
  await nv.setMeshLayerProperty(0, 0, { colormap: 'gray' })
  const fileCleared = lut(m.layers[0])

  expect({
    added,
    continuous,
    random,
    fromFile,
    afterOpacity,
    afterSameColormap,
    fileKept,
    fileCleared,
  }).toEqual({
    added: { lut: [0, 2], label0IsBase: true, label2: [0, 0, 255] },
    continuous: null,
    random: { lut: [0, 255], label0IsBase: true },
    fromFile: [0, 2],
    afterOpacity: [0, 2],
    afterSameColormap: [0, 2],
    fileKept: [0, 2],
    fileCleared: null,
  })
})

test('mesh layers loaded with the mesh, and re-registered tables', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  // A layer whose vertex count does not match is dropped with a warning,
  // which would leave nothing to test.
  const warnings = captureWarnings()
  nv.addColormap('meshLayerTable', {
    R: [0, 255],
    G: [0, 0],
    B: [0, 0],
    labels: [],
  })
  await nv.loadMeshes([
    {
      url: MESH,
      layers: [
        {
          url: server.url('/fixture/binary.label.gii'),
          colormap: 'meshLayerTable',
        },
      ],
    },
  ])
  warnings.restore()
  expect(warnings.messages).toEqual([])
  const layer = nv.meshes[0].layers[0]
  const loaded = lut(layer)
  const colors = () => Array.from(nv.meshes[0].colors)
  const before = colors()
  // Re-registering the table with more IDs rebuilds the layer's LUT and
  // recomposites, so the surface matches the legend at once.
  nv.addColormap('meshLayerTable', {
    R: [0, 0, 0],
    G: [0, 0, 255],
    B: [0, 0, 0],
    labels: [],
  })
  const reRegistered = lut(layer)
  const isRecomposited = colors().some((c, i) => c !== before[i])
  // Re-registering it as a continuous colormap clears the label LUT.
  nv.addColormap('meshLayerTable', { R: [0, 255], G: [0, 0], B: [0, 0] })

  expect({ loaded, reRegistered, isRecomposited }).toEqual({
    loaded: [0, 1],
    reRegistered: [0, 2],
    isRecomposited: true,
  })
  expect(layer.colormapLabel).toBeNull()
})

test('a URL document keeps a layer label table read from its file', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadMeshes([
    {
      url: MESH,
      layers: [{ url: server.url('/fixture/table.label.gii'), opacity: 1 }],
    },
  ])
  // As a legacy or hand-written document: the mesh and its layer by URL
  // only, the layer naming the default colormap ('warm').
  const doc = JSON.parse(
    new TextDecoder().decode(
      nv.serializeDocument({ format: 'json', linkData: true }),
    ),
  )
  const docMesh = doc.meshes[0]
  delete docMesh.data
  for (const k of Object.keys(docMesh.layers[0]))
    if (!['url', 'colormap', 'opacity'].includes(k)) delete docMesh.layers[0][k]

  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(JSON.stringify(doc), 'labels.json'))
  const m = nv2.meshes[0]
  const l = m.layers[0]
  expect({
    colormap: l.colormap,
    lut: lut(l),
    label1: rgb(m.colors[1]),
  }).toEqual({ colormap: 'warm', lut: [0, 2], label1: [255, 0, 0] })
})

test('a document keeps a mesh layer hiddenLabels', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadMeshes([
    {
      url: MESH,
      layers: [{ url: server.url('/fixture/table.label.gii'), opacity: 1 }],
    },
  ])
  await nv.setMeshLayerProperty(0, 0, { hiddenLabels: [1] })
  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(nv.serializeDocument()))
  const m = nv2.meshes[0]
  expect(m.layers[0].hiddenLabels).toEqual([1])
  // Label 1 shows the mesh beneath; label 2 keeps its colour.
  expect(rgb(m.colors[1])).not.toEqual([255, 0, 0])
  expect(rgb(m.colors[2])).toEqual([0, 255, 0])
})
