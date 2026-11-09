import { expect, test } from 'bun:test'
import NiiVue from '@/NVControlBase'

test('a floor whose upload fails is not recorded', async () => {
  const nv = new NiiVue({}, {} as never)
  nv.drawScene = () => {}
  const a = { id: 'a' } as never
  nv.view = { setCoarseFloor: async () => {} } as never
  await nv.setBaseCoarseFloor(a)
  expect(nv._baseCoarseFloor).toBe(a)
  expect(nv._baseCoarseFloorSets).toBe(1)
  // A failed upload leaves the old floor drawn, so the record must not move.
  nv.view = {
    setCoarseFloor: async () => {
      throw new Error('upload failed')
    },
  } as never
  await expect(nv.setBaseCoarseFloor({ id: 'b' } as never)).rejects.toThrow(
    'upload failed',
  )
  expect(nv._baseCoarseFloor).toBe(a)
  expect(nv._baseCoarseFloorSets).toBe(1)
})
