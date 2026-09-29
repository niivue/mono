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
          volume: { matcap: 'shiny' },
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
    { type: 'change', property: 'volumeMatcap', value: 'shiny' },
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

    return {
      startsWithBrace: text.trimStart().startsWith('{'),
      parseable,
      linkedAzimuth: nvLinked.azimuth,
      linkedUrl: nvLinked.volumes[0]?.url,
      linkedVoxels: nvLinked.volumes[0]?.img?.length ?? 0,
      embeddedVoxels: nvEmbedded.volumes[0]?.img?.length ?? 0,
    }
  })

  expect(r.startsWithBrace).toBe(true) // human-readable JSON, not binary
  expect(r.parseable).toBe(true)
  expect(r.linkedAzimuth).toBe(175) // scene restored from JSON
  expect(r.linkedUrl).toBe('/volumes/mni152.nii.gz')
  expect(r.linkedVoxels).toBeGreaterThan(1_000_000) // linked -> refetched
  expect(r.embeddedVoxels).toBeGreaterThan(1_000_000) // embedded JSON -> base64 voxels
})
