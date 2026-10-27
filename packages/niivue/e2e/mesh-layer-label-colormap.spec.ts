import { expect, test } from '@playwright/test'

// A mesh layer given a label colormap looks colours up by ID, as a volume
// does: label 0 stays transparent and IDs do not blend. Without a colormap a
// layer keeps the label table its file carried; a continuous colormap clears
// it.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const MESH = '/meshes/BrainMesh_ICBM152.lh.mz3'

test('mesh layers follow label colormaps', async ({ page }) => {
  test.setTimeout(120_000)

  const result = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(canvas)
    await nv.loadMeshes([{ url: '${MESH}' }])
    const m = nv.meshes[0]
    const nVert = m.positions.length / 3
    const base = m.colors[0]

    // IDs 0, 1, 2 repeating, as a GIfTI label file with its own table.
    const ids = Array.from({ length: nVert }, (_, i) => i % 3)
    const gifti = (withTable) => new File([
      '<?xml version="1.0" encoding="UTF-8"?>\\n',
      '<GIFTI Version="1.0" NumberOfDataArrays="1">\\n',
      withTable
        ? '<LabelTable>\\n' +
          '<Label Key="0" Red="0" Green="0" Blue="0" Alpha="0"><![CDATA[bg]]></Label>\\n' +
          '<Label Key="1" Red="1" Green="0" Blue="0" Alpha="1"><![CDATA[a]]></Label>\\n' +
          '<Label Key="2" Red="0" Green="1" Blue="0" Alpha="1"><![CDATA[b]]></Label>\\n' +
          '</LabelTable>\\n'
        : '',
      '<DataArray Intent="NIFTI_INTENT_LABEL" DataType="NIFTI_TYPE_INT32" ',
      'ArrayIndexingOrder="RowMajorOrder" Dimensionality="1" Dim0="' + nVert + '" ',
      'Encoding="ASCII" Endian="LittleEndian" ExternalFileName="" ExternalFileOffset="">\\n',
      '<Data>' + ids.join(' ') + '</Data>\\n',
      '</DataArray>\\n</GIFTI>\\n',
    ], withTable ? 'table.label.gii' : 'plain.label.gii')

    nv.addColormap('e2eLabels', {
      R: [0, 0, 0], G: [0, 0, 0], B: [0, 0, 255], A: [0, 0, 255],
      labels: ['bg', 'none', 'blue'],
    })
    const lut = (l) => l.colormapLabel && [l.colormapLabel.min, l.colormapLabel.max]

    // addMeshLayer with a label colormap: label 0 shows the base colour.
    await nv.addMeshLayer(0, { url: gifti(false), colormap: 'e2eLabels', opacity: 1 })
    const added = {
      lut: lut(m.layers[0]),
      label0IsBase: m.colors[0] === base,
      label2: [m.colors[2] & 0xff, (m.colors[2] >> 8) & 0xff, (m.colors[2] >> 16) & 0xff],
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
    await nv.removeMeshLayer(0, 0)

    // An explicit continuous colormap at load replaces the file's table.
    await nv.addMeshLayer(0, { url: gifti(true), colormap: 'warm' })
    const fileOverridden = lut(m.layers[0])

    nv.destroy()
    return { added, continuous, random, fromFile, afterOpacity, fileOverridden }
  })()`)

  expect(result).toEqual({
    added: { lut: [0, 2], label0IsBase: true, label2: [0, 0, 255] },
    continuous: null,
    random: { lut: [0, 255], label0IsBase: true },
    fromFile: [0, 2],
    afterOpacity: [0, 2],
    fileOverridden: null,
  })
})

test('mesh layers loaded with the mesh, and re-registered tables', async ({
  page,
}) => {
  test.setTimeout(120_000)

  const result = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(canvas)
    nv.addColormap('e2eTable', { R: [0, 255], G: [0, 0], B: [0, 0], labels: [] })
    await nv.loadMeshes([{
      url: '${MESH}',
      layers: [{ url: '/meshes/BrainMesh_ICBM152.lh.curv', colormap: 'e2eTable' }],
    }])
    const layer = nv.meshes[0].layers[0]
    const loaded = [layer.colormapLabel.min, layer.colormapLabel.max]
    // Re-registering the table with more IDs rebuilds the layer's LUT.
    nv.addColormap('e2eTable', {
      R: [0, 255, 0], G: [0, 0, 255], B: [0, 0, 0], labels: [],
    })
    const reRegistered = [layer.colormapLabel.min, layer.colormapLabel.max]
    nv.destroy()
    return { loaded, reRegistered }
  })()`)

  expect(result).toEqual({ loaded: [0, 1], reRegistered: [0, 2] })
})
