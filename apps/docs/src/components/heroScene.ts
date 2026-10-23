import NiiVue, { SLICE_TYPE } from '@niivue/niivue'

// Loaded with import() from HeroViewer, like the guide demos, so the server
// build never resolves @niivue/niivue (it only exports an ESM browser build).

/** A cortical surface with the mesh.layers example's motor-task layer. */
export async function createHeroScene(
  canvas: HTMLCanvasElement,
  asset: (path: string) => string,
): Promise<NiiVue> {
  const nv = new NiiVue({
    backgroundColor: [0, 0, 0, 0],
    isColorbarVisible: false,
    isOrientCubeVisible: false,
    is3DCrosshairVisible: false,
  })
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
          // The example's startup values. An unset negative range would
          // mirror the positive one onto negative values.
          url: asset('meshes/BrainMesh_ICBM152.lh.motor.mz3'),
          colormap: 'warm',
          colormapNegative: 'winter',
          calMin: 3,
          calMax: 6,
          calMinNeg: -1.2,
          calMaxNeg: -4.2,
          colormapType: 2,
          opacity: 0.7,
          isColorbarVisible: false,
        },
      ],
    },
  ])
  nv.sliceType = SLICE_TYPE.RENDER
  return nv
}
