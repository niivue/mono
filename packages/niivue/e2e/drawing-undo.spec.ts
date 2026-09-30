import { expect, test } from '@playwright/test'

// An edit made through the extension context (`ctx.drawing.update`) used to be
// invisible to Undo: nothing public could push a snapshot. `pushUndo()` /
// `drawAddUndoBitmap()` close that gap. Needs a real instance (drawing volume,
// GPU refresh), so this is an e2e test rather than a Bun unit test.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('pushUndo before ctx.drawing.update makes the edit undoable', async ({
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
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
    const ctx = nv.createExtensionContext()
    ctx.createEmptyDrawing()
    const dr = ctx.drawing
    if (!dr) throw new Error('no drawing')
    const painted = () => {
      let n = 0
      for (const v of dr.bitmap) if (v) n++
      return n
    }
    const valueAt1000 = () => dr.bitmap[1000]
    const stamp = (value: number) => {
      const b = new Uint8Array(dr.bitmap) // copy of the current bitmap
      for (let i = 1000; i < 1100; i++) b[i] = value
      return b
    }

    // (a) An update with no snapshot: Undo has nothing to restore.
    dr.update(stamp(1))
    const afterFirstEdit = painted()
    nv.drawUndo()
    const afterUndoWithoutPush = painted()

    // (b) pushUndo, then update: Undo restores the pushed bitmap (100 voxels).
    dr.pushUndo()
    dr.update(stamp(2))
    const afterSecondEdit = valueAt1000()
    nv.drawUndo()
    const afterUndoWithPush = valueAt1000()

    // Undo restores INTO the existing array: an extension that installed a
    // SharedArrayBuffer view (MagicWandShared's preview) must still be looking
    // at the live drawing afterwards.
    dr.pushUndo()
    dr.update(stamp(3))
    const imgBeforeUndo = nv.drawingVolume?.img
    nv.drawUndo()
    const sameArrayAfterUndo = nv.drawingVolume?.img === imgBeforeUndo

    // (c) The controller method is the same thing, usable without a context.
    nv.drawAddUndoBitmap()
    dr.update(new Uint8Array(dr.bitmap.length)) // clear everything
    const afterClear = painted()
    nv.drawUndo()
    const afterUndoClear = painted()

    return {
      afterFirstEdit,
      afterUndoWithoutPush,
      afterSecondEdit,
      afterUndoWithPush,
      sameArrayAfterUndo,
      afterClear,
      afterUndoClear,
      noDrawingIsNoop: (() => {
        nv.closeDrawing()
        nv.drawAddUndoBitmap()
        return nv.drawUndoBitmaps.length === 0
      })(),
    }
  })

  expect(r.afterFirstEdit).toBe(100)
  expect(r.afterUndoWithoutPush).toBe(100) // nothing on the stack -> edit stays
  expect(r.afterSecondEdit).toBe(2) // the edit wrote value 2 ...
  expect(r.afterUndoWithPush).toBe(1) // ... and Undo restored the pushed value-1 bitmap
  expect(r.sameArrayAfterUndo).toBe(true) // the shared-buffer case
  expect(r.afterClear).toBe(0)
  expect(r.afterUndoClear).toBe(100) // the clear was undoable too
  expect(r.noDrawingIsNoop).toBe(true)
})
