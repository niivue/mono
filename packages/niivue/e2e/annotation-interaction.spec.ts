import { expect, test } from '@playwright/test'

// The pointerup `finally` now clears `_annotationShapeStart`, `_resizingControlPoint`,
// `_resizingAnnotation` and `_resizeOriginalShape` unconditionally. Those fields are
// set in pointerdown and consumed in pointerup, so clearing them afterwards must not
// break the normal draw / select / resize flow. These tests pin that down; they also
// pin that clearing them does NOT clear the annotation SELECTION, which must survive
// a pointerup so the control points stay grabbable.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const setup = `
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = 400; c.height = 400
  c.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:400px'
  document.body.appendChild(c)
  const nv = new NiiVue({ backend: 'webgl2', sliceType: SLICE_TYPE.AXIAL })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
  nv.annotationIsEnabled = true
  nv.annotationTool = 'rectangle'

  c.setPointerCapture = () => {}
  c.releasePointerCapture = () => {}
  const r = c.getBoundingClientRect()
  const ev = (type, x, y, button) => c.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, bubbles: true, cancelable: true,
    clientX: r.left + x, clientY: r.top + y,
    button, buttons: 1, pointerType: 'mouse',
  }))
  const drag = (pts) => {
    ev('pointerdown', pts[0][0], pts[0][1], 0)
    for (const p of pts.slice(1)) ev('pointermove', p[0], p[1], -1)
    const last = pts[pts.length - 1]
    ev('pointerup', last[0], last[1], 0)
  }
`

test('a rectangle drag creates exactly one annotation', async ({ page }) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    drag([[120, 120], [160, 160], [200, 200]])
    const a = nv.annotations
    return {
      count: a.length,
      type: a[0]?.shape?.type ?? null,
      hasPolygons: (a[0]?.polygons?.length ?? 0) > 0,
      // The finalize cleared its own drag state.
      shapeStart: nv._annotationShapeStart,
      isDragging: nv.isDragging,
    }
  })()`)

  expect(r.count).toBe(1)
  expect(r.type).toBe('rectangle')
  expect(r.hasPolygons).toBe(true)
  expect(r.shapeStart).toBeNull()
  expect(r.isDragging).toBe(false)
})

test('a second drag adds a second annotation (drag state did not leak)', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const count = await page.evaluate(`(async () => {
    ${setup}
    drag([[100, 100], [130, 130], [150, 150]])
    drag([[220, 220], [250, 250], [280, 280]])
    return nv.annotations.length
  })()`)

  // If pointerup had left `_annotationShapeStart` set, the second drag would
  // build its shape from the FIRST drag's start point (or merge oddly).
  expect(count).toBe(2)
})

test('with both edit modes on, raster drawing wins and the conflict is announced', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })

  const r = await page.evaluate(`(async () => {
    ${setup}
    // Enable the raster pen too. Both modes on is a caller error; raster wins.
    nv.createEmptyDrawing()
    nv.drawIsEnabled = true
    nv.drawPenValue = 1

    let drawingChanged = 0
    nv.addEventListener('drawingChanged', () => { drawingChanged++ })

    drag([[120, 120], [160, 160], [200, 200]])
    return { annotations: nv.annotations.length, drawingChanged }
  })()`)

  // The pen painted; no vector annotation was created.
  expect(r.drawingChanged).toBeGreaterThan(0)
  expect(r.annotations).toBe(0)
  // And it did not fail silently.
  expect(warnings.join('\n')).toContain('both on')
})

test('selection survives pointerup and a control-point drag resizes the shape', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    drag([[120, 120], [160, 160], [200, 200]])
    const before = { ...nv.annotations[0].shape.end }

    // Click inside the shape to select it: selection must SURVIVE the pointerup,
    // otherwise the control points vanish and it can never be resized.
    ev('pointerdown', 160, 160, 0)
    ev('pointerup', 160, 160, 0)
    const selectedAfterUp = !!nv.model._annotationSelection

    // Grab the corner control point and drag it out.
    drag([[200, 200], [230, 230], [250, 250]])
    const after = { ...nv.annotations[0].shape.end }

    return {
      selectedAfterUp,
      before,
      after,
      count: nv.annotations.length,
      resizeCleared: nv._resizingControlPoint,
      resizingAnnotation: nv._resizingAnnotation,
    }
  })()`)

  expect(r.selectedAfterUp).toBe(true)
  expect(r.count).toBe(1)
  // The corner actually moved: a resize happened.
  expect(r.after).not.toEqual(r.before)
  // And the resize drag state was cleaned up.
  expect(r.resizeCleared).toBe(-1)
  expect(r.resizingAnnotation).toBeNull()
})
