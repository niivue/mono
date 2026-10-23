import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import type { Demo } from './types'

const demo: Demo = async (canvas, { ui, asset }) => {
  const nv = new NiiVue({ backgroundColor: [0, 0, 0, 1] })
  await nv.attachToCanvas(canvas)
  await nv.loadMeshes([
    {
      url: asset('meshes/BrainMesh_ICBM152.lh.mz3'),
      shaderType: 'matte',
      layers: [
        {
          url: asset('meshes/BrainMesh_ICBM152.lh.curv'),
          colormap: 'gray',
          calMin: 0.3,
          calMax: 0.5,
          opacity: 1,
          isColorbarVisible: false,
        },
        {
          url: asset('meshes/BrainMesh_ICBM152.lh.motor.mz3'),
          colormap: 'warm',
          calMin: 1.5,
          calMax: 5,
          opacity: 0.7,
        },
      ],
    },
  ])
  nv.sliceType = SLICE_TYPE.RENDER
  nv.isColorbarVisible = true

  ui.slider(
    'Threshold',
    0,
    4,
    1.5,
    (v) => {
      nv.setMeshLayerProperty(0, 1, { calMin: v, calMax: v + 3.5 })
    },
    0.1,
  )
  ui.slider(
    'Layer opacity',
    0,
    1,
    0.7,
    (v) => {
      nv.setMeshLayerProperty(0, 1, { opacity: v })
    },
    0.05,
  )
  ui.select('Shader', nv.meshShaders, 'matte', (shaderType) => {
    nv.setMesh(0, { shaderType })
  })
  return nv
}

export default demo
