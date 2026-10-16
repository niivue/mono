import { describe, expect, mock, test } from 'bun:test'
import type NiiVueGPU from '@/NVControlBase'
import type { NVInstance } from '@/NVTypes'
import { applyInstances } from './instances'

/**
 * The real `setInstances` body run on a stand-in controller: just the options it
 * reads and writes, a view, and mocks for the rebuild, the tiling and the
 * draw, so the test sees which of them a call reaches.
 */
function fakeCtrl(instances?: NVInstance[]) {
  const order: string[] = []
  const ctrl = {
    opts: { instances },
    view: {},
    updateGLVolume: mock(async () => {
      order.push('rebuild')
    }),
    updateTilesFromInstances: mock(() => {
      order.push('tile')
    }),
    drawScene: mock(() => {
      order.push('draw')
    }),
  }
  const setInstances = (list: NVInstance[] | null) =>
    applyInstances(ctrl as unknown as NiiVueGPU, list)
  return { ctrl, order, setInstances }
}

const sphere: NVInstance[] = [
  { id: 'a', space: 'global3d', position: [1, 0, 0] },
  { id: 'b', space: 'global3d', position: [-1, 0, 0] },
]

describe('setInstances', () => {
  test('entering instance mode rebuilds the GPU resources before tiling', async () => {
    const { ctrl, order, setInstances } = fakeCtrl()
    await setInstances(sphere)
    expect(ctrl.opts.instances).toBe(sphere)
    expect(order).toEqual(['rebuild', 'tile', 'draw'])
  })

  test('replacing instances in instance mode only re-tiles', async () => {
    const { order, setInstances } = fakeCtrl(sphere)
    await setInstances([{ id: 'c', space: 'global3d' }])
    expect(order).toEqual(['tile', 'draw'])
  })

  test('null leaves instance mode and rebuilds', async () => {
    const { ctrl, order, setInstances } = fakeCtrl(sphere)
    await setInstances(null)
    expect(ctrl.opts.instances).toBeUndefined()
    expect(order).toEqual(['rebuild', 'tile', 'draw'])
  })

  test('an empty list stays in instance mode and draws no tiles', async () => {
    const { ctrl, order, setInstances } = fakeCtrl(sphere)
    await setInstances([])
    expect(ctrl.opts.instances).toEqual([])
    expect(order).toEqual(['tile', 'draw'])
  })

  test('clearing when no instances are set changes nothing on the GPU', async () => {
    const { order, setInstances } = fakeCtrl()
    await setInstances(null)
    expect(order).toEqual(['tile', 'draw'])
  })

  test('before a view is attached, only the options change', async () => {
    const { ctrl, order, setInstances } = fakeCtrl()
    ;(ctrl as { view: unknown }).view = undefined
    await setInstances(sphere)
    expect(ctrl.opts.instances).toBe(sphere)
    expect(order).toEqual([])
  })
})
