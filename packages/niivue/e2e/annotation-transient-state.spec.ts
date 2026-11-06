import { expect } from '@playwright/test'
import { test } from './sharedPage'
import { syntheticVolume } from './syntheticVolume'

// A half-drawn annotation (bidirectional long axis, multi-click contour) must
// stay on its own slice and scene: #111 (slice change), #112 (re-selecting the
// same tool), #113 (loadDocument), #114 (double-click on the 3D render tile).
// The volumes are synthetic (`syntheticVolume`), built in the page.

const OBLIQUE = 'synth({ tilt: [10, 8] })'

const setup = (
  sliceType: string,
  tool: string,
  volume = 'synth()',
  width = 400,
) => `
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const synth = ${syntheticVolume}
  const c = document.createElement('canvas')
  c.style.cssText = 'position:fixed;left:0;top:0;width:${width}px;height:400px'
  document.body.appendChild(c)
  const nv = new NiiVue({
    backend: 'webgl2',
    devicePixelRatio: 1,
    sliceType: SLICE_TYPE.${sliceType},
  })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([{ url: ${volume} }])
  // Updates settled and the next frame drawn: hit testing reads the drawn
  // tiles.
  const drawn = async () => {
    await nv.whenUpdatesSettle()
    await nv.whenChunkStreamSettles()
    do {
      await new Promise((r) => requestAnimationFrame(r))
    } while (nv.framePending)
  }
  // A double-click that reaches the depth pick moves the crosshair once the
  // pick resolves: record the pick so a test can wait for it.
  const depthPick = nv.view.depthPick.bind(nv.view)
  let lastPick = null
  nv.view.depthPick = (...a) => (lastPick = depthPick(...a))
  const picked = async () => {
    // The handler awaited the pick first, so its continuation has run once
    // this await of the same promise returns.
    if (lastPick) await lastPick.catch(() => null)
  }
  nv.annotationIsEnabled = true
  nv.annotationTool = '${tool}'

  c.setPointerCapture = () => {}
  c.releasePointerCapture = () => {}
  const r = c.getBoundingClientRect()
  const ev = (type, x, y, button, Ctor = PointerEvent, buttons = 1) => c.dispatchEvent(new Ctor(type, {
    pointerId: 1, bubbles: true, cancelable: true,
    clientX: r.left + x, clientY: r.top + y,
    button, buttons, pointerType: 'mouse',
  }))
  // Centre of the bounding box of the canvas points whose tile matches.
  const tileCentre = (match) => {
    const pts = []
    for (let y = 5; y < 400; y += 5) {
      for (let x = 5; x < ${width}; x += 5) {
        const t = nv.view.hitTest(x, y)
        if (t && match(t)) pts.push([x, y])
      }
    }
    return [0, 1].map((i) =>
      (Math.min(...pts.map((p) => p[i])) + Math.max(...pts.map((p) => p[i]))) / 2)
  }
  const drag = (a, b) => {
    ev('pointerdown', a[0], a[1], 0)
    ev('pointermove', b[0], b[1], -1)
    ev('pointerup', b[0], b[1], 0)
  }
  const click = (p) => {
    ev('pointerdown', p[0], p[1], 0)
    ev('pointerup', p[0], p[1], 0)
  }
`

test('a bidirectional short axis on another slice starts the measurement over (#111)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'bidirectional')}
    drag([150, 200], [250, 200])
    const longAfterFirst = nv._bidirectionalLong !== null
    nv.moveCrosshairInVox(0, 0, 10)
    drag([200, 170], [200, 230])
    return {
      longAfterFirst,
      count: nv.annotations.length,
      // The second drag is now the long axis of a fresh measurement.
      restarted: nv._bidirectionalLong !== null,
    }
  })()`)
  expect(r.longAfterFirst).toBe(true)
  expect(r.count).toBe(0)
  expect(r.restarted).toBe(true)
})

test('a bidirectional measurement on one slice still commits', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const count = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'bidirectional')}
    drag([150, 200], [250, 200])
    drag([200, 170], [200, 230])
    return nv.annotations.length
  })()`)
  expect(count).toBe(1)
})

test('a bidirectional measurement on one oblique slice still commits', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const count = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'bidirectional', OBLIQUE)}
    // The axial plane is tilted in mm, so the two drags differ in mm z.
    drag([150, 200], [250, 200])
    drag([200, 120], [200, 280])
    return nv.annotations.length
  })()`)
  expect(count).toBe(1)
})

// The axial plane of an oblique volume is tilted in mm, so clicks on one slice
// differ in mm z; the contour must still belong to that one slice (#469).
for (const tool of ['spline', 'livewire']) {
  test(`a ${tool} contour on one oblique slice keeps its points (#469)`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const r = await page.evaluate(`(async () => {
      ${setup('AXIAL', tool, OBLIQUE)}
      // A fresh contour resets its anchor (the first click); livewire's
      // points are its traced path, so the anchor is what tells.
      const anchor = () => JSON.stringify(nv._annotationPolyAnchorMM)
      click([150, 140])
      const first = anchor()
      click([260, 160])
      click([200, 280])
      const kept = anchor() === first && nv._annotationPolyPoints.length >= 3
      ev('dblclick', 200, 280, 0, MouseEvent)
      const committed = nv.annotations.length
      // A click on another slice still starts over.
      click([150, 140])
      const second = anchor()
      nv.moveCrosshairInVox(0, 0, 8)
      // Hit testing reads the drawn slice, so let it redraw.
      await drawn()
      click([260, 160])
      return { kept, committed, restarted: anchor() !== second }
    })()`)
    expect(r.kept).toBe(true)
    expect(r.committed).toBe(1)
    expect(r.restarted).toBe(true)
  })
}

test('re-selecting the current tool keeps a half-drawn contour (#112)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'spline')}
    const changes = []
    nv.addEventListener('change', (e) => changes.push(e.detail.property))
    click([150, 150])
    click([250, 150])
    nv.annotationTool = 'spline'
    return {
      points: nv._annotationPolyPoints?.length ?? 0,
      toolChanges: changes.filter((p) => p === 'annotationTool').length,
    }
  })()`)
  expect(r.points).toBe(2)
  expect(r.toolChanges).toBe(0)
})

test('loadDocument drops a half-drawn measurement and the old undo history (#113)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'bidirectional')}
    const doc = nv.serializeDocument({ format: 'json' })
    // Two committed measurements (undo would bring the first back) and a
    // half-drawn third.
    drag([150, 200], [250, 200])
    drag([200, 170], [200, 230])
    drag([150, 300], [250, 300])
    drag([200, 270], [200, 330])
    drag([150, 250], [250, 250])
    const before = {
      count: nv.annotations.length,
      long: nv._bidirectionalLong !== null,
    }
    await nv.loadDocument(new File([doc], 'scene.nvd'))
    const after = {
      long: nv._bidirectionalLong,
      preview: nv.model._annotationPreview,
    }
    // Undo must not bring the old scene's measurement into the new one.
    nv.annotationUndo()
    return { before, after, count: nv.annotations.length }
  })()`)
  expect(r.before).toEqual({ count: 2, long: true })
  expect(r.after).toEqual({ long: null, preview: null })
  expect(r.count).toBe(0)
})

test('a double-click on the 3D render tile does not close a contour (#114)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('MULTIPLANAR', 'spline')}
    // The centre of the render tile is on the brain, where a depth pick would
    // move the crosshair.
    const render = tileCentre((t) => t.isRender)
    const [ax, ay] = tileCentre((t) => !t.isRender && t.sliceType === SLICE_TYPE.AXIAL)
    click([ax, ay])
    click([ax + 6, ay])
    click([ax + 3, ay + 6])
    const crosshair = [...nv.crosshairPos]
    ev('dblclick', render[0], render[1], 0, MouseEvent)
    // A depth pick, had the double-click reached one, moves the crosshair
    // when it resolves.
    await picked()
    const afterRender = {
      count: nv.annotations.length,
      points: nv._annotationPolyPoints?.length ?? 0,
      crosshairMoved: nv.crosshairPos.some((v, i) => v !== crosshair[i]),
    }
    // The same double-click on the axial tile closes it.
    click([ax + 3, ay + 3])
    ev('dblclick', ax + 3, ay + 3, 0, MouseEvent)
    return { afterRender, count: nv.annotations.length }
  })()`)
  expect(r.afterRender).toEqual({ count: 0, points: 3, crosshairMoved: false })
  expect(r.count).toBe(1)
})

test('a double-click on graph zoom-out still resets the graph mid-contour', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'spline', undefined, 1600)}
    // Wide enough for the graph's pan/zoom buttons.
    await nv.loadSignals([{ url: '/signals/svs_se_30.nii.gz' }])
    nv.isGraphVisible = true
    nv.graphZoom(2).graphZoom(2)
    // The graph's buttons are laid out by the frame that draws it.
    await drawn()
    const zoomed = nv.model.signalViewWindow !== null
    const [ax, ay] = tileCentre((t) => !t.isRender)
    click([ax, ay])
    click([ax + 6, ay])
    click([ax + 3, ay + 6])
    const b = nv.view.graphLayout.controls.find((k) => k.id === 'zoomOut')
    ev('dblclick', b.x + b.w / 2, b.y + b.h / 2, 0, MouseEvent)
    return {
      zoomed,
      reset: nv.model.signalViewWindow === null,
      points: nv._annotationPolyPoints?.length ?? 0,
    }
  })()`)
  expect(r).toEqual({ zoomed: true, reset: true, points: 3 })
})

// The 2D slice check reads texture depth, which chunking and the 3D explode
// leave alone; the exploded-block 3D stroke is axis-aligned volumes only.
for (const [volume, oblique] of [
  ['synth()', false],
  [OBLIQUE, true],
] as const) {
  test(`annotations still draw on exploded blocks (${oblique ? 'oblique' : 'axis-aligned'})`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const kinds = await page.evaluate(`(async () => {
      ${setup('MULTIPLANAR', 'bidirectional', volume)}
      await nv.setVolumeChunkGrid(0, [2, 2, 2])
      await nv.setVolumeChunkExplode(0, { enabled: true, scale: [1.5, 1.5, 1.5] })
      await drawn()
      // Overlapping shapes merge, so count additions rather than annotations.
      const added = []
      nv.addEventListener('annotationAdded', (e) =>
        added.push(e.detail.annotation.shape?.type ?? 'freehand'))
      const [ax, ay] = tileCentre((t) => !t.isRender && t.sliceType === SLICE_TYPE.AXIAL)
      drag([ax - 20, ay], [ax + 20, ay])
      drag([ax, ay - 10], [ax, ay + 10])
      nv.annotationTool = 'spline'
      click([ax - 10, ay - 10])
      click([ax + 10, ay - 10])
      click([ax, ay + 10])
      ev('dblclick', ax, ay + 10, 0, MouseEvent)
      // A right-drag on a block in the 3D render draws a vector stroke.
      nv.annotationTool = 'freehand'
      const [rx, ry] = tileCentre((t) => t.isRender)
      ev('pointerdown', rx - 6, ry - 6, 2, PointerEvent, 2)
      ev('pointermove', rx + 6, ry - 6, -1, PointerEvent, 2)
      ev('pointermove', rx + 6, ry + 6, -1, PointerEvent, 2)
      ev('pointermove', rx - 6, ry + 6, -1, PointerEvent, 2)
      ev('pointerup', rx - 6, ry + 6, 2, PointerEvent, 0)
      return added
    })()`)
    // Oblique: the 3D stroke skips oblique volumes.
    expect(kinds).toEqual(
      oblique
        ? ['bidirectional', 'spline']
        : ['bidirectional', 'spline', 'freehand'],
    )
  })
}

test('Escape mid-drag cancels a bidirectional short axis (#471)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'bidirectional')}
    drag([150, 200], [250, 200])
    // Start the short axis, press Escape before releasing, then release.
    ev('pointerdown', 200, 170, 0)
    ev('pointermove', 200, 230, -1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    // A move before release must not turn into a camera drag.
    const view = [nv.azimuth, nv.elevation]
    ev('pointermove', 240, 260, -1)
    const dragging = nv.isDragging
    const turned = nv.azimuth !== view[0] || nv.elevation !== view[1]
    ev('pointerup', 240, 260, 0)
    return {
      count: nv.annotations.length,
      long: nv._bidirectionalLong,
      shapeStart: nv._annotationShapeStart,
      dragging,
      turned,
    }
  })()`)
  expect(r).toEqual({
    count: 0,
    long: null,
    shapeStart: null,
    dragging: false,
    turned: false,
  })
})

for (const [name, call] of [
  ['loadVolumes', `await nv.loadVolumes([{ url: synth() }])`],
  ['removeAllVolumes', 'await nv.removeAllVolumes()'],
  ['removeVolume(0)', 'await nv.removeVolume(0)'],
  ['loadAnnotationsJSON', `nv.loadAnnotationsJSON('[]')`],
] as const) {
  test(`${name} drops a half-drawn measurement (#470)`, async ({ page }) => {
    test.setTimeout(90_000)
    const r = await page.evaluate(`(async () => {
      ${setup('AXIAL', 'bidirectional')}
      drag([150, 200], [250, 200])
      const before = nv._bidirectionalLong !== null
      ${call}
      return { before, after: nv._bidirectionalLong }
    })()`)
    expect(r).toEqual({ before: true, after: null })
  })
}

test('a volume move that changes the background drops a half-drawn measurement (#470)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'bidirectional')}
    await nv.loadVolumes([
      { url: synth() },
      { url: ${OBLIQUE} },
    ])
    drag([150, 200], [250, 200])
    const before = nv._bidirectionalLong !== null
    await nv.moveVolumeToBottom(1)
    return { before, after: nv._bidirectionalLong }
  })()`)
  expect(r).toEqual({ before: true, after: null })
})

test('a freehand stroke held across loadVolumes does not commit (#470)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const count = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'freehand')}
    nv.annotationBrushRadius = 3
    ev('pointerdown', 150, 150, 0)
    ev('pointermove', 200, 160, -1)
    ev('pointermove', 250, 200, -1)
    await nv.loadVolumes([{ url: synth() }])
    // The drag ended with it: a move before release does not turn the camera.
    const view = [nv.azimuth, nv.elevation]
    ev('pointermove', 260, 220, -1)
    const turned = nv.azimuth !== view[0] || nv.elevation !== view[1]
    const dragging = nv.isDragging
    ev('pointerup', 260, 220, 0)
    return { count: nv.annotations.length, turned, dragging }
  })()`)
  expect(count).toEqual({ count: 0, turned: false, dragging: false })
})

test('an abandoned resize keeps the erased part of a shape erased (#470)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'measureRect')}
    drag([120, 120], [200, 200])
    // Erase a vertical stripe, splitting the rectangle in two.
    nv.annotationIsErasing = true
    nv.annotationBrushRadius = 3
    ev('pointerdown', 160, 100, 0)
    ev('pointermove', 160, 160, -1)
    ev('pointermove', 160, 220, -1)
    ev('pointerup', 160, 220, 0)
    nv.annotationIsErasing = false
    const ann = nv.annotations[0]
    const erased = JSON.stringify(ann.polygons)
    const split = ann.polygons.length === 2
    click([140, 160]) // select the left half
    ev('pointerdown', 200, 200, 0) // the shape's bottom-right corner
    const resizing = nv._resizingControlPoint >= 0
    await nv.loadVolumes([{ url: synth() }])
    ev('pointerup', 200, 200, 0)
    return { split, resizing, kept: JSON.stringify(nv.annotations[0].polygons) === erased }
  })()`)
  expect(r).toEqual({ split: true, resizing: true, kept: true })
})

test('a completed resize keeps the erased part of a shape erased (#470)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'measureRect')}
    drag([120, 120], [200, 200])
    nv.annotationIsErasing = true
    nv.annotationBrushRadius = 3
    ev('pointerdown', 160, 100, 0)
    ev('pointermove', 160, 160, -1)
    ev('pointermove', 160, 220, -1)
    ev('pointerup', 160, 220, 0)
    nv.annotationIsErasing = false
    const stats = JSON.stringify(nv.annotations[0].stats)
    click([140, 160]) // select the left half
    ev('pointerdown', 200, 200, 0)
    ev('pointermove', 240, 240, -1)
    ev('pointerup', 240, 240, 0)
    const ann = nv.annotations[0]
    const xs = ann.polygons.flatMap((p) => p.outer.map((q) => q.x))
    const maxX = Math.max(ann.shape.start.x, ann.shape.end.x)
    return {
      split: ann.polygons.length === 2,
      fitsBounds: Math.abs(Math.max(...xs) - maxX) < 1e-6,
      remeasured: JSON.stringify(ann.stats) !== stats,
    }
  })()`)
  expect(r).toEqual({ split: true, fitsBounds: true, remeasured: true })
})

test('collapsing an erased shape and expanding it again keeps the erasure (#470)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'measureRect')}
    drag([120, 120], [200, 200])
    nv.annotationIsErasing = true
    nv.annotationBrushRadius = 3
    ev('pointerdown', 160, 100, 0)
    ev('pointermove', 160, 160, -1)
    ev('pointermove', 160, 220, -1)
    ev('pointerup', 160, 220, 0)
    nv.annotationIsErasing = false
    click([140, 160]) // select the left half
    // Right side handle onto the left edge: the collapse is refused, so the
    // shape keeps its last valid width (here, half as wide).
    ev('pointerdown', 200, 160, 0)
    ev('pointermove', 160, 160, -1)
    ev('pointermove', 120, 160, -1)
    ev('pointerup', 120, 160, 0)
    const shape = nv.annotations[0].shape
    const kept = Math.abs(shape.end.x - shape.start.x) > 0
    // And back out to the full width.
    ev('pointerdown', 160, 160, 0)
    ev('pointermove', 200, 160, -1)
    ev('pointerup', 200, 160, 0)
    return { kept, split: nv.annotations[0].polygons.length === 2 }
  })()`)
  expect(r).toEqual({ kept: true, split: true })
})

test('loadVolumes ends a control-point resize drag (#470)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup('AXIAL', 'rectangle')}
    drag([120, 120], [200, 200])
    click([160, 160]) // select it, so its corners are control points
    const geometry = () => JSON.stringify([nv.annotations[0].shape, nv.annotations[0].polygons])
    const original = geometry()
    ev('pointerdown', 200, 200, 0)
    ev('pointermove', 220, 220, -1)
    const resizing = nv._resizingControlPoint >= 0 && geometry() !== original
    await nv.loadVolumes([{ url: synth() }])
    const ended = nv._resizingControlPoint === -1 && !nv.isDragging
    // The half-done resize is undone, so the shape matches its stats.
    const reverted = geometry() === original
    // A move after the load must not keep resizing the shape.
    ev('pointermove', 250, 250, -1)
    ev('pointerup', 250, 250, 0)
    const unchanged = geometry() === original
    return { resizing, ended, reverted, unchanged }
  })()`)
  expect(r).toEqual({
    resizing: true,
    ended: true,
    reverted: true,
    unchanged: true,
  })
})
