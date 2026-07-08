import { expect, test } from '@playwright/test'

// Regression coverage for the pointerup `finally` in `control/interactions.ts`.
// A stroke finalize can throw (a lost GPU device is the realistic cause). When it
// does, the handler must still: release pointer capture, clear `isDragging` (the
// chunked-volume streaming pump is gated on it), and clear the accumulated stroke
// so the NEXT pointerup does not re-commit a stroke the user never drew.
//
// This needs a real instance + a real canvas hit-test, so it lives in the e2e
// tier: the Bun unit runner cannot import NiiVue's `import.meta.glob` graph.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// Attach a visible instance with an open drawing, then drag a pen stroke on the
// axial slice WITHOUT releasing. Leaves the pointer mid-drag.
const setupMidStroke = `
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = 300; c.height = 300
  c.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:300px'
  document.body.appendChild(c)

  const nv = new NiiVue({ backend: 'webgl2', sliceType: SLICE_TYPE.AXIAL })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
  nv.createEmptyDrawing()
  nv.drawIsEnabled = true
  nv.drawPenValue = 1

  // Record capture release; jsdom-free real canvas still needs the stub because
  // synthesized PointerEvents have no real capture target.
  let released = false
  c.setPointerCapture = () => {}
  c.releasePointerCapture = () => { released = true }

  let drawingChanged = 0
  nv.addEventListener('drawingChanged', () => { drawingChanged++ })

  const r = c.getBoundingClientRect()
  const ev = (type, x, y, button) => c.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, bubbles: true, cancelable: true,
    clientX: r.left + x, clientY: r.top + y,
    button, buttons: 1, pointerType: 'mouse',
  }))

  // Paint a short stroke across the middle of the slice, pointer still down.
  ev('pointerdown', 140, 140, 0)
  ev('pointermove', 150, 150, -1)
  ev('pointermove', 160, 160, -1)
`

test('a throwing stroke finalize does not replay the stroke on the next pointerup', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setupMidStroke}

    const pendingPts = nv._drawPenFillPts.length
    // Make the finalize throw, the way a lost GPU device would.
    nv.refreshDrawing = () => { throw new Error('simulated device loss') }
    try { ev('pointerup', 160, 160, 0) } catch { /* listener errors don't propagate */ }

    const afterThrow = {
      isDragging: nv.isDragging,
      penPts: nv._drawPenFillPts.length,
      penAxCorSag: nv._drawPenAxCorSag,
      released,
      drawingChanged,
    }

    // A bare pointerup that starts no drag must NOT commit anything.
    drawingChanged = 0
    ev('pointerup', 200, 200, 0)

    return { pendingPts, afterThrow, replayedChanges: drawingChanged }
  })()`)

  // Sanity: the drag really did accumulate a stroke before the throw.
  expect(r.pendingPts).toBeGreaterThan(0)

  // Cleanup ran despite the throw.
  expect(r.afterThrow.isDragging).toBe(false)
  expect(r.afterThrow.released).toBe(true)
  // The stroke was discarded, not left pending.
  expect(r.afterThrow.penPts).toBe(0)
  expect(r.afterThrow.penAxCorSag).toBe(-1)
  // The throwing finalize never announced a change.
  expect(r.afterThrow.drawingChanged).toBe(0)
  // And the next pointerup did not re-commit the abandoned stroke.
  expect(r.replayedChanges).toBe(0)
})

test('pointer capture is released even when the reset itself renders and throws', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setupMidStroke}

    // `+'`resetDragState`'+` ends by clearing isDragging, whose setter calls drawScene().
    // If the renderer throws there, capture must already have been released.
    nv.drawScene = () => { throw new Error('simulated render failure') }
    try { ev('pointerup', 160, 160, 0) } catch { /* listener errors don't propagate */ }

    return { released, isDragging: nv.isDragging }
  })()`)

  expect(r.released).toBe(true)
  // The isDragging write lands before its setter's drawScene() throws.
  expect(r.isDragging).toBe(false)
})

test('pointercancel clears the stroke so an interrupted drag cannot resurface', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setupMidStroke}

    const pendingPts = nv._drawPenFillPts.length
    c.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 1, bubbles: true, cancelable: true, pointerType: 'mouse',
    }))
    const afterCancel = {
      isDragging: nv.isDragging,
      penPts: nv._drawPenFillPts.length,
      released,
    }

    drawingChanged = 0
    ev('pointerup', 200, 200, 0)
    return { pendingPts, afterCancel, replayedChanges: drawingChanged }
  })()`)

  expect(r.pendingPts).toBeGreaterThan(0)
  expect(r.afterCancel.isDragging).toBe(false)
  expect(r.afterCancel.released).toBe(true)
  expect(r.afterCancel.penPts).toBe(0)
  expect(r.replayedChanges).toBe(0)
})
