import { expect, test } from '@playwright/test'

// A freehand 3D vector stroke (drawn on exploded blocks) lives only in the
// `_annotation3DMMPath` accumulator until it is committed. `pointerup` commits it
// via `finish3DAnnotationStroke`; `pointercancel` used to fall straight through to
// `resetDragState`, silently discarding a finished polygon whenever touch/pen input
// ended in a cancel (palm rejection, browser gesture, capture loss). It now commits
// on cancel too — matching the raster pen, whose voxels are painted incrementally
// and therefore already survive a cancel.
//
// These tests seed the accumulator directly rather than reproducing the exploded-
// block pick (which needs a tiled chunkPlan): the behavior under test is the
// pointercancel handler and the degeneracy guard, not the picking.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// No volume is loaded: nothing on this path reads voxels, and skipping the fetch
// keeps the spec independent of the Git-LFS sample volumes.
const setup = `
  const { default: NiiVue } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = 400; c.height = 400
  c.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:400px'
  document.body.appendChild(c)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(c)
  nv.annotationIsEnabled = true

  c.setPointerCapture = () => {}
  c.releasePointerCapture = () => {}
  const cancel = () => c.dispatchEvent(new PointerEvent('pointercancel', {
    pointerId: 1, bubbles: true, cancelable: true, pointerType: 'mouse',
  }))
  const release = () => c.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, bubbles: true, cancelable: true, pointerType: 'mouse',
    clientX: 200, clientY: 200, button: 0,
  }))
  // Stand in for the exploded-block pick that normally fills these.
  const beginStroke = (pts) => {
    nv._annotation3DActive = true
    nv._annotation3DMMPath = pts
  }
`

test('pointercancel commits an in-progress 3D vector stroke', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    let added = 0
    nv.addEventListener('annotationAdded', () => { added++ })

    // A square in the z = 0 plane: two large extents, so it has area.
    beginStroke([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]])
    cancel()

    return {
      added,
      count: nv.annotations.length,
      sliceType: nv.annotations[0]?.sliceType ?? null,
      hasPolygons: (nv.annotations[0]?.polygons?.length ?? 0) > 0,
      // The cancel still cleared every piece of transient drag state.
      active: nv._annotation3DActive,
      path: nv._annotation3DMMPath.length,
      isDragging: nv.isDragging,
    }
  })()`)

  expect(r.added).toBe(1)
  expect(r.count).toBe(1)
  expect(r.hasPolygons).toBe(true)
  // Smallest extent is z, so the stroke lands on an axial slice (SLICE_TYPE.AXIAL).
  expect(r.sliceType).toBe(0)
  expect(r.active).toBe(false)
  expect(r.path).toBe(0)
  expect(r.isDragging).toBe(false)
})

test('pointerup commits an in-progress 3D vector stroke', async ({ page }) => {
  test.setTimeout(90_000)

  // The commit-on-pointerup path had no coverage: deleting its
  // `finish3DAnnotationStroke` call broke no test. This pins it alongside the
  // cancel path so the two cannot silently diverge.
  const r = await page.evaluate(`(async () => {
    ${setup}
    beginStroke([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]])
    release()
    return {
      count: nv.annotations.length,
      active: nv._annotation3DActive,
      isDragging: nv.isDragging,
    }
  })()`)

  expect(r.count).toBe(1)
  expect(r.active).toBe(false)
  expect(r.isDragging).toBe(false)
})

test('a collinear 3D stroke is discarded rather than committed as a zero-area shape', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    // Every point on one line: one large extent, two zero. Only the all-three-tiny
    // case used to be rejected, so this committed an invisible polygon plus an
    // undo entry.
    beginStroke([[0, 0, 0], [5, 0, 0], [10, 0, 0]])
    cancel()
    const afterLine = nv.annotations.length

    // A single repeated point (all three extents tiny) is rejected as before.
    beginStroke([[3, 3, 3], [3, 3, 3], [3, 3, 3]])
    cancel()

    // undo() returns null on an empty stack without mutating it.
    const noUndoStep = nv._annotationUndoStack.undo(nv.annotations) === null
    return { afterLine, afterPoint: nv.annotations.length, noUndoStep }
  })()`)

  expect(r.afterLine).toBe(0)
  expect(r.afterPoint).toBe(0)
  // Neither degenerate stroke pushed an undo step.
  expect(r.noUndoStep).toBe(true)
})
