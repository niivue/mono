import { expect, test } from 'bun:test'
import type { mat4 } from 'gl-matrix'
import NiiVue from '@/index'
import { vox2mm } from '@/math/NVTransforms'
import { PEN_SHAPE } from '@/NVConstants'
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
