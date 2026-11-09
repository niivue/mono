import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { documentFile } from '@/testing/headless'

// loadDocument writes settings straight into the model, past the setters, so it
// must apply their clamps itself (#387).

test('a document cannot set an out-of-range sampleRate or renderMode', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const out: [number, number][] = []
  for (const bad of [0, Number.NaN, 1e9]) {
    // Bypass the setters to write a document holding the bad values.
    nv.model.volume.sampleRate = bad
    nv.model.volume.renderMode = bad
    const doc = nv.serializeDocument()
    await nv.loadDocument(documentFile(doc, 'bad.nvd'))
    out.push([nv.volumeSampleRate, nv.volumeRenderMode])
  }
  expect(out).toEqual([
    [1, 0],
    [2, 0],
    [4, 0],
  ])
})

test('a document cannot set the other clamped settings out of range', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const out: number[][] = []
  for (const bad of [Number.NaN, -3, 1e9]) {
    // Bypass the setters to write a document holding the bad values.
    const m = nv.model
    m.scene.gamma = bad
    m.volume.lodBrightnessCompensation = bad
    m.volume.lodOpacityCompensation = bad
    m.volume.gradientOpacity = bad
    m.volume.silhouette = bad
    m.mesh.xRay = bad
    const doc = nv.serializeDocument()
    await nv.loadDocument(documentFile(doc, 'bad.nvd'))
    out.push([
      nv.gamma,
      nv.volumeLodBrightnessCompensation,
      nv.volumeLodOpacityCompensation,
      nv.volumeGradientOpacity,
      nv.volumeSilhouette,
      nv.meshXRay,
    ])
  }
  // NaN gives each setter's default; -3 and 1e9 clamp to the range ends.
  expect(out).toEqual([
    [1, 0.08, 0, 0, 0, 0],
    [0.1, 0, 0, 0, 0, 0],
    [10, 1, 1, 1, 1, 1],
  ])
})

// The constructor and loadDocument bypass the meshCrosscutWidth setter, so
// they must apply its clamp themselves.
test('meshCrosscutWidth is clamped by the constructor and a document', async () => {
  const out: number[][] = []
  for (const bad of [Number.NaN, -3, 2.5]) {
    const nv = new NiiVue({ backend: 'webgl2', meshCrosscutWidth: bad })
    const fromCtor = nv.meshCrosscutWidth
    // Bypass the setter to write a document holding the bad value.
    nv.model.mesh.crosscutWidth = bad
    const doc = nv.serializeDocument()
    await nv.loadDocument(documentFile(doc, 'bad.nvd'))
    out.push([fromCtor, nv.meshCrosscutWidth])
  }
  expect(out).toEqual([
    [4, 4],
    [0, 0],
    [2.5, 2.5],
  ])
})

test('a bad layoutInset is stored as zero sides (#494)', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.layoutInset = null as never
  const fromNull = nv.layoutInset
  nv.layoutInset = [Number.NaN, -5, 10, 0]
  const fromBad = nv.layoutInset
  // A document bypasses the setter, so it must be normalized on load.
  nv.model.layout.inset = null as never
  const doc = nv.serializeDocument()
  nv.layoutInset = [1, 1, 1, 1]
  await nv.loadDocument(documentFile(doc, 'inset.nvd'))
  expect(fromNull).toEqual([0, 0, 0, 0])
  expect(fromBad).toEqual([0, 0, 10, 0])
  expect(nv.layoutInset).toEqual([0, 0, 0, 0])
})

test('a document cannot set an invalid rotation2D', async () => {
  const out: number[] = []
  for (const bad of [-90, 45, Number.NaN]) {
    const nv = new NiiVue()
    // Bypass the setter to write a document holding the bad value.
    nv.model.layout.rotation2D = bad as 0
    await nv.loadDocument(documentFile(nv.serializeDocument(), 'bad.nvd'))
    out.push(nv.rotation2D)
  }
  expect(out).toEqual([270, 90, 0])
})
