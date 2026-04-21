import NiiVue from '../src/index.ts'

colorBtn.addEventListener('input', (event) => {
  const input = event.target
  const hex = input.value
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  nv1.backgroundColor = [r, g, b, 1.0]
})

marginSlide.oninput = function () {
  nv1.tileMargin = this.value * 2
}

heroSlide.oninput = function () {
  nv1.heroFraction = this.value * 0.1
}

sizeCheck.onclick = function () {
  nv1.isEqualSize = this.checked
}

darkCheck.onclick = function () {
  nv1.volumeIsAlphaClipDark = this.checked
}

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

function updateMultiplanarEnabled() {
  const isDisabled = parseInt(sliceType.value, 10) !== 3
  multiplanarType.disabled = isDisabled
  heroSlide.disabled = isDisabled
  forceRenderCheck.disabled = isDisabled
  const isMosaic = parseInt(sliceType.value, 10) === 5
  mosaicStr.disabled = !isMosaic
}

multiplanarType.onchange = function () {
  nv1.multiplanarType = parseInt(this.value, 10)
}

sliceType.onchange = () => {
  const v = parseInt(sliceType.value, 10)
  updateMultiplanarEnabled()
  if (v > 4) {
    nv1.mosaicString = mosaicStr.value
    return
  }
  nv1.mosaicString = ''
  nv1.sliceType = v
}

updateMultiplanarEnabled()

mosaicBtn.onclick = () => {
  window.alert(
    'Choose axial (A), coronal (C) or sagittal (S) slices. Modify with cross slices (X), renderings (R).',
  )
}

mosaicStr.addEventListener('keyup', (_e) => {
  sliceType.value = '5'
  nv1.mosaicString = mosaicStr.value
})

gl1.ondblclick = (e) => {
  if (nv1.heroFraction <= 0) return
  const rect = gl1.getBoundingClientRect()
  const x = (e.clientX - rect.left) * (gl1.width / rect.width)
  const y = (e.clientY - rect.top) * (gl1.height / rect.height)
  const hit = nv1.view?.hitTest(x, y)
  if (!hit) return
  const tiles = nv1.view?.screenSlices
  if (!tiles?.[hit.tileIndex]) return
  const clickType = tiles[hit.tileIndex].axCorSag
  if (clickType === nv1.heroSliceType) {
    nv1.heroSliceType = 4 // RENDER
  } else {
    nv1.heroSliceType = clickType
  }
}
radioCheck.onclick = function () {
  nv1.isRadiological = this.checked
}
rulerCheck.onclick = function () {
  nv1.isRulerVisible = this.checked
}
forceRenderCheck.onclick = function () {
  nv1.showRender = Number(this.checked)
}

function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}

const nv1 = new NiiVue({
  isColorbarVisible: true,
  backgroundColor: [0.2, 0.2, 0.2, 1],
})
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
const volumeList = [{ url: '/volumes/mni152.nii.gz' }]
await nv1.loadVolumes(volumeList)
await nv1.loadMeshes([{ url: '/meshes/dpsv.trx' }])
sliceType.onchange()
