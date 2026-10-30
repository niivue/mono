import { expect, test } from '@playwright/test'

// A half-drawn annotation (bidirectional long axis, multi-click contour) must
// stay on its own slice and scene: #111 (slice change), #112 (re-selecting the
// same tool), #113 (loadDocument), #114 (double-click on the 3D render tile).

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const setup = (
  sliceType: string,
  tool: string,
  volume = '/volumes/mni152.nii.gz',
  width = 400,
) => `
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.style.cssText = 'position:fixed;left:0;top:0;width:${width}px;height:400px'
  document.body.appendChild(c)
  const nv = new NiiVue({
    backend: 'webgl2',
    devicePixelRatio: 1,
    sliceType: SLICE_TYPE.${sliceType},
  })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([{ url: '${volume}' }])
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
    ${setup('AXIAL', 'bidirectional', '/volumes/fs/T1_oblique.nii.gz')}
    // The axial plane is tilted in mm, so the two drags differ in mm z.
    drag([150, 200], [250, 200])
    drag([200, 120], [200, 280])
    return nv.annotations.length
  })()`)
  expect(count).toBe(1)
})

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
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterRender = {
      count: nv.annotations.length,
      points: nv._annotationPolyPoints?.length ?? 0,
      crosshairMoved: nv.crosshairPos.some((v, i) => v !== crosshair[i]),
    }
    // The same double-click on the axial tile closes it.
    click([ax + 3, ay + 3])
    ev('dblclick', ax + 3, ay + 3, 0, MouseEvent)
    await new Promise((resolve) => setTimeout(resolve, 100))
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
    await new Promise((resolve) => setTimeout(resolve, 300))
    const zoomed = nv.model.signalViewWindow !== null
    const [ax, ay] = tileCentre((t) => !t.isRender)
    click([ax, ay])
    click([ax + 6, ay])
    click([ax + 3, ay + 6])
    const b = nv.view.graphLayout.controls.find((k) => k.id === 'zoomOut')
    ev('dblclick', b.x + b.w / 2, b.y + b.h / 2, 0, MouseEvent)
    await new Promise((resolve) => setTimeout(resolve, 100))
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
  ['/volumes/mni152.nii.gz', false],
  ['/volumes/fs/T1_oblique.nii.gz', true],
] as const) {
  test(`annotations still draw on exploded blocks (${volume})`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const kinds = await page.evaluate(`(async () => {
      ${setup('MULTIPLANAR', 'bidirectional', volume)}
      await nv.setVolumeChunkGrid(0, [2, 2, 2])
      await nv.setVolumeChunkExplode(0, { enabled: true, scale: [1.5, 1.5, 1.5] })
      await new Promise((resolve) => setTimeout(resolve, 300))
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
      await new Promise((resolve) => setTimeout(resolve, 100))
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
    // Oblique: the spline is #469 and the 3D stroke skips oblique volumes.
    expect(kinds).toEqual(
      oblique ? ['bidirectional'] : ['bidirectional', 'spline', 'freehand'],
    )
  })
}
