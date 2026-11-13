// The five scenes on the home page, run in the browser by home-stills.ts.
// Each draws on a square canvas with nothing on screen but the image.
import NiiVue, { createSlideView, NVSlide, SLICE_TYPE } from '@niivue/niivue'
import { openSlide } from '../../../packages/nv-ext-tile/src/open.ts'

const DEMO_IMAGES =
  'https://raw.githubusercontent.com/niivue/niivue-demo-images/main/'
// An H&E-stained skin sample (Carnegie Mellon, via OpenSlide's test data).
const HE_SLIDE =
  'https://media.githubusercontent.com/media/niivue/niivue-demo-images-lfs/main/streaming/svs/CMU-1-Small-Region.svs'

async function viewer(canvas, options) {
  const nv = new NiiVue({
    isOrientCubeVisible: false,
    isOrientationTextVisible: false,
    is3DCrosshairVisible: false,
    crosshairWidth: 0,
    isLegendVisible: false,
    ...options,
  })
  await nv.attachToCanvas(canvas)
  return nv
}

export const scenes = {
  async mri(canvas) {
    const nv = await viewer(canvas, { sliceType: SLICE_TYPE.SAGITTAL })
    await nv.loadVolumes([{ url: '/volumes/chris_t1.nii.gz' }])
    nv.pan2Dxyzmm = [0, 0, 0, 0.88] // a margin around the head
  },

  async ct(canvas) {
    const nv = await viewer(canvas, { sliceType: SLICE_TYPE.RENDER })
    await nv.loadVolumes([
      { url: `${DEMO_IMAGES}CT_Philips.nii.gz`, colormap: 'ct_skull' },
    ])
    nv.azimuth = 120
    nv.elevation = 10
  },

  async microscopy(canvas) {
    const { candidates } = await openSlide(HE_SLIDE)
    const slide = NVSlide.fromSource(await candidates[0].open())
    const view = await createSlideView(canvas, { controller: false })
    view.setSlide(slide, { fit: false })
    // Zoomed into the stained tissue, so the slide's white glass stays out.
    const { width, height } = slide.manifest
    slide.setViewport({
      centerX: width * 0.56,
      centerY: height * 0.64,
      scale: slide.fitScaleFor(view.screen()) * 4,
    })
    view.requestRender()
  },

  async surfaces(canvas) {
    const nv = await viewer(canvas, { sliceType: SLICE_TYPE.RENDER })
    await nv.loadMeshes([
      {
        url: '/meshes/BrainMesh_ICBM152.lh.mz3',
        shaderType: 'matte',
        layers: [
          {
            url: '/meshes/BrainMesh_ICBM152.lh.curv',
            colormap: 'gray',
            calMin: 0.3,
            calMax: 0.5,
            isColorbarVisible: false,
          },
          {
            url: '/meshes/BrainMesh_ICBM152.lh.motor.mz3',
            colormap: 'warm',
            calMin: 3,
            calMax: 6,
            opacity: 0.9,
            isColorbarVisible: false,
          },
        ],
      },
    ])
    nv.azimuth = 90 // the outer (lateral) side of the left hemisphere
    nv.elevation = 15
  },

  async tractography(canvas) {
    const nv = await viewer(canvas, { sliceType: SLICE_TYPE.RENDER })
    await nv.loadMeshes([{ url: '/meshes/yeh2022.trx' }])
    nv.azimuth = 250
    nv.elevation = 15
    nv.scaleMultiplier = 0.9
  },
}
