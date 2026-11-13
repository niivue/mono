import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue()
  await nv.attachToCanvas(canvas)
  nv.sliceType = SLICE_TYPE.RENDER
  // A TRX file carrying a per-vertex scalar (dpv/z, each vertex's height)
  // and a per-streamline one (dps/DataSetID, which of six source datasets).
  await nv.loadMeshes([
    {
      url: asset('meshes/dpsv.trx'),
      color: [0, 0.8, 1, 1], // used when colorBy is 'fixed'
      tractOptions: { fiberRadius: 0.5, colormap: 'plasma' },
    },
  ])

  ui.select(
    'Color',
    [
      ['Local direction', ''],
      ['Global direction', 'global'],
      ['Fixed', 'fixed'],
      ['Per-vertex scalar', 'dpv:z'],
      ['Per-streamline scalar', 'dps:DataSetID'],
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
