import NiiVue from "../src/index.ts"

const volumeSelect = document.getElementById("volumeSelect")

// --- Populate the volume dropdown from the current volume list ---
function refreshVolumeList() {
  const prev = volumeSelect.value
  volumeSelect.innerHTML = ""
  for (let i = 0; i < nv1.volumes.length; i++) {
    const vol = nv1.volumes[i]
    const label = vol.name || vol.url || `Volume ${i}`
    const opt = document.createElement("option")
    opt.value = i
    opt.textContent = `[${i}] ${label}`
    volumeSelect.appendChild(opt)
  }
  // Try to keep the same index selected
  if (prev !== "" && parseInt(prev, 10) < nv1.volumes.length) {
    volumeSelect.value = prev
  }
}

// --- Reorder buttons ---
upBtn.onclick = async () => {
  const idx = parseInt(volumeSelect.value, 10)
  await nv1.moveVolumeUp(idx)
}
downBtn.onclick = async () => {
  const idx = parseInt(volumeSelect.value, 10)
  await nv1.moveVolumeDown(idx)
}
toTopBtn.onclick = async () => {
  const idx = parseInt(volumeSelect.value, 10)
  await nv1.moveVolumeToTop(idx)
}
toBottomBtn.onclick = async () => {
  const idx = parseInt(volumeSelect.value, 10)
  await nv1.moveVolumeToBottom(idx)
}
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

// --- Location bar ---
function handleLocationChange(data) {
  document.getElementById("location").innerHTML = `&nbsp;&nbsp;${data.string}`
}

// --- Init ---
const nv1 = new NiiVue({
  isColorbarVisible: true,
  backgroundColor: [0.1, 0.1, 0.1, 1],
})
nv1.addEventListener("locationChange", (e) => handleLocationChange(e.detail))
nv1.addEventListener("volumeOrderChanged", () => refreshVolumeList())
await nv1.attachToCanvas(gl1)
nv1.showRender = 1

await nv1.loadVolumes([
  {
    url: "/volumes/mni152.nii.gz",
    isColorbarVisible: false,
    calMin: 30,
    calMax: 80,
  },
  {
    url: "/volumes/spmMotor.nii.gz",
    colormap: "redyell",
    colormapNegative: "winter",
  },
])
// Apply the same initial thresholds as vox.stats.html
// (slider defaults: minNeg=30, rangeNeg=30, min=30, range=30)
await nv1.setVolume(1, {
  calMinNeg: 30 * -0.1,
  calMaxNeg: 30 * -0.1 + 30 * -0.1,
  calMin: 30 * 0.1,
  calMax: 30 * 0.1 + 30 * 0.1,
  colormapType: 0,
})
refreshVolumeList()
