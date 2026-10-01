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
