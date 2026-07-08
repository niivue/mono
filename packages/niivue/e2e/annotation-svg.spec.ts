import { expect, test } from '@playwright/test'

// End-to-end coverage for `nv.annotationsToSVG()` — specifically the controller
// wiring that picks the plane(s) to export, which the Bun unit tests cannot reach
// (NiiVue's Vite module graph needs a real browser). The pure serializer is unit
// tested in src/annotation/annotationSvg.test.ts.
//
// The behavior under test: in a view with no single slice plane on screen
// (render / multiplanar), every plane exports. Previously the controller fell back
// to `annotations[0].sliceType` and silently dropped shapes on other planes.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// Build an instance holding one square annotation on each of the three planes.
const setup = `
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  c.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(c)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])

  const square = (id, sliceType) => ({
    id,
    label: 1,
    group: 'g',
    sliceType,
    slicePosition: 0,
    polygons: [{
      outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      holes: [],
    }],
    style: {
      fillColor: [1, 0, 0, 0.3],
      strokeColor: [1, 0, 0, 1],
      strokeWidth: 2,
    },
  })
  nv.addAnnotation(square('ax', SLICE_TYPE.AXIAL))
  nv.addAnnotation(square('co', SLICE_TYPE.CORONAL))
  nv.addAnnotation(square('sa', SLICE_TYPE.SAGITTAL))
`

test('multiplanar view exports every plane, not just the first annotation of the first plane', async ({
  page,
}) => {
  test.setTimeout(90_000) // fetch of a full volume

  const svg = await page.evaluate(`(async () => {
    ${setup}
    const { SLICE_TYPE: ST } = await import('/src/index.ts')
    nv.sliceType = ST.MULTIPLANAR
    return nv.annotationsToSVG()
  })()`)

  expect(svg).toContain('data-slice-plane="AXIAL"')
  expect(svg).toContain('data-slice-plane="CORONAL"')
  expect(svg).toContain('data-slice-plane="SAGITTAL"')
  expect(svg?.match(/<path /g)?.length).toBe(3)
  // Panels are laid out left-to-right, so at least one is translated off zero.
  expect(svg).toMatch(/transform="translate\((?!0 0)/)
})

test('render view (no single slice plane) also exports every plane', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const svg = await page.evaluate(`(async () => {
    ${setup}
    const { SLICE_TYPE: ST } = await import('/src/index.ts')
    nv.sliceType = ST.RENDER
    return nv.annotationsToSVG()
  })()`)

  expect(svg?.match(/<path /g)?.length).toBe(3)
})

test('a single-slice view still restricts the export to that plane', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    const { SLICE_TYPE: ST } = await import('/src/index.ts')
    nv.sliceType = ST.CORONAL
    const auto = nv.annotationsToSVG()
    // An explicit sliceType overrides the current view.
    const explicit = nv.annotationsToSVG(ST.SAGITTAL)
    return { auto, explicit }
  })()`)

  expect(r.auto).toContain('data-slice-plane="CORONAL"')
  expect(r.auto).not.toContain('data-slice-plane="AXIAL"')
  expect(r.auto?.match(/<path /g)?.length).toBe(1)

  expect(r.explicit).toContain('data-slice-plane="SAGITTAL"')
  expect(r.explicit?.match(/<path /g)?.length).toBe(1)
})

test('returns null when there are no annotations', async ({ page }) => {
  test.setTimeout(90_000)

  const svg = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    c.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(c)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(c)
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
    return nv.annotationsToSVG()
  })()`)

  expect(svg).toBeNull()
})
