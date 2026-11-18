import { expect, it } from 'bun:test'
import NiiVue from '@niivue/niivue'
import { segmentLabel } from './segmentLabel'
import { panelColormap } from './segPanel'

it('hover label: drawing value -> its panel segment label', () => {
  const rows = [
    { value: 2, label: 'Liver', color: [255, 0, 0, 255], visible: true },
    { value: 5, label: 'Spleen', color: [0, 255, 0, 255], visible: true },
  ] as const
  const nv = new NiiVue({ backend: 'webgl2' })
  const name = nv.addColormap('seg-label-test', panelColormap(rows as never))
  expect([2, 5, 3, 0].map((v) => segmentLabel(name, v))).toEqual([
    'Liver',
    'Spleen',
    undefined,
    undefined,
  ])
})
