import NiiVue from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const checkCutaway = document.getElementById('checkCutaway')
const clipSelect = document.getElementById('clipSelect')
const colorSelect = document.getElementById('colorSelect')
const xrayCheck = document.getElementById('xrayCheck')

checkCutaway.onclick = function () {
  nv1.isClipPlaneCutaway = this.checked
}
xrayCheck.onclick = function () {
  nv1.meshXRay = +this.checked * 0.1
}
colorSelect.onchange = function () {
  const index = this.selectedIndex
  const clr = nv1.clipPlaneColor
  switch (index) {
    case 0:
      clr[3] = 0.0
      break
    case 1:
      clr[3] = 0.3
      break
    case 2:
      clr[3] = -0.2
      break
  }
  nv1.clipPlaneColor = clr
}
clipSelect.onchange = function () {
  const index = parseInt(this.value, 10) // selected option value as integer
  let planes = [[2.0, 180, 20]]
  switch (index) {
    case 1:
      planes = [[0.1, 180, 20]]
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
const nv1 = new NiiVue({ meshXRay: 0.1 })
window.nv1 = nv1
await nv1.attachToCanvas(gl1)
nv1.sliceType = 4
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
clipSelect.onchange()
