import { cortex, shiny } from '../src/assets/matcaps'
import NiiVue from '../src/index.ts'
import { SHOW_RENDER } from '../src/NVConstants.ts'

gradSlider.oninput = () => {
  nv1.volumeIllumination = Number(gradSlider.value) / 100
}
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
clipSelect.onchange = function () {
  const index = parseInt(this.value, 10) // selected option value as integer
  let planes = [[2.0, 180, 20]]
  switch (index) {
    case 1:
      planes = [[-0.1, 180, 20]]
      break
    case 2:
      planes = [
        [0.1, 180, 20],
        [0.1, 0, -20],
      ]
      break
    case 3:
      planes = [
        [0.0, 90, 0], //right center
        [0.0, 0, -20], //posterior oblique
        [0.1, 0, -90], //inferior
      ]
      break
    case 4:
      planes = [
        [0.3, 270, 0], //left
        [0.3, 90, 0], //right
        [0.0, 180, 0], //anterior
        [0.1, 0, 0], //posterior
      ]
      break
    case 5:
      planes = [
        [0.4, 270, 0], //left
        [0.4, 90, 0], //right
        [0.4, 180, 0], //anterior
        [0.2, 0, 0], //posterior
        [0.1, 0, -90], //inferior
      ]
      break
    case 6:
      planes = [
        [0.4, 270, 0], //left
        [-0.1, 90, 0], //right
        [0.4, 180, 0], //anterior
        [0.2, 0, 0], //posterior
        [0.1, 0, -90], //inferior
        [0.3, 0, 90], //superior
      ]
      break
  }
  nv1.setClipPlanes(planes)
}
matcapSelect.onchange = async () => {
  await nv1.loadMatcap(matcapSelect.value)
}
const nv1 = new NiiVue({
  matcaps: { Cortex: cortex, Shiny: shiny },
  showRender: SHOW_RENDER.ALWAYS,
})
await nv1.attachToCanvas(gl1)
sliceType.onchange()
await nv1.loadVolumes([{ url: '/volumes/torso.nii.gz' }])
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
gradSlider.oninput()
nv1.addColormap('_torso', {
  R: [0, 0, 185, 185, 252, 0, 103, 216, 127, 127, 0, 222],
  G: [0, 20, 102, 102, 0, 255, 76, 132, 0, 127, 255, 154],
  B: [0, 152, 83, 83, 0, 0, 71, 105, 127, 0, 255, 132],
  A: [0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
  I: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  labels: [
    'background',
    '1spleen',
    '2kidneyR',
    '3kidneyL',
    '4gallbladder',
    '5esophagus',
    '6Liver',
    '7stomach',
    '8aorta',
    '9inferiorvenacava',
    '10pancreas',
    '11bladder',
  ],
})
nv1.drawColormap = '_torso'
await nv1.loadDrawing('/volumes/torsoLabel.nii.gz')
nv1.drawIsEnabled = false
clipSelect.onchange()
matcapSelect.onchange()
