import { expect, test } from 'bun:test'
import type { mat4 } from 'gl-matrix'
import NiiVue from '@/index'
import { vox2mm } from '@/math/NVTransforms'
import { PEN_SHAPE } from '@/NVConstants'
import type { DrawingChangedDetail } from '@/NVEvents'
import { devImageUrl } from '@/testing/headless'

test('drawShapeFill: one undo step per fill', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: devImageUrl('volumes/hippo.nii.gz') }])
  nv.createEmptyDrawing()
  const vol = nv.volumes[0]
  const d = vol.dimsRAS as number[]
  const [x, y, z] = vox2mm(
    null,
    [d[1] >> 1, d[2] >> 1, d[3] >> 1],
    vol.matRAS as mat4,
  )
  const bmp = () => nv.drawingVolume?.img as Uint8Array
  expect(nv.drawShapeFill(PEN_SHAPE.SPHERE, [x, y, z], [x, y, z + 3])).toBe(
    true,
  )
  const afterSphere = bmp().slice()
  expect(afterSphere.some((v) => v)).toBe(true)
  nv.drawShapeFill(PEN_SHAPE.RECTANGLE, [x - 9, y - 9, z], [x + 9, y + 9, z])
  expect(bmp()).not.toEqual(afterSphere)
  nv.drawUndo()
  expect(bmp()).toEqual(afterSphere)
})

test('drawShapeFill: drawingChanged reports a box holding every painted voxel', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: devImageUrl('volumes/hippo.nii.gz') }])
  nv.createEmptyDrawing()
  const vol = nv.volumes[0]
  const d = vol.dimsRAS as number[]
  const [x, y, z] = vox2mm(
    null,
    [d[1] >> 1, d[2] >> 1, d[3] >> 1],
    vol.matRAS as mat4,
  )
  const details: DrawingChangedDetail[] = []
  nv.addEventListener('drawingChanged', (e) => details.push(e.detail))
  nv.drawShapeFill(PEN_SHAPE.SPHERE, [x, y, z], [x, y, z + 3])
  const box = details[0].box
  if (!box) throw new Error('no box')
  const bmp = nv.drawingVolume?.img as Uint8Array
  let painted = 0
  for (let i = 0; i < bmp.length; i++) {
    if (!bmp[i]) continue
    painted++
    const p = [
      i % d[1],
      Math.floor(i / d[1]) % d[2],
      Math.floor(i / (d[1] * d[2])),
    ]
    for (let a = 0; a < 3; a++) {
      expect(p[a]).toBeGreaterThanOrEqual(box.min[a])
      expect(p[a]).toBeLessThanOrEqual(box.max[a])
    }
  }
  expect(painted).toBeGreaterThan(0)
  // Undo restores the whole bitmap, so it reports no box.
  nv.drawUndo()
  expect(details[1]).toEqual({ action: 'undo' })
})

test('markDrawDirty: an off-volume point grows the box from its clamped voxel', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: devImageUrl('volumes/hippo.nii.gz') }])
  nv.createEmptyDrawing()
  const details: DrawingChangedDetail[] = []
  nv.addEventListener('drawingChanged', (e) => details.push(e.detail))
  // The pen clamps x=-2 to 0 and a radius-1 pen there paints x 0..1.
  nv.markDrawDirty(-2, 3, 3, 1)
  nv._emitDrawingChanged('update', true)
  expect(details[0].box?.min[0]).toBe(0)
  expect(details[0].box?.max[0]).toBe(1)
})
