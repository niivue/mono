import { describe, expect, test } from 'bun:test'
import NiiVue, { SLICE_TYPE, VOLUME_RENDER_MODE } from '@/index'
import { defaultSignalDisplay } from '@/signal/processing'
import { devImageUrl, documentFile } from '@/testing/headless'

// NVDocument save/reload through a real controller, with no canvas attached:
//   - linkData: reference volumes by URL instead of embedding their bytes.
//   - sparse settings: omit defaults; fill omitted settings per the fill policy
//     (default resets to defaults, 'current' keeps the instance value).
//   - the events loadDocument emits, and volume ids across a round-trip.

const SPHERE = devImageUrl('volumes/sphere.nii.gz')
const HIPPO = devImageUrl('volumes/hippo.nii.gz')
const STATS = devImageUrl('volumes/spmMotor.nii.gz')
const MESH = devImageUrl('meshes/cortex_5124.mz3')
const SIGNAL = devImageUrl('signals/cardiac.tsv.gz')

const jsonFile = (doc: unknown, name: string) =>
  new File([JSON.stringify(doc)], name, { type: 'application/json' })

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test('linkData: a linked document omits volume bytes and refetches from the URL', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: SPHERE }])
  const voxels = nv.volumes[0].img?.length ?? 0

  const embedded = nv.serializeDocument().byteLength
  const linkedBytes = nv.serializeDocument({ linkData: true })

  // Reload the linked document into a fresh instance: the volume must refetch.
  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(linkedBytes, 'linked.nvd'))

  // The linked document is a tiny reference, not the embedded volume.
  expect(linkedBytes.byteLength).toBeLessThan(embedded / 100)
  // It reloaded by refetching the referenced URL.
  expect(nv2.volumes[0]?.url).toBe(SPHERE)
  expect(voxels).toBeGreaterThan(0)
  expect(nv2.volumes[0]?.img?.length).toBe(voxels)
})

test('sparse settings: fill policy - default resets omitted, current keeps, specified always wins', async () => {
  // Source: azimuth 200 (non-default -> saved); crosshair at default -> omitted.
  const bytes = new NiiVue({ azimuth: 200 }).serializeDocument()

  // (a) DEFAULT fill: the omitted crosshair RESETS to default; azimuth adopted.
  const tDefault = new NiiVue({ azimuth: 50 })
  tDefault.crosshairPos = [0.7, 0.8, 0.9]
  await tDefault.loadDocument(documentFile(bytes, 'a.nvd'))

  // (b) fill 'current' for the crosshair: omitted crosshair KEPT; azimuth adopted.
  const tKeep = new NiiVue({ azimuth: 50 })
  tKeep.crosshairPos = [0.7, 0.8, 0.9]
  await tKeep.loadDocument(documentFile(bytes, 'b.nvd'), {
    fill: { 'scene.crosshairPos': 'current' },
  })

  // (c) a document that SPECIFIES the crosshair overrides, even under fill:current.
  const full = new NiiVue({})
  full.crosshairPos = [0.1, 0.2, 0.3]
  const fullBytes = full.serializeDocument()
  const tOverride = new NiiVue({})
  tOverride.crosshairPos = [0.9, 0.9, 0.9]
  await tOverride.loadDocument(documentFile(fullBytes, 'c.nvd'), {
    fill: 'current',
  })

  expect(tDefault.azimuth).toBe(200) // specified -> wins
  expect([...tDefault.crosshairPos]).toEqual([0.5, 0.5, 0.5]) // omitted -> reset
  expect(tKeep.azimuth).toBe(200)
  // omitted + fill:current -> kept
  expect([...tKeep.crosshairPos]).toEqual([0.7, 0.8, 0.9])
  // specified -> wins under fill:current
  expect([...tOverride.crosshairPos]).toEqual([0.1, 0.2, 0.3])
})

test('optional containers: a document may omit scene, layout, clipPlanes, volumes and meshes', async () => {
  // (a) The minimal document: version only. Under the default fill policy
  // every omitted setting resets; azimuth started non-default to prove it.
  const tReset = new NiiVue({ azimuth: 200 })
  tReset.setClipPlane([0.25, 30, 15])
  const clipBefore = JSON.stringify([...tReset.model.clipPlanes])
  await tReset.loadDocument(jsonFile({ version: 9 }, 'minimal.json'))

  // (b) Same document, fill 'current': every omitted setting is kept.
  const tKeep = new NiiVue({ azimuth: 200 })
  await tKeep.loadDocument(jsonFile({ version: 9 }, 'minimal.json'), {
    fill: 'current',
  })

  // (c) volumes without any other container still loads the volume.
  const tVol = new NiiVue({ backend: 'webgl2' })
  await tVol.loadDocument(
    jsonFile({ version: 9, volumes: [{ url: SPHERE }] }, 'volume-only.json'),
  )

  expect(tReset.azimuth).toBe(110) // SCENE_DEFAULTS.azimuth: omitted scene -> reset
  // omitted clipPlanes -> untouched
  expect(JSON.stringify([...tReset.model.clipPlanes])).toBe(clipBefore)
  expect(tReset.volumes.length).toBe(0)
  expect(tReset.meshes.length).toBe(0)
  expect(tKeep.azimuth).toBe(200) // omitted scene + fill:current -> kept
  // volumes-only document loads
  expect(tVol.volumes[0]?.url).toBe(SPHERE)
  expect(tVol.volumes[0]?.img?.length ?? 0).toBeGreaterThan(0)
})

test('mesh visible: a hidden mesh stays hidden across a document round-trip', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadMeshes([{ url: MESH }])
  await nv.setMesh(0, { visible: false, opacity: 0.7 })

  // Embedded (default) and linked JSON both carry the flag.
  const embedded = nv.serializeDocument()
  const linked = nv.serializeDocument({ format: 'json', linkData: true })

  const nvA = new NiiVue({ backend: 'webgl2' })
  await nvA.loadDocument(documentFile(embedded, 'hidden.nvd'))
  const nvB = new NiiVue({ backend: 'webgl2' })
  await nvB.loadDocument(documentFile(linked, 'hidden.json'))

  // A shown mesh must not gain a `visible` key (documents stay unchanged).
  await nv.setMesh(0, { visible: true })
  const shownText = decode(
    nv.serializeDocument({ format: 'json', linkData: true }),
  )

  expect(decode(linked)).toContain('"visible":false')
  expect(nvA.meshes[0]?.visible).toBe(false) // hidden survives the embedded path
  expect(nvA.meshes[0]?.opacity).toBeCloseTo(0.7) // and opacity is untouched
  expect(nvB.meshes[0]?.visible).toBe(false) // hidden survives the URL path
  expect(nvB.meshes[0]?.opacity).toBeCloseTo(0.7)
  expect(shownText).not.toContain('"visible"') // shown -> no key written
})

test('volume visible: a hidden volume stays hidden, with its opacity, across a document round-trip', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: SPHERE }])
  await nv.setVolume(0, { opacity: 0.5 })
  await nv.setVolume(0, { visible: false })
  const hiddenOpacity = nv.volumes[0].opacity

  const embedded = nv.serializeDocument()
  const linked = nv.serializeDocument({ format: 'json', linkData: true })

  const nvA = new NiiVue({ backend: 'webgl2' })
  await nvA.loadDocument(documentFile(embedded, 'hidden.nvd'))
  const nvB = new NiiVue({ backend: 'webgl2' })
  await nvB.loadDocument(documentFile(linked, 'hidden.json'))

  // Showing it again restores the stored opacity and writes no key.
  await nv.setVolume(0, { visible: true })
  const shownText = decode(
    nv.serializeDocument({ format: 'json', linkData: true }),
  )

  expect(hiddenOpacity).toBeCloseTo(0.5) // hiding leaves opacity alone
  expect(decode(linked)).toContain('"visible":false')
  expect(nvA.volumes[0]?.visible).toBe(false) // hidden survives the embedded path
  expect(nvA.volumes[0]?.opacity).toBeCloseTo(0.5)
  expect(nvB.volumes[0]?.visible).toBe(false) // hidden survives the URL path
  expect(nvB.volumes[0]?.opacity).toBeCloseTo(0.5)
  expect(nv.volumes[0].opacity).toBeCloseTo(0.5) // show -> the 0.5 is back
  expect(shownText).not.toContain('"visible"') // shown -> no key written
})

test('load events: loadDocument emits change (and sliceTypeChange) for the settings it applies', async () => {
  type Seen = { type: string; property?: string; value?: unknown }
  const record = (nv: NiiVue) => {
    const seen: Seen[] = []
    nv.addEventListener('change', (e) =>
      seen.push({
        type: 'change',
        property: e.detail.property,
        value: e.detail.value,
      }),
    )
    nv.addEventListener('sliceTypeChange', (e) =>
      seen.push({ type: 'sliceTypeChange', value: e.detail.sliceType }),
    )
    nv.addEventListener('azimuthElevationChange', () =>
      seen.push({ type: 'azimuthElevationChange' }),
    )
    nv.addEventListener('documentLoaded', () =>
      seen.push({ type: 'documentLoaded' }),
    )
    return seen
  }
  // Every fixture carries the containers, empty.
  const asFile = (doc: Record<string, unknown>, name: string) =>
    jsonFile(
      {
        scene: {},
        layout: {},
        clipPlanes: [],
        volumes: [],
        meshes: [],
        ...doc,
      },
      name,
    )

  // (a) fill:'current': only the keys the document sets change.
  const nv = new NiiVue({ sliceType: SLICE_TYPE.MULTIPLANAR })
  const seen = record(nv)
  await nv.loadDocument(
    asFile(
      {
        version: 9,
        layout: { sliceType: SLICE_TYPE.AXIAL },
        volume: { matcap: 'https://example.org/shiny.jpg' },
      },
      'a.json',
    ),
    { fill: 'current' },
  )

  // (b) a document that sets nothing, under fill:'current', emits no change.
  const quiet = new NiiVue({ sliceType: SLICE_TYPE.MULTIPLANAR })
  const seenQuiet = record(quiet)
  await quiet.loadDocument(asFile({ version: 9 }, 'b.json'), {
    fill: 'current',
  })

  // (c) default fill: a non-default azimuth the document omits is reset, and
  // that reset is reported like any change.
  const reset = new NiiVue({ azimuth: 200 })
  const seenReset = record(reset)
  await reset.loadDocument(asFile({ version: 9 }, 'c.json'))
  const resetEvents = seenReset.filter(
    (e) => e.type !== 'change' || e.property === 'azimuth',
  )

  expect(seen.filter((e) => e.type === 'change')).toEqual([
    { type: 'change', property: 'sliceType', value: 0 },
    {
      type: 'change',
      property: 'volumeMatcap',
      value: 'https://example.org/shiny.jpg',
    },
  ])
  expect(nv.sliceType).toBe(0)
  // sliceType changed -> the paired specialised event fires too, then documentLoaded last.
  expect(seen.map((e) => e.type)).toEqual([
    'change',
    'change',
    'sliceTypeChange',
    'documentLoaded',
  ])
  expect(seenQuiet.map((e) => e.type)).toEqual(['documentLoaded']) // nothing applied
  expect(reset.azimuth).toBe(110) // omitted + default fill -> reset to SCENE_DEFAULTS
  expect(resetEvents.map((e) => e.type)).toEqual([
    'change',
    'azimuthElevationChange',
    'documentLoaded',
  ])
  expect(resetEvents[0]).toEqual({
    type: 'change',
    property: 'azimuth',
    value: 110,
  })
})

test('load events: loadDocument emits volumeLoaded, meshLoaded, signalLoaded, signalRemoved and drawingChanged for the layers it replaces', async () => {
  // Source scene: one linked volume, one embedded mesh, one signal, a drawing.
  const src = new NiiVue({ backend: 'webgl2' })
  await src.loadVolumes([{ url: SPHERE }])
  await src.loadMeshes([{ url: MESH }])
  await src.loadSignals([{ url: SIGNAL }])
  src.createEmptyDrawing()
  const bytes = src.serializeDocument({ linkData: true })

  // Destination already holds a volume and a signal the load must replace.
  const dst = new NiiVue({ backend: 'webgl2' })
  await dst.loadVolumes([{ url: HIPPO }])
  await dst.loadSignals([{ url: SIGNAL }])

  const seen: string[] = []
  const inCollectionAtEmit: Record<string, boolean> = {}
  dst.addEventListener('volumeRemoved', (e) => {
    seen.push('volumeRemoved')
    inCollectionAtEmit.removedVolume = dst.volumes.includes(e.detail.volume)
  })
  dst.addEventListener('meshRemoved', () => seen.push('meshRemoved'))
  dst.addEventListener('signalRemoved', (e) => {
    seen.push('signalRemoved')
    inCollectionAtEmit.removedSignal = dst.model.signals.includes(
      e.detail.signal,
    )
  })
  dst.addEventListener('volumeLoaded', (e) => {
    seen.push('volumeLoaded')
    inCollectionAtEmit.volume = dst.volumes.includes(e.detail.volume)
  })
  dst.addEventListener('meshLoaded', (e) => {
    seen.push('meshLoaded')
    inCollectionAtEmit.mesh = dst.meshes.includes(e.detail.mesh)
  })
  dst.addEventListener('signalLoaded', (e) => {
    seen.push('signalLoaded')
    inCollectionAtEmit.signal = dst.model.signals.includes(e.detail.signal)
  })
  dst.addEventListener('drawingChanged', (e) =>
    seen.push(`drawingChanged:${e.detail.action}`),
  )
  dst.addEventListener('change', () => seen.push('change'))
  dst.addEventListener('documentLoaded', () => seen.push('documentLoaded'))

  await dst.loadDocument(documentFile(bytes, 'scene.nvd'))

  const count = (t: string) => seen.filter((e) => e === t).length
  expect(count('volumeRemoved')).toBe(1) // the destination's hippo
  expect(count('signalRemoved')).toBe(1) // the destination's signal
  expect(count('volumeLoaded')).toBe(1)
  expect(count('meshLoaded')).toBe(1)
  expect(count('signalLoaded')).toBe(1)
  expect(count('drawingChanged:load')).toBe(1)
  expect(seen[seen.length - 1]).toBe('documentLoaded') // last: "all in place"
  // Removals precede the settings changes, which precede the loads.
  const idx = (t: string) => seen.indexOf(t)
  expect(idx('volumeRemoved')).toBeLessThan(idx('signalRemoved'))
  expect(idx('signalRemoved')).toBeLessThan(idx('volumeLoaded'))
  expect(idx('volumeLoaded')).toBeLessThan(idx('meshLoaded'))
  expect(idx('meshLoaded')).toBeLessThan(idx('signalLoaded'))
  expect(idx('signalLoaded')).toBeLessThan(idx('drawingChanged:load'))
  // A *Loaded listener can reach the item through the collection at emit time;
  // a *Removed listener finds it already gone (it is in the detail instead).
  expect(inCollectionAtEmit).toEqual({
    removedVolume: false,
    removedSignal: false,
    volume: true,
    mesh: true,
    signal: true,
  })
  expect([
    dst.volumes.length,
    dst.meshes.length,
    dst.model.signals.length,
    !!dst.drawingVolume,
  ]).toEqual([1, 1, 1, true])
})

test('removal events fire after the removal, with the item and its former index in the detail', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: SPHERE }, { url: HIPPO }])
  await nv.loadMeshes([{ url: MESH }])

  const log: {
    type: string
    index: number
    gone: boolean
    lengthAtEmit: number
  }[] = []
  nv.addEventListener('volumeRemoved', (e) =>
    log.push({
      type: 'volumeRemoved',
      index: e.detail.index,
      gone: !nv.volumes.includes(e.detail.volume),
      lengthAtEmit: nv.volumes.length,
    }),
  )
  nv.addEventListener('meshRemoved', (e) =>
    log.push({
      type: 'meshRemoved',
      index: e.detail.index,
      gone: !nv.meshes.includes(e.detail.mesh),
      lengthAtEmit: nv.meshes.length,
    }),
  )

  await nv.removeMesh(0)
  await nv.removeVolume(1) // the overlay
  await nv.removeAllVolumes() // the remaining background

  expect(log).toEqual([
    { type: 'meshRemoved', index: 0, gone: true, lengthAtEmit: 0 },
    { type: 'volumeRemoved', index: 1, gone: true, lengthAtEmit: 1 },
    { type: 'volumeRemoved', index: 0, gone: true, lengthAtEmit: 0 },
  ])
  expect([nv.volumes.length, nv.meshes.length]).toEqual([0, 0])
})

test('json format: saves portable JSON that loadDocument reads back (linked + embedded)', async () => {
  const nv = new NiiVue({ backend: 'webgl2', azimuth: 175 })
  await nv.loadVolumes([{ url: SPHERE }])
  const voxels = nv.volumes[0].img?.length ?? 0

  // JSON + linked: small, human-readable text.
  const jsonLinked = nv.serializeDocument({ format: 'json', linkData: true })
  const text = decode(jsonLinked)

  // loadDocument sniffs JSON vs CBOR: a .json linked doc rehydrates by URL.
  const nvLinked = new NiiVue({ backend: 'webgl2' })
  await nvLinked.loadDocument(documentFile(jsonLinked, 'scene.json'))

  // Embedded JSON round-trips the voxels through base64.
  const jsonEmbedded = nv.serializeDocument({ format: 'json' })
  const nvEmbedded = new NiiVue({ backend: 'webgl2' })
  await nvEmbedded.loadDocument(documentFile(jsonEmbedded, 'embed.json'))

  expect(text.trimStart().startsWith('{')).toBe(true) // JSON, not binary
  expect(() => JSON.parse(text)).not.toThrow()
  // Non-finite numbers: calMinNeg defaults to NaN on a loaded volume. JSON has
  // no NaN, so the codec tags it; a reload must yield NaN again, not null.
  expect(text).toContain('"$num":"NaN"') // NaN survives as a { $num } tag ...
  expect(text).not.toContain('"calMinNeg":null') // ... not as JSON's null
  expect(nvLinked.azimuth).toBe(175) // scene restored from JSON
  expect(nvLinked.volumes[0]?.url).toBe(SPHERE)
  expect(voxels).toBeGreaterThan(0)
  expect(nvLinked.volumes[0]?.img?.length).toBe(voxels) // linked -> refetched
  expect(nvLinked.volumes[0]?.calMinNeg).toBeNaN() // NaN on the URL path
  // embedded JSON -> base64 voxels
  expect(nvEmbedded.volumes[0]?.img?.length).toBe(voxels)
  expect(nvEmbedded.volumes[0]?.calMinNeg).toBeNaN() // and on the embedded path
})

test('matcap: constructor preserves explicit options and defaults when omitted', () => {
  const matcaps = { cortex: '/m/Cortex.jpg', gold: '/m/Gold.jpg' }
  const result = [
    undefined,
    'https://example.org/custom.jpg',
    'https://example.org/assets/matcaps/Cortex.jpg',
    '',
    'gold',
  ].map((volumeMatcap) => new NiiVue({ matcaps, volumeMatcap }).volumeMatcap)
  expect(result).toEqual([
    '/m/Cortex.jpg',
    'https://example.org/custom.jpg',
    'https://example.org/assets/matcaps/Cortex.jpg',
    '',
    '/m/Gold.jpg',
  ])
})

test('matcap: saved by name, loads back as its URL, custom URLs are kept', async () => {
  const src = new NiiVue()
  const url = src.volumeMatcap
  const json = decode(src.serializeDocument({ format: 'json' }))
  const saved = JSON.parse(json).volume?.matcap

  const reloaded = new NiiVue()
  reloaded.volumeMatcap = ''
  await reloaded.loadDocument(documentFile(json, 'named.json'))

  // A document saved before names stored the dev server's path, which only
  // resolves on that server. It loads by file name.
  const legacy = json.replace(
    '"matcap":"cortex"',
    '"matcap":"/src/assets/matcaps/Cortex.jpg"',
  )
  const fromLegacy = new NiiVue()
  await fromLegacy.loadDocument(documentFile(legacy, 'legacy.json'))

  // An app's own image is kept, even when its file shares a built-in's
  // name; the renderer draws the default if it does not load.
  const custom = json.replace(
    '"matcap":"cortex"',
    '"matcap":"/custom/Cortex.jpg"',
  )
  const fromCustom = new NiiVue()
  await fromCustom.loadDocument(documentFile(custom, 'custom.json'))

  // A name this instance does not know cannot be fetched, so it loads as the
  // instance default.
  const unknown = json.replace('"matcap":"cortex"', '"matcap":"gold"')
  const fromUnknown = new NiiVue()
  fromUnknown.volumeMatcap = ''
  await fromUnknown.loadDocument(documentFile(unknown, 'unknown.json'))

  expect(url).not.toBe('')
  expect(saved).toBe('cortex')
  expect(reloaded.volumeMatcap).toBe(url)
  expect(legacy).not.toBe(json)
  expect(fromLegacy.volumeMatcap).toBe(url)
  expect(custom).not.toBe(json)
  expect(fromCustom.volumeMatcap).toBe('/custom/Cortex.jpg')
  expect(unknown).not.toBe(json)
  expect(fromUnknown.volumeMatcap).toBe(url)
})

for (const fill of ['current', { 'volume.matcap': 'current' }] as const) {
  test(`matcap: omitted value respects fill ${JSON.stringify(fill)}`, async () => {
    const nv = new NiiVue({
      matcaps: { cortex: '/m/Cortex.jpg', gold: '/m/custom-gold.jpg' },
    })
    nv.volumeMatcap = '/m/custom-gold.jpg'
    const changes: string[] = []
    nv.addEventListener('change', (event) => {
      changes.push(event.detail.property)
    })
    await nv.loadDocument(documentFile('{"version":9}', 'empty.json'), {
      fill,
    })
    expect(nv.volumeMatcap).toBe('/m/custom-gold.jpg')
    expect(changes).not.toContain('volumeMatcap')
  })
}

test('duplicate URLs: distinct volume ids drive modulation and survive a round-trip', async () => {
  const url = SPHERE
  // AFNI's QC viewer: one stats file as the overlay and again, hidden, as the
  // threshold that modulates it.
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url }, { url }])
  await nv.addVolume({ url, opacity: 0 })
  const ids = nv.volumes.map((v) => v.id)
  const names = nv.volumes.map((v) => v.name)
  await nv.setModulationImage(nv.volumes[1].id ?? '', nv.volumes[2].id ?? '')
  const links = nv.volumes.map((v) => v.modulationImage ?? null)

  const bytes = nv.serializeDocument({ linkData: true })
  const nv2 = new NiiVue({ backend: 'webgl2' })
  await nv2.loadDocument(documentFile(bytes, 'dup.nvd'))

  expect(ids).toEqual([url, `${url}-2`, `${url}-3`])
  expect(names).toEqual([url, url, url])
  expect(links).toEqual([null, `${url}-3`, null])
  expect(nv2.volumes.map((v) => v.id)).toEqual(ids)
  expect(nv2.volumes.map((v) => v.modulationImage ?? null)).toEqual(links)
})

describe('volume ids are unique within an instance', () => {
  const ANAT = SPHERE

  test('the same URL loaded twice gets distinct ids, and modulation uses the threshold copy', async () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    // AFNI's QC pair: one stats file as the overlay and again, hidden, as
    // its threshold.
    await nv.loadVolumes([{ url: ANAT }, { url: STATS }])
    await nv.addVolume({ url: STATS, opacity: 0 })
    const ids = nv.volumes.map((v) => v.id)
    const names = nv.volumes.map((v) => v.name)
    await nv.setModulationImage(nv.volumes[1].id ?? '', nv.volumes[2].id ?? '')
    const sum = () =>
      Array.from(nv.volumes[1]._modulationWeight ?? []).reduce(
        (a, b) => a + b,
        0,
      )
    const before = sum()
    // Re-window ONLY the threshold copy: the overlay's weights follow it
    // (an overlay modulating itself would not change).
    const calMax = nv.volumes[2].calMax ?? 1
    await nv.setVolume(2, { calMax: calMax * 4 })
    const after = sum()

    expect(ids).toEqual([ANAT, STATS, `${STATS}-2`])
    expect(names).toEqual([ANAT, STATS, STATS])
    expect(before).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
    expect(nv.volumes[2]._modulationWeight ?? null).toBeNull()
  })

  test('a taken id is suffixed, a freed id is reused, and links keep their target', async () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    const ids = () => nv.volumes.map((v) => v.id)
    await nv.loadVolumes([{ url: ANAT }, { url: STATS }])
    await nv.addVolume({ url: STATS })
    // An NVImage passed in with an id already in use: the scene's copy is
    // suffixed, the caller's object is left alone.
    const copy = { ...nv.volumes[1], id: STATS }
    await nv.addVolume(copy)
    const withCopy = ids()
    await nv.removeVolume(3)
    // Remove and re-add: the lowest free suffix is reused.
    await nv.removeVolume(2)
    await nv.addVolume({ url: STATS })
    const reused = ids()
    // Remove the first copy: the survivor keeps "-2" (and a link to it),
    // the re-added copy takes the freed plain id.
    const survivor = nv.volumes[2]
    await nv.setModulationImage(ANAT, `${STATS}-2`)
    await nv.removeVolume(1)
    await nv.addVolume({ url: STATS })
    const swapped = ids()
    const linkTarget = nv.volumes.find(
      (v) => v.id === nv.volumes[0].modulationImage,
    )
    await nv.removeAllVolumes()
    await nv.addVolume({ url: STATS })

    expect(withCopy).toEqual([ANAT, STATS, `${STATS}-2`, `${STATS}-3`])
    expect(copy.id).toBe(STATS)
    expect(reused).toEqual([ANAT, STATS, `${STATS}-2`])
    expect(swapped).toEqual([ANAT, `${STATS}-2`, STATS])
    expect(linkTarget).toBe(survivor)
    expect(ids()).toEqual([STATS])
  })

  test('a round-trip restores ids out of load order, with modulation and signal links', async () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    // Build [stats-2, stats]: re-deriving ids from load order would swap
    // them and point both links at the wrong copy.
    await nv.loadVolumes([{ url: STATS }, { url: STATS }])
    await nv.removeVolume(0)
    await nv.addVolume({ url: STATS })
    const ids0 = nv.volumes.map((v) => v.id)
    await nv.setModulationImage(STATS, `${STATS}-2`)
    await nv.addSignal({
      id: 'physio',
      name: 'physio',
      kind: 'physio',
      raw: {
        kind: 'physio',
        columns: [new Float32Array([0, 1])],
        columnLabels: ['cardiac'],
        samplingFrequency: 1,
        startTime: 0,
      },
      display: defaultSignalDisplay(),
      attachedToId: `${STATS}-2`,
    })
    const json = decode(
      nv.serializeDocument({ linkData: true, format: 'json' }),
    )

    const nv2 = new NiiVue({ backend: 'webgl2' })
    await nv2.loadDocument(documentFile(json, 'ids.json'))
    const attached = nv2.volumes.find(
      (v) => v.id === nv2.signals[0]?.attachedToId,
    )

    // An older document without saved ids re-derives them in volume order.
    const legacy = JSON.parse(json)
    for (const v of legacy.volumes ?? []) delete v.id
    // An entry with nothing to load must not rename the volume before it.
    legacy.volumes.push({ name: 'ghost', id: 'ghost' })
    const nv3 = new NiiVue({ backend: 'webgl2' })
    await nv3.loadDocument(documentFile(JSON.stringify(legacy), 'old.json'))

    expect(ids0).toEqual([`${STATS}-2`, STATS])
    expect(nv2.volumes.map((v) => v.id)).toEqual(ids0)
    expect(nv2.volumes.map((v) => v.modulationImage ?? null)).toEqual([
      null,
      `${STATS}-2`,
    ])
    expect(attached ? nv2.volumes.indexOf(attached) : -1).toBe(0)
    expect(nv3.volumes.map((v) => v.id)).toEqual([STATS, `${STATS}-2`])
  })
})

test('volumeCinematic merges and survives a document round trip', async () => {
  const nv = new NiiVue({
    backend: 'webgl2',
    volumeCinematic: { exposure: 1.5 },
  })
  const fromOptions = nv.volumeCinematic.exposure
  nv.volumeCinematic = { shadow: 0.25, labelMode: 'none' }
  nv.volumeRenderMode = VOLUME_RENDER_MODE.CINEMATIC
  const doc = nv.serializeDocument()
  nv.volumeRenderMode = VOLUME_RENDER_MODE.COMPOSITE
  nv.volumeCinematic = { exposure: 1, shadow: 1, labelMode: 'only' }
  await nv.loadDocument(documentFile(doc, 'c.nvd'))
  const loaded = { mode: nv.volumeRenderMode, ...nv.volumeCinematic }
  // A document holding only some keys gets the rest from the defaults.
  nv.model.volume.cinematic = { ao: 0.1 } as typeof nv.volumeCinematic
  const partial = nv.serializeDocument()
  await nv.loadDocument(documentFile(partial, 'p.nvd'))

  expect(fromOptions).toBe(1.5)
  expect(loaded).toMatchObject({
    mode: VOLUME_RENDER_MODE.CINEMATIC,
    exposure: 1.5,
    shadow: 0.25,
    labelMode: 'none',
    maxFrames: 256,
  })
  expect(nv.volumeCinematic).toMatchObject({
    ao: 0.1,
    maxFrames: 256,
    exposure: 1,
  })
})
