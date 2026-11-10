import NiiVue from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const overlayColormap = document.getElementById('overlayColormap')
const resetAffine = document.getElementById('resetAffine')
const rotateY = document.getElementById('rotateY')
const rotateYValue = document.getElementById('rotateYValue')
const translateX = document.getElementById('translateX')
const translateXValue = document.getElementById('translateXValue')
const underlayColormap = document.getElementById('underlayColormap')
const webgpuCheck = document.getElementById('webgpuCheck')

const nv1 = new NiiVue({
  backgroundColor: [0.2, 0.2, 0.2, 1],
  isColorbarVisible: true,
})

function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}

let originalOverlayAffine = null

function multiplyAffine(transform, affine) {
  const result = Array.from({ length: 4 }, () => [0, 0, 0, 0])
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      for (let k = 0; k < 4; k++) {
        result[row][col] += transform[row][k] * affine[k][col]
      }
    }
  }
  return result
}

function createTransform(translationX, rotationY) {
  const radians = (rotationY * Math.PI) / 180
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return [
    [c, 0, s, translationX],
    [0, 1, 0, 0],
    [-s, 0, c, 0],
    [0, 0, 0, 1],
  ]
}

async function applyAffine() {
  if (!originalOverlayAffine) return
  const translationX = Number(translateX.value)
  const rotationY = Number(rotateY.value)
  translateXValue.textContent = String(translationX)
  rotateYValue.textContent = String(rotationY)
  await nv1.setVolumeAffine(
    1,
    multiplyAffine(
      createTransform(translationX, rotationY),
      originalOverlayAffine,
    ),
  )
}

translateX.oninput = applyAffine
rotateY.oninput = applyAffine
resetAffine.onclick = async () => {
  translateX.value = '0'
  rotateY.value = '0'
  await applyAffine()
}
underlayColormap.onchange = async function () {
  await nv1.setVolume(0, { colormap: this.value })
}
overlayColormap.onchange = async function () {
  await nv1.setVolume(1, { colormap: this.value })
}
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
nv1.sliceType = 3
await nv1.loadVolumes([
  {
    url: '/volumes/mni152.nii.gz',
    calMin: 30,
    calMax: 80,
    colormap: 'gray',
  },
  {
    url: '/volumes/spmMotor.nii.gz',
    calMin: 4,
    calMax: 12,
    colormap: 'hot',
    opacity: 0.7,
  },
])
originalOverlayAffine = nv1.getVolumeAffine(1)
await applyAffine()
