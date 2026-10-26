import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({ backgroundColor: [0, 0, 0, 1] })
  await nv.attachToCanvas(canvas)
  nv.sliceType = SLICE_TYPE.RENDER
  // A TCK file with a per-vertex (.tsf) and a per-streamline (.txt) scalar.
  // Each scalar is named after its file, without the extension.
  await nv.loadMeshes([
    {
      url: asset('meshes/tract.SLF1_R.tck'),
      layers: [
        { url: asset('meshes/mni152.SLF1_R.tsf') },
        { url: asset('meshes/mni152.SLF1_R.txt') },
      ],
      color: [0, 0.8, 1, 1], // used when colorBy is 'fixed'
      tractOptions: { fiberRadius: 0.5, colormap: 'inferno' },
    },
  ])

  ui.select(
    'Color',
    [
      ['Local direction', ''],
      ['Global direction', 'global'],
      ['Fixed', 'fixed'],
      ['Per-vertex scalar', 'dpv:mni152.SLF1_R'],
      ['Per-streamline scalar', 'dps:mni152.SLF1_R'],
    ],
    '',
    (colorBy) => {
      nv.setTractOptions(0, { colorBy })
    },
  )
  ui.slider(
    'Radius',
    0.1,
    1.5,
    0.5,
    (fiberRadius) => {
      nv.setTractOptions(0, { fiberRadius })
    },
    0.1,
  )
  ui.slider('Show every Nth', 1, 10, 1, (decimation) => {
    nv.setTractOptions(0, { decimation })
  })
  return nv
}

export default demo
