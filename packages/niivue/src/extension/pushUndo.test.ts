import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { devImageUrl } from '@/testing/headless'

// An edit made through the extension context (`ctx.drawing.update`) used to be
// invisible to Undo: nothing public could push a snapshot. `pushUndo()` /
// `drawAddUndoBitmap()` close that gap.

test('pushUndo before ctx.drawing.update makes the edit undoable', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: devImageUrl('volumes/hippo.nii.gz') }])
  const ctx = nv.createExtensionContext()
  ctx.createEmptyDrawing()
  const dr = ctx.drawing
  if (!dr) throw new Error('no drawing')
  const painted = () => dr.bitmap.reduce((n, v) => (v ? n + 1 : n), 0)
  const stamp = (value: number) => {
    const b = new Uint8Array(dr.bitmap) // copy of the current bitmap
    for (let i = 1000; i < 1100; i++) b[i] = value
    return b
  }

  // (a) An update with no snapshot: Undo has nothing to restore.
  dr.update(stamp(1))
  expect(painted()).toBe(100)
  nv.drawUndo()
  expect(painted()).toBe(100) // nothing on the stack -> edit stays

  // (b) pushUndo, then update: Undo restores the pushed bitmap.
  dr.pushUndo()
  dr.update(stamp(2))
  expect(dr.bitmap[1000]).toBe(2) // the edit wrote value 2 ...
  nv.drawUndo()
  expect(dr.bitmap[1000]).toBe(1) // ... and Undo restored the value-1 bitmap

  // Undo restores INTO the existing array: an extension that installed a
  // SharedArrayBuffer view (MagicWandShared's preview) must still be looking
  // at the live drawing afterwards.
  dr.pushUndo()
  dr.update(stamp(3))
  const imgBeforeUndo = nv.drawingVolume?.img
  nv.drawUndo()
  expect(nv.drawingVolume?.img).toBe(imgBeforeUndo)

  // (c) The controller method is the same thing, usable without a context.
  nv.drawAddUndoBitmap()
  dr.update(new Uint8Array(dr.bitmap.length)) // clear everything
  expect(painted()).toBe(0)
  nv.drawUndo()
  expect(painted()).toBe(100) // the clear was undoable too

  // With no drawing open it is a no-op.
  nv.closeDrawing()
  nv.drawAddUndoBitmap()
  expect(nv.drawUndoBitmaps).toHaveLength(0)
})
