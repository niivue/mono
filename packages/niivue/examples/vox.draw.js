import NiiVue from '../src/index.ts'

let isDrawing = false

function setDrawingUI(enabled) {
  isDrawing = enabled
  undoBtn.disabled = !enabled
  saveBtn.disabled = !enabled
  closeBtn.disabled = !enabled
}

function ensureDrawing() {
  if (!isDrawing) {
    nv1.createEmptyDrawing()
    setDrawingUI(true)
  }
}

penValue.onchange = function () {
  const val = parseInt(this.value, 10)
  if (val < 0) {
    // "Off" selected — disable pen but keep drawing visible
    nv1.drawIsEnabled = false
    return
  }
  ensureDrawing()
  nv1.drawIsEnabled = true
  if (val >= 4) {
    // Filled: values 4,5,6 map to pen colors 1,2,3
    nv1.drawPenValue = val - 3
    nv1.drawPenAutoClose = true
    nv1.drawPenFilled = true
  } else {
    // Outline or erase: values 0,1,2,3
    nv1.drawPenValue = val
    nv1.drawPenAutoClose = false
    nv1.drawPenFilled = false
  }
}

penSize.oninput = function () {
  nv1.drawPenSize = parseInt(this.value, 10)
}

opacitySlider.oninput = function () {
  nv1.drawOpacity = this.value * 0.01
}

undoBtn.onclick = () => {
  nv1.drawUndo()
}

saveBtn.onclick = () => {
  nv1.saveDrawing('drawing.nii.gz')
}

closeBtn.onclick = () => {
  if (isDrawing) {
    nv1.closeDrawing()
    setDrawingUI(false)
    penValue.value = '-1'
  }
}

loadBtn.onclick = () => {
  if (isDrawing) {
    alert('A drawing is already open. Please close it before loading another.')
    return
  }
  loadFile.click()
}

async function openDrawing(source) {
  const ok = await nv1.loadDrawing(source)
  if (ok) {
    setDrawingUI(true)
    penValue.value = '1'
    nv1.drawPenValue = 1
    nv1.drawPenAutoClose = false
    nv1.drawPenFilled = false
  }
  return ok
}

loadFile.onchange = async function () {
  const file = this.files?.[0]
  if (!file) return
  const name = file.name.toLowerCase()
  if (!name.endsWith('.nii') && !name.endsWith('.nii.gz')) {
    alert(`Unsupported file: ${file.name}\nExpected .nii or .nii.gz`)
    this.value = ''
    return
  }
  const ok = await openDrawing(file)
  if (!ok) {
    alert(
      `Could not load ${file.name} as a drawing.\nCheck the browser console for details.`,
    )
  }
  this.value = ''
}

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

antiAliasCheck.onchange = async () => {
  await nv1.reinitializeView({ isAntiAlias: antiAliasCheck.checked })
}

leftBtn.onclick = () => nv1.moveCrosshairInVox(-1, 0, 0)
rightBtn.onclick = () => nv1.moveCrosshairInVox(1, 0, 0)
posteriorBtn.onclick = () => nv1.moveCrosshairInVox(0, -1, 0)
anteriorBtn.onclick = () => nv1.moveCrosshairInVox(0, 1, 0)
inferiorBtn.onclick = () => nv1.moveCrosshairInVox(0, 0, -1)
superiorBtn.onclick = () => nv1.moveCrosshairInVox(0, 0, 1)

overwriteCheck.onchange = function () {
  nv1.drawIsFillOverwriting = this.checked
}

rimCheck.onchange = function () {
  nv1.drawRimOpacity = this.checked ? 1 : -1
}

function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}

const nv1 = new NiiVue({})
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
rimCheck.onchange()
sliceType.onchange()
await nv1.loadVolumes({ url: '/volumes/mni152.nii.gz' })
nv1.drawOpacity = 0.3
await openDrawing('/volumes/drawing.nii.gz')
