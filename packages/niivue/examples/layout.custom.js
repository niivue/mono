import NiiVue from "../src/index.ts"

// ---------- Predefined custom layouts ----------

const layouts = {
  // Sagittal on the left half, coronal top-right, axial bottom-right
  leftSag: [
    { sliceType: 2, position: [0, 0, 0.5, 1.0] },
    { sliceType: 1, position: [0.5, 0, 0.5, 0.5] },
    { sliceType: 0, position: [0.5, 0.5, 0.5, 0.5] },
  ],
  // Axial spanning the top, coronal and sagittal side-by-side below
  topAxial: [
    { sliceType: 0, position: [0, 0, 1.0, 0.5] },
    { sliceType: 1, position: [0, 0.5, 0.5, 0.5] },
    { sliceType: 2, position: [0.5, 0.5, 0.5, 0.5] },
  ],
  // Three equal columns: sagittal | coronal | axial
  threeColumn: [
    { sliceType: 2, position: [0, 0, 1 / 3, 1.0] },
    { sliceType: 1, position: [1 / 3, 0, 1 / 3, 1.0] },
    { sliceType: 0, position: [2 / 3, 0, 1 / 3, 1.0] },
  ],
  // Four quadrants: axial, coronal, sagittal, render
  quadrant: [
    { sliceType: 0, position: [0, 0, 0.5, 0.5] },
    { sliceType: 1, position: [0.5, 0, 0.5, 0.5] },
    { sliceType: 2, position: [0, 0.5, 0.5, 0.5] },
    { sliceType: 4, position: [0.5, 0.5, 0.5, 0.5] },
  ],
  // Wide 3D render on the left, narrow slice stack on the right
  wideRender: [
    { sliceType: 4, position: [0, 0, 0.7, 1.0] },
    { sliceType: 0, position: [0.7, 0, 0.3, 1 / 3] },
    { sliceType: 1, position: [0.7, 1 / 3, 0.3, 1 / 3] },
    { sliceType: 2, position: [0.7, 2 / 3, 0.3, 1 / 3] },
  ],
}

// ---------- Viewer setup ----------

const nv = new NiiVue({
  isColorbarVisible: true,
  backgroundColor: [0.2, 0.2, 0.2, 1],
})

nv.addEventListener("locationChange", (e) => {
  document.getElementById("location").innerHTML =
    `&nbsp;&nbsp;${e.detail.string}`
})

await nv.attachToCanvas(gl1)
await nv.loadVolumes([{ url: "/volumes/mni152.nii.gz" }])

// Apply the initial custom layout
nv.customLayout = layouts.leftSag

// ---------- Controls ----------

layoutSelect.onchange = function () {
  const key = this.value
  if (key === "builtin") {
    nv.clearCustomLayout()
  } else {
    nv.customLayout = layouts[key]
  }
}

radioCheck.onclick = function () {
  nv.isRadiological = this.checked
}

equalCheck.onclick = function () {
  nv.isEqualSize = this.checked
}
