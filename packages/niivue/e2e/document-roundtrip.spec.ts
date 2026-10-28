import { expect, test } from '@playwright/test'

// End-to-end coverage for the two NVDocument save/reload behaviors that can only
// be exercised in a real browser (NiiVue's Vite module graph + a GPU context):
//   - linkData: reference volumes by URL instead of embedding their bytes.
//   - sparse settings: omit defaults; fill omitted settings per the fill policy
//     (default resets to defaults, 'current' keeps the instance value).
// The page just provides the dev-server origin so `import('/src/index.ts')` and
// `/volumes/...` resolve; the work happens inside page.evaluate.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('linkData: a linked document omits volume bytes and refetches from the URL', async ({
  page,
}) => {
  test.setTimeout(90_000) // fetch + embed of a full volume

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const mkCanvas = () => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      c.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(c)
      return c
    }

    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(mkCanvas())
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])

    const embedded = nv.serializeDocument().byteLength
    const linkedBytes = nv.serializeDocument({ linkData: true })

    // Reload the linked document into a fresh instance: the volume must refetch.
    const nv2 = new NiiVue({ backend: 'webgl2' })
    await nv2.attachToCanvas(mkCanvas())
    await nv2.loadDocument(new File([linkedBytes], 'linked.nvd'))

    return {
      embedded,
      linked: linkedBytes.byteLength,
      reloadedUrl: nv2.volumes[0]?.url,
      reloadedVoxels: nv2.volumes[0]?.img?.length ?? 0,
    }
  })

  // The linked document is a tiny reference, not the ~11 MB embedded volume.
  expect(r.linked).toBeLessThan(r.embedded / 100)
  // It reloaded by refetching the referenced URL.
  expect(r.reloadedUrl).toBe('/volumes/mni152.nii.gz')
  expect(r.reloadedVoxels).toBeGreaterThan(1_000_000)
})

test('sparse settings: fill policy — default resets omitted, current keeps, specified always wins', async ({
  page,
}) => {
  test.setTimeout(60_000) // shares the one-time Vite module-graph transform

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')

    // Source: azimuth 200 (non-default -> saved); crosshair at default -> omitted.
    const src = new NiiVue({ azimuth: 200 })
    const bytes = src.serializeDocument()

    // (a) DEFAULT fill: the omitted crosshair RESETS to default; azimuth adopted.
    const tDefault = new NiiVue({ azimuth: 50 })
    tDefault.crosshairPos = [0.7, 0.8, 0.9]
    await tDefault.loadDocument(new File([bytes], 'a.nvd'))

    // (b) fill 'current' for the crosshair: omitted crosshair KEPT; azimuth adopted.
    const tKeep = new NiiVue({ azimuth: 50 })
    tKeep.crosshairPos = [0.7, 0.8, 0.9]
    await tKeep.loadDocument(new File([bytes], 'b.nvd'), {
      fill: { 'scene.crosshairPos': 'current' },
    })

    // (c) a document that SPECIFIES the crosshair overrides — even under fill:current.
    const full = new NiiVue({})
    full.crosshairPos = [0.1, 0.2, 0.3]
    const fullBytes = full.serializeDocument()
    const tOverride = new NiiVue({})
    tOverride.crosshairPos = [0.9, 0.9, 0.9]
    await tOverride.loadDocument(new File([fullBytes], 'c.nvd'), {
      fill: 'current',
    })

    return {
      defaultAzimuth: tDefault.azimuth,
      defaultCrosshair: [...tDefault.crosshairPos],
      keptAzimuth: tKeep.azimuth,
      keptCrosshair: [...tKeep.crosshairPos],
      overriddenCrosshair: [...tOverride.crosshairPos],
    }
  })

  expect(r.defaultAzimuth).toBe(200) // specified -> wins
  expect(r.defaultCrosshair).toEqual([0.5, 0.5, 0.5]) // omitted -> reset to default
  expect(r.keptAzimuth).toBe(200)
  expect(r.keptCrosshair).toEqual([0.7, 0.8, 0.9]) // omitted + fill:current -> kept
  expect(r.overriddenCrosshair).toEqual([0.1, 0.2, 0.3]) // specified -> wins under fill:current
})

test('optional containers: a document may omit scene, layout, clipPlanes, volumes and meshes', async ({
  page,
}) => {
  test.setTimeout(90_000) // fetches one volume for the URL-only document

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const mkCanvas = () => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      c.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(c)
      return c
    }
    const asFile = (doc: unknown, name: string) =>
      new File([JSON.stringify(doc)], name, { type: 'application/json' })

    // (a) The minimal document: version only. Under the default fill policy
    // every omitted setting resets; azimuth started non-default to prove it.
    const tReset = new NiiVue({ azimuth: 200 })
    tReset.setClipPlane([0.25, 30, 15])
    const clipBefore = [...tReset.model.clipPlanes]
    await tReset.loadDocument(asFile({ version: 9 }, 'minimal.json'))

    // (b) Same document, fill 'current': every omitted setting is kept.
    const tKeep = new NiiVue({ azimuth: 200 })
    await tKeep.loadDocument(asFile({ version: 9 }, 'minimal.json'), {
      fill: 'current',
    })

    // (c) volumes without any other container still loads the volume.
    const tVol = new NiiVue({ backend: 'webgl2' })
    await tVol.attachToCanvas(mkCanvas())
    await tVol.loadDocument(
      asFile(
        { version: 9, volumes: [{ url: '/volumes/mni152.nii.gz' }] },
        'volume-only.json',
      ),
    )

    return {
      resetAzimuth: tReset.azimuth,
      clipUnchanged:
        JSON.stringify([...tReset.model.clipPlanes]) ===
        JSON.stringify(clipBefore),
      resetVolumes: tReset.volumes.length,
      resetMeshes: tReset.meshes.length,
      keptAzimuth: tKeep.azimuth,
      volVoxels: tVol.volumes[0]?.img?.length ?? 0,
    }
  })

  expect(r.resetAzimuth).toBe(110) // SCENE_DEFAULTS.azimuth: omitted scene -> reset
  expect(r.clipUnchanged).toBe(true) // omitted clipPlanes -> untouched
  expect(r.resetVolumes).toBe(0)
  expect(r.resetMeshes).toBe(0)
  expect(r.keptAzimuth).toBe(200) // omitted scene + fill:current -> kept
  expect(r.volVoxels).toBeGreaterThan(1_000_000) // volumes-only document loads
})

test('mesh visible: a hidden mesh stays hidden across a document round-trip', async ({
  page,
}) => {
  test.setTimeout(90_000) // fetches one mesh, then reloads it twice

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const mkCanvas = () => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      c.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(c)
      return c
    }
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(mkCanvas())
    await nv.loadMeshes([{ url: '/meshes/BrainMesh_ICBM152.lh.mz3' }])
    await nv.setMesh(0, { visible: false, opacity: 0.7 })

    // Embedded (default) and linked JSON both carry the flag.
    const embedded = nv.serializeDocument()
    const linked = nv.serializeDocument({ format: 'json', linkData: true })
    const text = new TextDecoder().decode(linked)

    const nvA = new NiiVue({ backend: 'webgl2' })
    await nvA.attachToCanvas(mkCanvas())
    await nvA.loadDocument(new File([embedded], 'hidden.nvd'))

    const nvB = new NiiVue({ backend: 'webgl2' })
    await nvB.attachToCanvas(mkCanvas())
    await nvB.loadDocument(new File([linked], 'hidden.json'))

    // A shown mesh must not gain a `visible` key (documents stay unchanged).
    await nv.setMesh(0, { visible: true })
    const shownText = new TextDecoder().decode(
      nv.serializeDocument({ format: 'json', linkData: true }),
    )

    return {
      hiddenKeyWritten: text.includes('"visible":false'),
      embeddedVisible: nvA.meshes[0]?.visible,
      embeddedOpacity: nvA.meshes[0]?.opacity,
      linkedVisible: nvB.meshes[0]?.visible,
      linkedOpacity: nvB.meshes[0]?.opacity,
      shownKeyWritten: shownText.includes('"visible"'),
    }
  })

  expect(r.hiddenKeyWritten).toBe(true)
  expect(r.embeddedVisible).toBe(false) // hidden survives the embedded path
  expect(r.embeddedOpacity).toBeCloseTo(0.7) // and opacity is untouched
  expect(r.linkedVisible).toBe(false) // hidden survives the URL path
  expect(r.linkedOpacity).toBeCloseTo(0.7)
  expect(r.shownKeyWritten).toBe(false) // shown -> no key written
})

test('volume visible: a hidden volume stays hidden, with its opacity, across a document round-trip', async ({
  page,
}) => {
  test.setTimeout(120_000) // fetches one volume, embeds it, reloads it twice

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const mkCanvas = () => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      c.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(c)
      return c
    }
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(mkCanvas())
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
    await nv.setVolume(0, { opacity: 0.5 })
    await nv.setVolume(0, { visible: false })
    const hiddenOpacity = nv.volumes[0].opacity

    const embedded = nv.serializeDocument()
    const linked = nv.serializeDocument({ format: 'json', linkData: true })
    const text = new TextDecoder().decode(linked)

    const nvA = new NiiVue({ backend: 'webgl2' })
    await nvA.attachToCanvas(mkCanvas())
    await nvA.loadDocument(new File([embedded], 'hidden.nvd'))

    const nvB = new NiiVue({ backend: 'webgl2' })
    await nvB.attachToCanvas(mkCanvas())
    await nvB.loadDocument(new File([linked], 'hidden.json'))

    // Showing it again restores the stored opacity and writes no key.
    await nv.setVolume(0, { visible: true })
    const shownText = new TextDecoder().decode(
      nv.serializeDocument({ format: 'json', linkData: true }),
    )

    return {
      hiddenOpacity,
      hiddenKeyWritten: text.includes('"visible":false'),
      embeddedVisible: nvA.volumes[0]?.visible,
      embeddedOpacity: nvA.volumes[0]?.opacity,
      linkedVisible: nvB.volumes[0]?.visible,
      linkedOpacity: nvB.volumes[0]?.opacity,
      shownOpacity: nv.volumes[0].opacity,
      shownKeyWritten: shownText.includes('"visible"'),
    }
  })

  expect(r.hiddenOpacity).toBeCloseTo(0.5) // hiding leaves opacity alone
  expect(r.hiddenKeyWritten).toBe(true)
  expect(r.embeddedVisible).toBe(false) // hidden survives the embedded path
  expect(r.embeddedOpacity).toBeCloseTo(0.5)
  expect(r.linkedVisible).toBe(false) // hidden survives the URL path
  expect(r.linkedOpacity).toBeCloseTo(0.5)
  expect(r.shownOpacity).toBeCloseTo(0.5) // show -> the 0.5 is back
  expect(r.shownKeyWritten).toBe(false) // shown -> no key written
})

test('load events: loadDocument emits change (and sliceTypeChange) for the settings it applies', async ({
  page,
}) => {
  test.setTimeout(60_000)

  const r = await page.evaluate(async () => {
    const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
    // The containers are still required on this branch (they become optional
    // in a separate PR), so every fixture carries them empty.
    const asFile = (doc: Record<string, unknown>, name: string) =>
      new File(
        [
          JSON.stringify({
            scene: {},
            layout: {},
            clipPlanes: [],
            volumes: [],
            meshes: [],
            ...doc,
          }),
        ],
        name,
        { type: 'application/json' },
      )
    const record = (nv: InstanceType<typeof NiiVue>) => {
      const seen: { type: string; property?: string; value?: unknown }[] = []
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

    // (a) fill:'current' — only the keys the document sets change.
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

    return {
      seen,
      sliceTypeAfter: nv.sliceType,
      quiet: seenQuiet.map((e) => e.type),
      resetAzimuth: reset.azimuth,
      resetEvents: seenReset.filter(
        (e) => e.type !== 'change' || e.property === 'azimuth',
      ),
    }
  })

  const changes = r.seen.filter((e) => e.type === 'change')
  expect(changes).toEqual([
    { type: 'change', property: 'sliceType', value: 0 },
    {
      type: 'change',
      property: 'volumeMatcap',
      value: 'https://example.org/shiny.jpg',
    },
  ])
  expect(r.sliceTypeAfter).toBe(0)
  // sliceType changed -> the paired specialised event fires too, then documentLoaded last.
  expect(r.seen.map((e) => e.type)).toEqual([
    'change',
    'change',
    'sliceTypeChange',
    'documentLoaded',
  ])
  expect(r.quiet).toEqual(['documentLoaded']) // nothing applied -> no change
  expect(r.resetAzimuth).toBe(110) // omitted + default fill -> reset to SCENE_DEFAULTS
  expect(r.resetEvents.map((e) => e.type)).toEqual([
    'change',
    'azimuthElevationChange',
    'documentLoaded',
  ])
  expect(r.resetEvents[0]).toEqual({
    type: 'change',
    property: 'azimuth',
    value: 110,
  })
})

test('load events: loadDocument emits volumeLoaded, meshLoaded, signalLoaded, signalRemoved and drawingChanged for the layers it replaces', async ({
  page,
}) => {
  test.setTimeout(120_000) // fetches a volume, a mesh and a signal, then reloads them

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const mkCanvas = () => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      c.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(c)
      return c
    }

    // Source scene: one linked volume, one embedded mesh, one signal, a drawing.
    const src = new NiiVue({ backend: 'webgl2' })
    await src.attachToCanvas(mkCanvas())
    await src.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
    await src.loadMeshes([{ url: '/meshes/BrainMesh_ICBM152.lh.mz3' }])
    await src.loadSignals([{ url: '/signals/cardiac.tsv.gz' }])
    src.createEmptyDrawing()
    const bytes = src.serializeDocument({ linkData: true })

    // Destination already holds a volume and a signal the load must replace.
    const dst = new NiiVue({ backend: 'webgl2' })
    await dst.attachToCanvas(mkCanvas())
    await dst.loadVolumes([{ url: '/volumes/hippo.nii.gz' }])
    await dst.loadSignals([{ url: '/signals/cardiac.tsv.gz' }])

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

    await dst.loadDocument(new File([bytes], 'scene.nvd'))

    return {
      seen,
      inCollectionAtEmit,
      volumes: dst.volumes.length,
      meshes: dst.meshes.length,
      signals: dst.model.signals.length,
      hasDrawing: !!dst.drawingVolume,
    }
  })

  const count = (t: string) => r.seen.filter((e) => e === t).length
  expect(count('volumeRemoved')).toBe(1) // the destination's hippo
  expect(count('signalRemoved')).toBe(1) // the destination's signal
  expect(count('volumeLoaded')).toBe(1)
  expect(count('meshLoaded')).toBe(1)
  expect(count('signalLoaded')).toBe(1)
  expect(count('drawingChanged:load')).toBe(1)
  expect(r.seen[r.seen.length - 1]).toBe('documentLoaded') // last, as the "all in place" marker
  // Removals precede the settings changes, which precede the loads.
  const idx = (t: string) => r.seen.indexOf(t)
  expect(idx('volumeRemoved')).toBeLessThan(idx('signalRemoved'))
  expect(idx('signalRemoved')).toBeLessThan(idx('volumeLoaded'))
  expect(idx('volumeLoaded')).toBeLessThan(idx('meshLoaded'))
  expect(idx('meshLoaded')).toBeLessThan(idx('signalLoaded'))
  expect(idx('signalLoaded')).toBeLessThan(idx('drawingChanged:load'))
  // A *Loaded listener can reach the item through the collection at emit time;
  // a *Removed listener finds it already gone (it is in the detail instead).
  expect(r.inCollectionAtEmit).toEqual({
    removedVolume: false,
    removedSignal: false,
    volume: true,
    mesh: true,
    signal: true,
  })
  expect([r.volumes, r.meshes, r.signals, r.hasDrawing]).toEqual([
    1,
    1,
    1,
    true,
  ])
})

test('removal events fire after the removal, with the item and its former index in the detail', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    c.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(c)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(c)
    await nv.loadVolumes([
      { url: '/volumes/mni152.nii.gz' },
      { url: '/volumes/hippo.nii.gz' },
    ])
    await nv.loadMeshes([{ url: '/meshes/BrainMesh_ICBM152.lh.mz3' }])

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
    return { log, volumes: nv.volumes.length, meshes: nv.meshes.length }
  })

  expect(r.log).toEqual([
    { type: 'meshRemoved', index: 0, gone: true, lengthAtEmit: 0 },
    { type: 'volumeRemoved', index: 1, gone: true, lengthAtEmit: 1 },
    { type: 'volumeRemoved', index: 0, gone: true, lengthAtEmit: 0 },
  ])
  expect([r.volumes, r.meshes]).toEqual([0, 0])
})

test('json format: saves portable JSON that loadDocument reads back (linked + embedded)', async ({
  page,
}) => {
  test.setTimeout(90_000) // embedded JSON base64-encodes the full volume

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const mkCanvas = () => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      c.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(c)
      return c
    }

    const nv = new NiiVue({ backend: 'webgl2', azimuth: 175 })
    await nv.attachToCanvas(mkCanvas())
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])

    // JSON + linked: small, human-readable text.
    const jsonLinked = nv.serializeDocument({ format: 'json', linkData: true })
    const text = new TextDecoder().decode(jsonLinked)
    let parseable = true
    try {
      JSON.parse(text)
    } catch {
      parseable = false
    }

    // loadDocument sniffs JSON vs CBOR — a .json linked doc rehydrates by URL.
    const nvLinked = new NiiVue({ backend: 'webgl2' })
    await nvLinked.attachToCanvas(mkCanvas())
    await nvLinked.loadDocument(new File([jsonLinked], 'scene.json'))

    // Embedded JSON round-trips the voxels through base64.
    const jsonEmbedded = nv.serializeDocument({ format: 'json' })
    const nvEmbedded = new NiiVue({ backend: 'webgl2' })
    await nvEmbedded.attachToCanvas(mkCanvas())
    await nvEmbedded.loadDocument(new File([jsonEmbedded], 'embed.json'))

    // Non-finite numbers: calMinNeg defaults to NaN on a loaded volume. JSON has
    // no NaN, so the codec tags it; a reload must yield NaN again, not null.
    // (Computed here: page.evaluate's own JSON transport would turn NaN into
    // null on the way back to the test.)
    const isNaNAfterReload = (v: unknown): boolean =>
      typeof v === 'number' && Number.isNaN(v)

    return {
      startsWithBrace: text.trimStart().startsWith('{'),
      parseable,
      taggedNaN: text.includes('"$num":"NaN"'),
      bareNullCalMinNeg: text.includes('"calMinNeg":null'),
      linkedAzimuth: nvLinked.azimuth,
      linkedUrl: nvLinked.volumes[0]?.url,
      linkedVoxels: nvLinked.volumes[0]?.img?.length ?? 0,
      linkedCalMinNegIsNaN: isNaNAfterReload(nvLinked.volumes[0]?.calMinNeg),
      embeddedVoxels: nvEmbedded.volumes[0]?.img?.length ?? 0,
      embeddedCalMinNegIsNaN: isNaNAfterReload(
        nvEmbedded.volumes[0]?.calMinNeg,
      ),
    }
  })

  expect(r.startsWithBrace).toBe(true) // human-readable JSON, not binary
  expect(r.parseable).toBe(true)
  expect(r.taggedNaN).toBe(true) // NaN survives as a { $num } tag ...
  expect(r.bareNullCalMinNeg).toBe(false) // ... not as JSON.stringify's null
  expect(r.linkedAzimuth).toBe(175) // scene restored from JSON
  expect(r.linkedUrl).toBe('/volumes/mni152.nii.gz')
  expect(r.linkedVoxels).toBeGreaterThan(1_000_000) // linked -> refetched
  expect(r.linkedCalMinNegIsNaN).toBe(true) // NaN round-trips on the URL path
  expect(r.embeddedVoxels).toBeGreaterThan(1_000_000) // embedded JSON -> base64 voxels
  expect(r.embeddedCalMinNegIsNaN).toBe(true) // and on the embedded path
})

test('matcap: constructor preserves explicit options and defaults when omitted', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const matcaps = { cortex: '/m/Cortex.jpg', gold: '/m/Gold.jpg' }
    return [
      undefined,
      'https://example.org/custom.jpg',
      'https://example.org/assets/matcaps/Cortex.jpg',
      '',
      'gold',
    ].map((volumeMatcap) => new NiiVue({ matcaps, volumeMatcap }).volumeMatcap)
  })
  expect(result).toEqual([
    '/m/Cortex.jpg',
    'https://example.org/custom.jpg',
    'https://example.org/assets/matcaps/Cortex.jpg',
    '',
    '/m/Gold.jpg',
  ])
})

test('matcap: saved by name, loads back as its URL, custom URLs are kept', async ({
  page,
}) => {
  test.setTimeout(60_000) // shares the one-time Vite module-graph transform

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')

    const src = new NiiVue()
    const url = src.volumeMatcap
    const json = new TextDecoder().decode(
      src.serializeDocument({ format: 'json' }),
    )
    const saved = JSON.parse(json).volume?.matcap

    const reloaded = new NiiVue()
    reloaded.volumeMatcap = ''
    await reloaded.loadDocument(new File([json], 'named.json'))

    // A document saved before names stored the dev server's path, which only
    // resolves on that server. It loads by file name.
    const legacy = json.replace(
      '"matcap":"cortex"',
      '"matcap":"/src/assets/matcaps/Cortex.jpg"',
    )
    const fromLegacy = new NiiVue()
    await fromLegacy.loadDocument(new File([legacy], 'legacy.json'))

    // An app's own image is kept, even when its file shares a built-in's
    // name; the renderer draws the default if it does not load.
    const custom = json.replace(
      '"matcap":"cortex"',
      '"matcap":"/custom/Cortex.jpg"',
    )
    const fromCustom = new NiiVue()
    await fromCustom.loadDocument(new File([custom], 'custom.json'))

    // A name this instance does not know cannot be fetched, so it loads as the
    // instance default.
    const unknown = json.replace('"matcap":"cortex"', '"matcap":"gold"')
    const fromUnknown = new NiiVue()
    fromUnknown.volumeMatcap = ''
    await fromUnknown.loadDocument(new File([unknown], 'unknown.json'))

    return {
      url,
      saved,
      reloaded: reloaded.volumeMatcap,
      legacyReplaced: legacy !== json,
      fromLegacy: fromLegacy.volumeMatcap,
      customReplaced: custom !== json,
      fromCustom: fromCustom.volumeMatcap,
      unknownReplaced: unknown !== json,
      fromUnknown: fromUnknown.volumeMatcap,
    }
  })

  expect(r.url).not.toBe('')
  expect(r.saved).toBe('cortex')
  expect(r.reloaded).toBe(r.url)
  expect(r.legacyReplaced).toBe(true)
  expect(r.fromLegacy).toBe(r.url)
  expect(r.customReplaced).toBe(true)
  expect(r.fromCustom).toBe('/custom/Cortex.jpg')
  expect(r.unknownReplaced).toBe(true)
  expect(r.fromUnknown).toBe(r.url)
})

for (const fill of ['current', { 'volume.matcap': 'current' }] as const) {
  test(`matcap: omitted value respects fill ${JSON.stringify(fill)}`, async ({
    page,
  }) => {
    const result = await page.evaluate(async (fill) => {
      const { default: NiiVue } = await import('/src/index.ts')
      const nv = new NiiVue({
        matcaps: { cortex: '/m/Cortex.jpg', gold: '/m/custom-gold.jpg' },
      })
      nv.volumeMatcap = '/m/custom-gold.jpg'
      const changes: string[] = []
      nv.addEventListener('change', (event) => {
        changes.push(event.detail.property)
      })
      await nv.loadDocument(new File(['{"version":9}'], 'empty.json'), { fill })
      return { matcap: nv.volumeMatcap, changes }
    }, fill)
    expect(result.matcap).toBe('/m/custom-gold.jpg')
    expect(result.changes).not.toContain('volumeMatcap')
  })
}
