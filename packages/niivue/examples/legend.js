import NiiVue from '../src/index.ts'

// A voxel atlas (AAL) and a mesh atlas share one legend. Each item's
// isLegendVisible decides whether its labels join it.
legendSelect.onchange = async () => {
  const v = legendSelect.value
  await nv1.setVolume(1, { isLegendVisible: v === 'both' || v === 'voxel' })
  await nv1.setMesh(0, { isLegendVisible: v === 'both' || v === 'mesh' })
}
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

const nv1 = new NiiVue({ backgroundColor: [0.3, 0.3, 0.5, 1] })
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)
nv1.showRender = 1 // SHOW_RENDER.ALWAYS: keep the 3D tile when no legend takes the space
await nv1.loadVolumes([
  { url: '/volumes/mni152.nii.gz', calMin: 30, calMax: 80 },
  { url: '/volumes/aal.nii.gz', opacity: 0.5 },
])
await nv1.addColormapFromUrl('/volumes/aal.json')
await nv1.setVolume(1, { colormap: 'aal' })
await nv1.loadMeshes([{ url: '/meshes/atl-Anatom_space-MNI.mz3' }])
legendSelect.onchange()
