// Overlay an NVSlide as a textured plane in a real MNI152 volume render.
//
// This is the full "slide in 3D" path: NiiVue renders the MNI152 brain in 3D
// and `nv.setSlidePlane()` registers an NVSlide into the volume's world (mm)
// space. The slide is drawn by the core renderer in the 3D render tile using
// the same MVP as the volume, so it composites in-place and shares the camera —
// orbit/zoom with the mouse and the slide moves with the brain. Tiles stream in
// through NVSlide's cache (HTTP range / decode), so the plane sharpens as data
// arrives. Works on both backends: append `?backend=webgpu` (default WebGL2).
import NiiVue, {
  axialPlaneTransform,
  NVSlide,
  SHOW_RENDER,
  SLICE_TYPE,
} from '../src/index.ts'

// Approximate MNI152 world extents (mm) for placing the slide plane.
const MNI = { xmin: -90, xmax: 90, ymin: -126, ymax: 90, zmin: -72, zmax: 108 }

const hud = document.getElementById('hud')
const canvas = document.getElementById('gl')

function backendFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('backend')
  return raw === 'webgpu' && 'gpu' in navigator ? 'webgpu' : 'webgl2'
}

async function main() {
  const backend = backendFromUrl()
  const nv = new NiiVue({
    backend,
    backgroundColor: [0.027, 0.063, 0.051, 1],
    sliceType: SLICE_TYPE.RENDER,
    showRender: SHOW_RENDER.ALWAYS,
    isColorbarVisible: false,
    isOrientCubeVisible: true,
  })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz', colormap: 'gray' }])

  // Load the slide and lay it onto a mid-axial plane spanning the MNI box.
  const base = import.meta.env.BASE_URL || '/'
  const url = new URL(
    `${base.endsWith('/') ? base : `${base}/`}tile-range-poc/tiles.json`,
    window.location.href,
  ).toString()
  const slide = await NVSlide.fromManifestUrl(url)
  // Lay the slide on the volume's actual mid-axial plane (its real mm extents),
  // so it coincides with the clip cut below. Falls back to MNI constants.
  const mn = nv.model.extentsMin
  const mx = nv.model.extentsMax
  const ext = {
    xmin: mn?.[0] ?? MNI.xmin,
    xmax: mx?.[0] ?? MNI.xmax,
    ymin: mn?.[1] ?? MNI.ymin,
    ymax: mx?.[1] ?? MNI.ymax,
    z: ((mn?.[2] ?? MNI.zmin) + (mx?.[2] ?? MNI.zmax)) / 2,
  }
  const transform = axialPlaneTransform(
    slide.manifest.width,
    slide.manifest.height,
    ext,
  )
  nv.setSlidePlane(slide, { pixelToWorld: transform })
  // Cut the brain at the same axial plane so the registered slide is revealed
  // inside the volume; a transparent clip cap lets the slide be the cut face.
  nv.clipPlaneColor = [0, 0, 0, 0]
  nv.isClipPlaneCutaway = true
  nv.setClipPlane([0, 0, -90])
  // Tilt the camera down so the axial cut face (and the slide on it) is seen.
  nv.azimuth = 120
  nv.elevation = 35

  const updateHud = () => {
    const label = backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    const s = slide.stats
    hud.textContent = `${slide.manifest.name}\nMNI152 + slide plane · ${label}\ntiles ${s.completed}/${s.requested} · ${(s.wireBytes / 1024).toFixed(0)} KB`
  }
  slide.addEventListener('change', updateHud)
  updateHud()
}

main().catch((err) => {
  hud.textContent = `error: ${err instanceof Error ? err.message : err}`
  console.error(err)
})
