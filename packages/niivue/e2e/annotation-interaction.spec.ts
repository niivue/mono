import { expect } from '@playwright/test'
import { test } from './sharedPage'
import { syntheticVolume } from './syntheticVolume'

// The pointerup `finally` now clears `_annotationShapeStart`, `_resizingControlPoint`,
// `_resizingAnnotation` and `_resizeOriginalShape` unconditionally. Those fields are
// set in pointerdown and consumed in pointerup, so clearing them afterwards must not
// break the normal draw / select / resize flow. These tests pin that down; they also
// pin that clearing them does NOT clear the annotation SELECTION, which must survive
// a pointerup so the control points stay grabbable.

const setup = `
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const synth = ${syntheticVolume}
  const c = document.createElement('canvas')
  c.width = 400; c.height = 400
  c.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:400px'
  document.body.appendChild(c)
  const nv = new NiiVue({ backend: 'webgl2', sliceType: SLICE_TYPE.AXIAL })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([{ url: synth() }])
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

test('erasing a measured ROI in two re-measures both pieces and projects both (#115)', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.annotationTool = 'measureRect'
    drag([[100, 150], [200, 200], [300, 250]])
    const before = nv.annotations[0].stats.area
    nv.annotationIsErasing = true
    nv.annotationBrushRadius = 3
    drag([[200, 120], [200, 200], [200, 280]])
    nv.isAnnotationDrawn = false
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const ann = nv.annotations[0]
    return {
      count: nv.annotations.length,
      pieces: ann.polygons.length,
      before,
      after: ann.stats.area,
      screenPieces: nv.annotationScreenShapes[0]?.polygons.length,
    }
  })()`)

  expect(r.count).toBe(1)
  expect(r.pieces).toBe(2)
  expect(r.screenPieces).toBe(2)
  // Both pieces are measured: less than before, more than either half.
  expect(r.after).toBeLessThan(r.before)
  expect(r.after).toBeGreaterThan(r.before * 0.6)
})

test('an erase keeps annotations the brush did not reach (#486)', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.annotationTool = 'measureRect'
    drag([[60, 60], [100, 100], [140, 140]])
    drag([[260, 260], [300, 300], [340, 340]])
    const [erased, untouched] = nv.annotations
    const untouchedStats = untouched.stats
    nv.annotationIsErasing = true
    nv.annotationBrushRadius = 3
    drag([[100, 40], [100, 100], [100, 160]])
    return {
      count: nv.annotations.length,
      keptObject: nv.annotations.includes(untouched),
      keptStats: untouched.stats === untouchedStats,
      replacedErased: !nv.annotations.includes(erased),
    }
  })()`)

  expect(r.count).toBe(2)
  expect(r.keptObject).toBe(true)
  expect(r.keptStats).toBe(true)
  expect(r.replacedErased).toBe(true)
})

test('annotationIsClickToPlace: click-move-click places a shape; drags and the default are unchanged', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    const click = (x, y) => drag([[x, y]])
    // Default off: a click places nothing.
    click(120, 120)
    const off = nv.annotations.length
    nv.annotationIsClickToPlace = true
    // Two clicks: one rectangle from the first to the second point.
    click(120, 120)
    const afterFirst = nv.annotations.length
    click(200, 200)
    const afterSecond = nv.annotations.length
    // A drag still places a shape in one gesture.
    drag([[220, 220], [260, 260], [300, 300]])
    const afterDrag = nv.annotations.length
    // Entering eraser mode drops a parked start, so a later press cannot resume it.
    click(120, 120)
    nv.annotationIsErasing = true
    return { off, afterFirst, afterSecond, afterDrag, parked: nv._annotationClickStart, preview: nv.model._annotationPreview }
  })()`)

  expect(r.off).toBe(0)
  expect(r.afterFirst).toBe(0)
  expect(r.afterSecond).toBe(1)
  expect(r.afterDrag).toBe(2)
  expect(r.parked).toBeNull()
  expect(r.preview).toBeNull()
})

test('annotationIsClickToPlace: places a shape on an oblique volume; turning it off drops the preview', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    // Tilted: the mm depth varies across one slice, so the slice test is in texture depth.
    await nv.loadVolumes([{ url: synth({ tilt: [10, 8] }) }])
    // Let the replaced volume's layout draw before clicking on it.
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    const click = (x, y) => drag([[x, y]])
    nv.annotationIsClickToPlace = true
    click(120, 120)
    click(280, 280)
    const placed = nv.annotations.length
    click(120, 120)
    ev('pointermove', 200, 200, -1)
    const previewed = !!nv.model._annotationPreview
    // Leaving the canvas drops the rubber band; the start stays parked.
    c.dispatchEvent(new PointerEvent('pointerleave'))
    const leftPreview = nv.model._annotationPreview
    const leftParked = !!nv._annotationClickStart
    nv.annotationIsClickToPlace = false
    return { placed, previewed, leftPreview, leftParked, preview: nv.model._annotationPreview, parked: nv._annotationClickStart }
  })()`)

  expect(r.placed).toBe(1)
  expect(r.previewed).toBe(true)
  expect(r.leftPreview).toBeNull()
  expect(r.leftParked).toBe(true)
  expect(r.preview).toBeNull()
  expect(r.parked).toBeNull()
})

test('annotationIsClickToPlace: moving onto the render tile drops the rubber band, not the start', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.sliceType = SLICE_TYPE.MULTIPLANAR
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    const tileCentre = (match) => {
      const pts = []
      for (let y = 5; y < 400; y += 5)
        for (let x = 5; x < 400; x += 5) {
          const t = nv.view.hitTest(x, y)
          if (t && match(t)) pts.push([x, y])
        }
      return [0, 1].map((i) =>
        (Math.min(...pts.map((p) => p[i])) + Math.max(...pts.map((p) => p[i]))) / 2)
    }
    const [ax, ay] = tileCentre((t) => !t.isRender && t.sliceType === SLICE_TYPE.AXIAL)
    const [rx, ry] = tileCentre((t) => t.isRender)
    nv.annotationIsClickToPlace = true
    drag([[ax, ay]])
    ev('pointermove', ax + 20, ay + 20, -1)
    const previewed = !!nv.model._annotationPreview
    ev('pointermove', rx, ry, -1)
    return { previewed, preview: nv.model._annotationPreview, parked: !!nv._annotationClickStart }
  })()`)

  expect(r.previewed).toBe(true)
  expect(r.preview).toBeNull()
  expect(r.parked).toBe(true)
})

test('annotationIsClickToPlace: a parked start beats a selected control point', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.annotationIsClickToPlace = true
    nv.annotationMergesOverlaps = false
    drag([[120, 120]])
    drag([[200, 200]])
    const id = nv.annotations[0].id
    // Park a start, select the shape via the API, then press its corner.
    drag([[260, 120]])
    nv.selectAnnotation(id)
    drag([[200, 200]])
    return { count: nv.annotations.length, parked: nv._annotationClickStart }
  })()`)

  expect(r.count).toBe(2)
  expect(r.parked).toBeNull()
})

test('annotationIsClickToPlace: Escape drops a parked start; a parked start beats selection; jitter is a click', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.annotationIsClickToPlace = true
    nv.annotationMergesOverlaps = false
    // 2 px of press/release jitter still parks (screen-space click).
    drag([[120, 120], [122, 121]])
    const jitterParked = !!nv._annotationClickStart
    ev('pointermove', 150, 150, -1)
    const rubberBand = nv.model._annotationPreview?.shape?.end ?? null
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    const escParked = nv._annotationClickStart
    drag([[200, 200]])
    const afterEsc = nv.annotations.length
    // Finish that shape, then park a new start and end it on the shape's edge:
    // the press resumes the parked start instead of selecting the shape.
    drag([[260, 260]])
    drag([[100, 100]])
    drag([[200, 230]])
    return { rubberBand, selected: !!nv.model._annotationSelection, jitterParked, escParked, afterEsc, count: nv.annotations.length, parked: nv._annotationClickStart }
  })()`)

  expect(r.jitterParked).toBe(true)
  expect(r.rubberBand).not.toBeNull()
  expect(r.escParked).toBeNull()
  expect(r.afterEsc).toBe(0)
  expect(r.count).toBe(2)
  expect(r.selected).toBe(false)
  expect(r.parked).toBeNull()
})

test('annotationIsDrawnFromCenter: ellipse and circle grow from the press point', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.annotationMergesOverlaps = false
    nv.annotationTool = 'ellipse'
    drag([[200, 200], [230, 220], [240, 220]])
    const corner = nv.annotations[0].shape
    nv.annotationIsDrawnFromCenter = true
    drag([[200, 200], [230, 220], [240, 220]])
    const centre = nv.annotations[1].shape
    nv.annotationTool = 'circle'
    // Clear of the ellipses: a press on a shape selects it.
    drag([[100, 320], [130, 330], [130, 320]])
    const circle = nv.annotations[2].shape
    const mid = (s) => [(s.start.x + s.end.x) / 2, (s.start.y + s.end.y) / 2]
    const size = (s) => [Math.abs(s.end.x - s.start.x), Math.abs(s.end.y - s.start.y)]
    return { cornerSize: size(corner), centreSize: size(centre), centreMid: mid(centre), press: [corner.start.x, corner.start.y], circleSize: size(circle), circleMid: mid(circle) }
  })()`)

  // Same drag: the centred ellipse's box is twice as wide and tall, centred on the press.
  expect(r.centreSize[0]).toBeCloseTo(r.cornerSize[0] * 2, 5)
  expect(r.centreSize[1]).toBeCloseTo(r.cornerSize[1] * 2, 5)
  expect(r.centreMid[0]).toBeCloseTo(r.press[0], 5)
  expect(r.centreMid[1]).toBeCloseTo(r.press[1], 5)
  // Circle: rim point 30 px right of the press, so a square box centred on it.
  expect(r.circleSize[0]).toBeCloseTo(r.circleSize[1], 5)
  // Rim 30 px from the press: the box is 60 px of canvas, twice a corner drag's 30.
  expect(r.circleSize[0]).toBeCloseTo(r.cornerSize[0] * 1.5, 5)
})
