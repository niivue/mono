const colormapSelect = document.getElementById('colormapSelect')
const gl1 = document.getElementById('gl1')
const sliceType = document.getElementById('sliceType')
const footer = document.getElementById('location')
const worker = new Worker(new URL('./vox.worker.js', import.meta.url), {
  type: 'module',
})
const post = (message) => worker.postMessage(message)
const size = () => ({
  width: gl1.clientWidth,
  height: gl1.clientHeight,
  dpr: devicePixelRatio,
})

worker.onmessage = ({ data }) => {
  if (data.type === 'location') {
    footer.innerHTML = `&nbsp;&nbsp;${data.text}`
    return
  }
  for (const cmap of data.colormaps) {
    const option = document.createElement('option')
    option.value = cmap
    option.textContent = cmap.charAt(0).toUpperCase() + cmap.slice(1)
    option.selected = cmap.toLowerCase() === 'gray'
    colormapSelect.appendChild(option)
  }
}
sliceType.onchange = () =>
  post({ type: 'sliceType', value: parseInt(sliceType.value, 10) })
colormapSelect.onchange = () =>
  post({ type: 'colormap', value: colormapSelect.value })

// Pointer state the library reads, flattened so it survives structured clone.
const FIELDS = [
  'button',
  'pointerId',
  'deltaY',
  'detail',
  'shiftKey',
  'ctrlKey',
  'altKey',
  'metaKey',
]
function forward(e) {
  if (e.type === 'wheel') e.preventDefault()
  if (e.type === 'pointerdown') gl1.setPointerCapture(e.pointerId)
  const rect = gl1.getBoundingClientRect()
  const init = {
    type: e.type,
    clientX: e.clientX - rect.left,
    clientY: e.clientY - rect.top,
  }
  for (const key of FIELDS) if (key in e) init[key] = e[key]
  post({ type: 'event', init })
}
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel']) {
  gl1.addEventListener(type, forward, { passive: false })
}
new ResizeObserver(() => post({ type: 'resize', ...size() })).observe(gl1)

const offscreen = gl1.transferControlToOffscreen()
worker.postMessage(
  { type: 'init', canvas: offscreen, url: '/volumes/mni152.nii.gz', ...size() },
  [offscreen],
)
