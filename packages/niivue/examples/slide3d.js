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
  // Slide-space drawing: a label raster painted with the standard pen tools.
  nv.createSlideDrawing()
  nv.model.draw.penValue = 1
  nv.model.draw.penSize = 16
  // Cut the brain at the same axial plane so the registered slide is revealed
  // inside the volume; a transparent clip cap lets the slide be the cut face.
  nv.clipPlaneColor = [0, 0, 0, 0]
  nv.isClipPlaneCutaway = true
  nv.setClipPlane([0, 0, -90])
  // Tilt the camera down so the axial cut face (and the slide on it) is seen.
  nv.azimuth = 120
  nv.elevation = 35

  // Draw mode (key "d"): intercept pointer events in the capture phase so they
  // paint the slide instead of orbiting; "u" undoes, "c" clears.
  let drawMode = false
  let drawing = false
  const css = (e) => {
    const r = canvas.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (!drawMode) return
      e.stopImmediatePropagation()
      e.preventDefault()
      drawing = true
      nv.slideDrawAt(...css(e), true)
    },
    true,
  )
  canvas.addEventListener(
    'pointermove',
    (e) => {
      if (!drawMode || !drawing) return
      e.stopImmediatePropagation()
      e.preventDefault()
      nv.slideDrawAt(...css(e), false)
    },
    true,
  )
  window.addEventListener(
    'pointerup',
    () => {
      if (!drawMode) return
      drawing = false
      nv.slideDrawEnd()
    },
    true,
  )
  window.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase()
    if (k === 'd') drawMode = !drawMode
    else if (k === 'u') nv.slideDrawUndo()
    else if (k === 'c') nv.clearSlideDrawing()
    else return
    updateHud()
  })
  const drawBtn = document.getElementById('drawBtn')
  drawBtn?.addEventListener('click', () => {
    drawMode = !drawMode
    drawBtn.textContent = `Draw: ${drawMode ? 'on' : 'off'}`
    updateHud()
  })
  document
    .getElementById('undoBtn')
    ?.addEventListener('click', () => nv.slideDrawUndo())
  document.getElementById('clearBtn')?.addEventListener('click', () => {
    nv.clearSlideDrawing()
    nv.slideVector?.clear()
    nv.refreshSlideAnnotation()
  })
  document.getElementById('toolSel')?.addEventListener('change', (e) => {
    nv.slideTool = e.target.value
  })
  document.getElementById('labelSel')?.addEventListener('change', (e) => {
    nv.model.draw.penValue = Number(e.target.value) || 1
  })
  document.getElementById('svgBtn')?.addEventListener('click', () => {
    const layer = nv.slideVector
    if (!layer || layer.shapes.length === 0) return
    const svg = layer.toSVG(slide.manifest.width, slide.manifest.height)
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${slide.manifest.name || 'slide'}-annotations.svg`
    a.click()
    URL.revokeObjectURL(url)
  })

  const updateHud = () => {
    const label = backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    const s = slide.stats
    hud.textContent = `${slide.manifest.name}\nMNI152 + slide plane · ${label}\ntiles ${s.completed}/${s.requested} · ${(s.wireBytes / 1024).toFixed(0)} KB\ndraw mode ${drawMode ? 'ON' : 'off'} (d toggle · u undo · c clear)`
  }
  slide.addEventListener('change', updateHud)
  updateHud()
}

main().catch((err) => {
  hud.textContent = `error: ${err instanceof Error ? err.message : err}`
  console.error(err)
})
