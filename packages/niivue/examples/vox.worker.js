import NiiVue, { SHOW_RENDER } from '../src/index.ts'

// --- worker shims ---------------------------------------------------------
// NiiVue is written for the DOM. These are the only globals it touches that a
// worker does not already provide.
self.window = self // reads window.devicePixelRatio, adds a keydown listener
self.HTMLCanvasElement = OffscreenCanvas // `canvas instanceof HTMLCanvasElement` guards attach
self.ResizeObserver = class {
  observe() {}
  disconnect() {}
} // setupResizeHandler constructs one; the page forwards resizes instead
// Font atlas and matcaps load through `new Image()`. An OffscreenCanvas is a
// valid texImage2D source, so subclassing it needs no texture-upload patching.
self.Image = class extends OffscreenCanvas {
  constructor() {
    super(1, 1)
  }
  set src(url) {
    fetch(url)
      .then((response) => response.blob())
      .then(createImageBitmap)
      .then((bitmap) => {
        this.width = bitmap.width
        this.height = bitmap.height
        this.getContext('2d').drawImage(bitmap, 0, 0)
        this.onload()
      })
      .catch((error) => this.onerror?.(error))
  }
}
// --- end worker shims -----------------------------------------------------

let nv = null
let canvas = null
const css = { width: 1, height: 1 }

function shimCanvas(offscreen) {
  offscreen.style = {} // interactions sets canvas.style.touchAction
  offscreen.setPointerCapture = () => {} // drag paths capture on the canvas
  offscreen.releasePointerCapture = () => {}
  // The page sends coordinates already relative to the canvas, so the rect origin is 0.
  offscreen.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    x: 0,
    y: 0,
    right: css.width,
    bottom: css.height,
    width: css.width,
    height: css.height,
  })
}

async function init(data) {
  canvas = data.canvas
  css.width = data.width
  css.height = data.height
  self.devicePixelRatio = data.dpr
  shimCanvas(canvas)
  nv = new NiiVue({
    backend: 'webgl2',
    backgroundColor: [0.2, 0.2, 0.2, 1],
    isColorbarVisible: true,
    showRender: SHOW_RENDER.ALWAYS,
  })
  nv.addEventListener('locationChange', (e) =>
    self.postMessage({ type: 'location', text: e.detail.string }),
  )
  await nv.attachToCanvas(canvas)
  // The URL comes from the page: the GitHub Pages base-path rewrite runs on page
  // chunks but not on worker bundles.
  await nv.loadVolumes({ url: data.url })
  self.postMessage({ type: 'ready', colormaps: nv.colormaps })
}

self.onmessage = async ({ data }) => {
  switch (data.type) {
    case 'init':
      try {
        await init(data)
      } catch (error) {
        self.postMessage({
          type: 'location',
          text: `Worker failed: ${error.message}`,
        })
      }
      break
    case 'event': {
      // OffscreenCanvas is an EventTarget, and PointerEvent fields are plain
      // own properties on a synthetic Event, so no PointerEvent ctor is needed.
      const { type, ...fields } = data.init
      const event = new Event(type, { cancelable: true })
      Object.assign(event, fields)
      canvas?.dispatchEvent(event)
      break
    }
    case 'resize':
      css.width = data.width
      css.height = data.height
      self.devicePixelRatio = data.dpr
      nv?.view?.resize()
      break
    case 'sliceType':
      if (nv) nv.sliceType = data.value
      break
    case 'colormap':
      nv?.setVolume(0, { colormap: data.value })
      break
  }
}
