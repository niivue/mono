import NiiVue, { SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue'

// Loaded with import() from nv-hero.ts, so NiiVue downloads after the page
// has rendered.

/** The MNI152 template with the SPM motor task map: three slices and a render. */
export async function createHeroScene(
  canvas: HTMLCanvasElement,
  asset: (path: string) => string,
): Promise<NiiVue> {
  const nv = new NiiVue({
    backgroundColor: [0, 0, 0, 1],
    sliceType: SLICE_TYPE.MULTIPLANAR,
    showRender: SHOW_RENDER.ALWAYS,
    isColorbarVisible: false,
  })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([
    { url: asset('volumes/mni152.nii.gz'), calMin: 30, calMax: 80 },
    {
      url: asset('volumes/spmMotor.nii.gz'),
      colormap: 'redyell',
      colormapNegative: 'winter',
      calMin: 3,
      calMax: 6,
      calMinNeg: -3,
      calMaxNeg: -6,
    },
  ])
  return nv
}
