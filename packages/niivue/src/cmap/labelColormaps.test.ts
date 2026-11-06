import { expect, test } from 'bun:test'
import NiiVue, { type ChunkedVolumeSource } from '@/index'
import { devImageUrl, documentFile, niftiBytes } from '@/testing/headless'

// One colormap per volume (issue #69): a label colormap (one with a `labels`
// array) set through `setVolume({ colormap })` colours each integer ID;
// documents name colormaps and embed runtime ones. What the labels look like
// on screen is pinned by e2e/unified-colormaps.spec.ts.

const [NX, NY, NZ] = [32, 32, 4]

/** NIFTI_INTENT_LABEL: the left half holds ID 3, the right half ID 20000. */
const labelFile = () =>
  new File(
    [
      niftiBytes({
        dims: [NX, NY, NZ],
        datatype: 'int16',
        intentCode: 1002,
        voxel: (i) => (i % NX < NX / 2 ? 3 : 20000),
      }),
    ],
    'labels.nii',
  )

const halves = {
  R: [0, 0, 255],
  G: [0, 255, 0],
  B: [0, 0, 0],
  I: [0, 3, 20000],
  labels: ['air', 'left', 'right'],
}

test("a streamed label volume's generated palette spans its IDs", async () => {
  // The volume is added before a voxel is read (range 0..1); the window
  // derived from the coarse floor has to widen the palette to ID 20000.
  const N = 32
  const source: ChunkedVolumeSource = {
    datatypeCode: 4,
    levels: [{ level: 0, shape: [N, N, 4], spacing: [1, 1, 1] }],
    fetchChunk: async ({ texOrigin: o, texDims: d }) => {
      const out = new Int16Array(d[0] * d[1] * d[2])
      for (let z = 0; z < d[2]; z++)
        for (let y = 0; y < d[1]; y++)
          for (let x = 0; x < d[0]; x++)
            out[x + d[0] * (y + d[1] * z)] = o[0] + x < N / 2 ? 3 : 20000
      return new Uint8Array(out.buffer)
    },
  }
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadChunkedVolume(source, { colormap: 'Random' })
  expect(nv.volumes[0].globalMax).toBe(20000)
  expect(nv.volumes[0].colormapLabel?.max).toBe(20000)
})

test('prepareVolume loads without adding, and addVolume applies its colormap', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const prepared = await nv.prepareVolume({
    url: labelFile(),
    colormap: 'gray',
  })
  const countBefore = nv.volumes.length
  prepared.colormap = nv.addColormap('preparedHalves', halves)
  await nv.addVolume(prepared)
  const lut = nv.volumes[0].colormapLabel
  expect({
    countBefore,
    count: nv.volumes.length,
    labels: [lut?.labels?.[3], lut?.labels?.[20000]],
  }).toEqual({ countBefore: 0, count: 1, labels: ['left', 'right'] })
})

test('drawColormap takes label colormaps with IDs up to 255 only', () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const attempt = (name: string) => {
    try {
      nv.drawColormap = name
      return 'ok'
    } catch {
      return 'threw'
    }
  }
  nv.addColormap('wide', {
    R: [0, 9],
    G: [0, 9],
    B: [0, 9],
    I: [0, 20000],
    labels: [],
  })
  expect({
    itksnap: attempt('itksnap'),
    gray: attempt('gray'),
    wide: attempt('wide'),
    kept: nv.drawColormap,
  }).toEqual({ itksnap: 'ok', gray: 'threw', wide: 'threw', kept: 'itksnap' })
  expect(nv.drawingColormaps).toEqual(
    expect.arrayContaining(['Draw', 'Itksnap', 'Slicer3d', 'Random']),
  )
  expect(nv.drawingColormaps).not.toContain('Wide')
})

test('a document embeds a runtime label colormap and restores it by name', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: labelFile() }])
  const name = nv.addColormap('docAtlas', {
    R: [0, 10, 20],
    G: [0, 30, 40],
    B: [0, 50, 60],
    I: [0, 3, 20000],
    labels: ['air', 'left', 'right'],
  })
  await nv.setVolume(0, { colormap: name })
  const bytes = nv.serializeDocument({ format: 'json' })
  const doc = JSON.parse(new TextDecoder().decode(bytes))
  // The registry is process-wide, so overwrite 'DocAtlas' with a ramp: the
  // restored volume is a label map only if loadDocument registers the
  // document's own definition.
  nv.addColormap('docAtlas', { R: [0, 255], G: [0, 255], B: [0, 255] })
  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(bytes, 'scene.json'))
  const v = nv2.volumes[0]
  expect({
    version: doc.version,
    embedded: Object.keys(doc.colormaps ?? {}),
    savedLut: 'colormapLabel' in doc.volumes[0],
    colormap: v.colormap,
    right: v.colormapLabel?.labels?.[20000],
  }).toEqual({
    version: 11,
    embedded: expect.arrayContaining(['DocAtlas']),
    savedLut: false,
    colormap: 'DocAtlas',
    right: 'right',
  })
})

test('a document keeps the label table a volume shows after another viewer re-registers its name', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: labelFile() }])
  const red = {
    R: [0, 255],
    G: [0, 0],
    B: [0, 0],
    I: [0, 3],
    labels: ['air', 'left'],
  }
  await nv.setVolume(0, { colormap: nv.addColormap('sharedAtlas', red) })
  // A second viewer re-registers the name in green. The registry is
  // process-wide, but only that viewer's volumes recompile.
  const nv2 = new NiiVue({ backend: 'webgl2' })
  nv2.addColormap('sharedAtlas', { ...red, R: [0, 0], G: [0, 255] })
  const doc = JSON.parse(
    new TextDecoder().decode(nv.serializeDocument({ format: 'json' })),
  )
  const saved = doc.volumes[0].colormap
  expect({
    shown: Array.from(nv.volumes[0].colormapLabel?.lut.slice(12, 16) ?? []),
    saved,
    savedRed: doc.colormaps?.[saved]?.R,
    savedGreen: doc.colormaps?.[saved]?.G,
  }).toEqual({
    shown: [255, 0, 0, 255],
    saved: 'SharedAtlas 2',
    savedRed: [0, 0, 0, 255],
    savedGreen: [0, 0, 0, 0],
  })
})

test('a v9 document with a compiled label LUT loads through the converter', async () => {
  const lut = new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255])
  const doc = {
    version: 9,
    draw: { colormap: '_itksnap' },
    volumes: [
      {
        url: devImageUrl('volumes/aal.nii.gz'),
        name: 'aal.nii.gz',
        colormap: 'gray',
        colormapLabel: {
          lut: {
            $ta: 'Uint8Array',
            b64: Buffer.from(lut).toString('base64'),
          },
          min: 0,
          max: 2,
          labels: ['air', 'one', 'two'],
        },
      },
    ],
  }
  const nv = new NiiVue({ backend: 'webgl2' })
  const load = () =>
    nv.loadDocument(documentFile(JSON.stringify(doc), 'old.json'))
  await load()
  const v = nv.volumes[0]
  const first = {
    colormap: v.colormap,
    labels: v.colormapLabel?.labels,
    draw: nv.drawColormap,
  }
  // The same table loaded again reuses its name rather than adding another.
  await load()
  expect({ ...first, reloaded: nv.volumes[0].colormap }).toEqual({
    colormap: 'Aal labels',
    labels: ['air', 'one', 'two'],
    draw: 'Itksnap',
    reloaded: 'Aal labels',
  })
})
