import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { addColormap } from '@/cmap/NVCmaps'
import { log } from '@/logger'
import { createMesh } from '@/mesh/NVMesh'
import { defaultTractOptions, tessellate } from '@/mesh/tracts/index'
import type { NVMeshLayer, NVTractData } from '@/NVTypes'
import { packBoxEdges } from '@/view/NVBoxEdges'
import NiiVue from './index'

// Two streamlines; group A = [0], group B = [1]
const tract = (): NVTractData => ({
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]),
  offsets: new Uint32Array([0, 2, 4]),
  dpv: {},
  dps: {},
  groups: { A: new Uint32Array([0]), B: new Uint32Array([1]) },
  dpvMeta: {},
  dpsMeta: {},
})

function withTract(): NiiVue {
  const nv = new NiiVue()
  const trx = tract()
  const tractOptions = { ...defaultTractOptions }
  const { positions, indices, colors } = tessellate(trx, tractOptions)
  nv.model.getMeshes().push(
    createMesh(positions, indices, colors, {
      kind: 'tract',
      trx,
      tractOptions,
    }),
  )
  return nv
}

let warn: ReturnType<typeof spyOn> | null = null
afterEach(() => warn?.mockRestore())

describe('setTractOptions input guards', () => {
  test('a prototype name is an unknown group', async () => {
    const nv = withTract()
    warn = spyOn(log, 'warn').mockImplementation(() => {})
    await nv.setTractOptions(0, { visibleGroups: ['A', 'constructor'] })
    expect(warn).toHaveBeenCalledWith(
      'setTractOptions: unknown tract groups constructor',
    )
  })

  test('a string visibleGroups warns and is ignored', async () => {
    const nv = withTract()
    warn = spyOn(log, 'warn').mockImplementation(() => {})
    const options = { visibleGroups: 'A' as unknown as string[] }
    await nv.setTractOptions(0, options)
    expect(warn).toHaveBeenCalledWith(
      'setTractOptions: visibleGroups must be an array of names',
    )
    expect(nv.model.getMeshes()[0].tractOptions?.visibleGroups).not.toBe('A')
  })

  test('a null visibleGroups shows every group again', async () => {
    const nv = withTract()
    warn = spyOn(log, 'warn').mockImplementation(() => {})
    await nv.setTractOptions(0, { visibleGroups: ['A'] })
    await nv.setTractOptions(0, { visibleGroups: null })
    expect(nv.model.getMeshes()[0].tractOptions?.visibleGroups).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('addColormap input guards', () => {
  test('a label table refuses fractional IDs', () => {
    const fractional = () =>
      addColormap('guardFrac', {
        R: [0, 255],
        G: [0, 0],
        B: [0, 0],
        I: [0, 0.5],
        labels: ['a', 'b'],
      })
    expect(fractional).toThrow('label IDs in I must be integers')
  })

  test('a mesh layer with no colormap does not stop a label registration', () => {
    const nv = withTract()
    const layer = { colormap: undefined } as unknown as NVMeshLayer
    nv.model.getMeshes()[0].layers = [layer]
    expect(() =>
      nv.addColormap('guardLabels', {
        R: [0, 255],
        G: [0, 0],
        B: [0, 0],
        labels: ['air', 'a'],
      }),
    ).not.toThrow()
  })
})

test('an undefined focus box draws nothing instead of throwing', () => {
  const md = { _focusBox: undefined, _lodBoxes: null, _pickedBlockBox: null }
  expect(packBoxEdges(md as never)).toBeNull()
})
