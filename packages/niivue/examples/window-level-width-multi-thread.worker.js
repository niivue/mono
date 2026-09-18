// @ts-check

let nv = null
let canvas = null
let pendingFrameResolve = null
let imageBaseUrl = ''
let latestWindowMessage = null
let processingWindow = false
let activeFrameTiming = null
let lastAnimationCallbackAt = null
let animationFrameSource = 'unknown'
let nativeRequestFrame = null
let nativeCancelFrame = null

// Independent continuous native RAF probe: no NiiVue updates or GPU draws.
function probeNativeFrames() {
  if (!nativeRequestFrame || !nativeCancelFrame) {
    return Promise.resolve({ supported: false, source: animationFrameSource })
  }
  return new Promise((resolve) => {
    const intervals = []
    let previous = null
    let handle = null
    const tick = () => {
      const now = performance.now()
      if (previous !== null) intervals.push(now - previous)
      previous = now
      handle = nativeRequestFrame(tick)
    }
    handle = nativeRequestFrame(tick)
    setTimeout(() => {
      nativeCancelFrame(handle)
      const total = intervals.reduce((sum, value) => sum + value, 0)
      intervals.sort((a, b) => a - b)
      resolve({
        supported: true,
        source: 'native',
        samples: intervals.length,
        hz:
          total > 0
            ? Number(((intervals.length * 1000) / total).toFixed(2))
            : null,
        averageMs: intervals.length
          ? Number((total / intervals.length).toFixed(2))
          : null,
        p50Ms: intervals.length
          ? intervals[Math.floor((intervals.length - 1) * 0.5)]
          : null,
        p95Ms: intervals.length
          ? intervals[Math.floor((intervals.length - 1) * 0.95)]
          : null,
        maxMs: intervals.length ? intervals[intervals.length - 1] : null,
      })
    }, 5000)
  })
}

// One active update and one replaceable pending value; never replay a backlog.
async function drainWindowUpdates() {
  if (processingWindow) return
  processingWindow = true
  try {
    while (latestWindowMessage !== null) {
      const message = latestWindowMessage
      latestWindowMessage = null
      try {
        const queueWaitMs = performance.now() - message.receivedAt
        const result = await setWindow(message.window)
        result.workerQueueWaitMs = queueWaitMs
        // Durations stay on the worker clock; never subtract clock origins.
        result.workerResidenceMs = performance.now() - message.receivedAt
        self.postMessage({
          type: 'windowUpdated',
          sentAt: message.sentAt,
          result,
        })
      } catch (error) {
        pendingFrameResolve = null
        self.postMessage({ type: 'windowError', error: errorMessage(error) })
      }
    }
  } finally {
    processingWindow = false
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function reply(id, result) {
  self.postMessage({ id, ok: true, result })
}

function replyError(id, error) {
  self.postMessage({ id, ok: false, error: errorMessage(error) })
}

function installWorkerImageCompatibility(offscreenCanvas) {
  const scope = globalThis
  if ('Image' in scope) return

  const imageBitmapByElement = new WeakMap()
  const imageProto = Object.getPrototypeOf(offscreenCanvas.getContext('webgl2'))
  const originalTexImage2D = imageProto.texImage2D
  if (!originalTexImage2D.__workerImagePatch) {
    const patchedTexImage2D = function (...args) {
      const source = args[args.length - 1]
      const bitmap = imageBitmapByElement.get(source)
      if (bitmap) args[args.length - 1] = bitmap
      return originalTexImage2D.apply(this, args)
    }
    Object.defineProperty(patchedTexImage2D, '__workerImagePatch', {
      value: true,
    })
    imageProto.texImage2D = patchedTexImage2D
  }

  class WorkerImage {
    constructor() {
      this.onload = null
      this.onerror = null
      this.crossOrigin = ''
      this.width = 0
      this.height = 0
      this.complete = false
    }

    set src(value) {
      const url = new URL(value, imageBaseUrl || self.location.href).href
      this.complete = false
      this.decodePromise = fetch(url)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to fetch image ${response.status}: ${url}`)
          }
          return response.blob()
        })
        .then((blob) => createImageBitmap(blob))
        .then((bitmap) => {
          this.width = bitmap.width
          this.height = bitmap.height
          this.complete = true
          imageBitmapByElement.set(this, bitmap)
          this.onload?.()
        })
        .catch((error) => {
          this.complete = true
          this.onerror?.(error)
        })
    }

    get src() {
      return ''
    }

    decode() {
      return this.decodePromise ?? Promise.resolve()
    }
  }

  Object.defineProperty(scope, 'Image', {
    configurable: true,
    writable: true,
    value: WorkerImage,
  })
}

function installWorkerCanvasCompatibility(offscreenCanvas) {
  const scope = globalThis
  if (!('window' in scope)) {
    Object.defineProperty(scope, 'window', { value: scope })
  }
  if (!('HTMLCanvasElement' in scope)) {
    Object.defineProperty(scope, 'HTMLCanvasElement', {
      value: OffscreenCanvas,
    })
  }
  if (!('devicePixelRatio' in scope)) {
    Object.defineProperty(scope, 'devicePixelRatio', { value: 1 })
  }
  if (!('requestAnimationFrame' in scope)) {
    Object.defineProperty(scope, 'requestAnimationFrame', {
      writable: true,
      configurable: true,
      value: (callback) =>
        setTimeout(() => callback(performance.now()), 1000 / 120),
      // setTimeout(() => callback(performance.now()), 1000 / 240),// slower
    })
  }
  if (!('cancelAnimationFrame' in scope)) {
    Object.defineProperty(scope, 'cancelAnimationFrame', {
      value: (handle) => clearTimeout(handle),
    })
  }
  // Observe the renderer's real callbacks without creating a separate RAF loop.
  const requestFrame = scope.requestAnimationFrame.bind(scope)
  scope.requestAnimationFrame = (callback) => {
    const requestedAt = performance.now()
    return requestFrame((timestamp) => {
      const callbackAt = performance.now()
      if (activeFrameTiming) {
        activeFrameTiming.rafWaitTotalMs += callbackAt - requestedAt
        activeFrameTiming.rafCount += 1
        if (lastAnimationCallbackAt !== null) {
          activeFrameTiming.callbackIntervalTotalMs +=
            callbackAt - lastAnimationCallbackAt
          activeFrameTiming.callbackIntervalCount += 1
        }
      }
      lastAnimationCallbackAt = callbackAt
      callback(timestamp)
    })
  }
  if (!('ResizeObserver' in scope)) {
    Object.defineProperty(scope, 'ResizeObserver', {
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    })
  }

  Object.defineProperty(offscreenCanvas, 'clientWidth', {
    configurable: true,
    get: () => offscreenCanvas.width,
  })
  Object.defineProperty(offscreenCanvas, 'clientHeight', {
    configurable: true,
    get: () => offscreenCanvas.height,
  })
  Object.defineProperty(offscreenCanvas, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: offscreenCanvas.width,
      bottom: offscreenCanvas.height,
      width: offscreenCanvas.width,
      height: offscreenCanvas.height,
      toJSON: () => ({}),
    }),
  })
}

function summarizeVolume(volume) {
  let globalMin = volume.globalMin ?? volume.global_min
  let globalMax = volume.globalMax ?? volume.global_max
  if (
    !Number.isFinite(globalMin) ||
    !Number.isFinite(globalMax) ||
    globalMin === globalMax
  ) {
    const image = volume.img
    const slope = volume.hdr?.scl_slope || 1
    const intercept = volume.hdr?.scl_inter || 0
    globalMin = Infinity
    globalMax = -Infinity
    const stride = Math.max(1, Math.floor(image.length / 1e6))
    for (let i = 0; i < image.length; i += stride) {
      const value = image[i] * slope + intercept
      if (value < globalMin) globalMin = value
      if (value > globalMax) globalMax = value
    }
  }
  return {
    name: volume.name,
    globalMin,
    globalMax,
    calMin: volume.calMin,
    calMax: volume.calMax,
  }
}

async function initialize(message) {
  if (typeof self.requestAnimationFrame === 'function') {
    nativeRequestFrame = self.requestAnimationFrame.bind(self)
    nativeCancelFrame = self.cancelAnimationFrame.bind(self)
  }
  canvas = message.canvas
  imageBaseUrl = message.baseUrl || ''
  canvas.width = message.width
  canvas.height = message.height
  animationFrameSource =
    typeof self.requestAnimationFrame === 'function' ? 'native' : 'timer-120hz'
  installWorkerCanvasCompatibility(canvas)
  installWorkerImageCompatibility(canvas)

  const { default: NiiVue, SHOW_RENDER } = await import('../src/index.ts')
  nv = new NiiVue({
    backend: 'webgl2',
    isInteractionEnabled: false,
    isDragDropEnabled: false,
    devicePixelRatio: 1,
    isColorbarVisible: true,
    backgroundColor: [0.1, 0.1, 0.1, 1],
    matcaps: {},
    showRender: SHOW_RENDER.NEVER,
  })
  nv.perf.enabled = true
  nv.addEventListener('perfFrame', (event) => {
    if (event.detail.tag !== 'window-level') return
    const resolve = pendingFrameResolve
    pendingFrameResolve = null
    resolve?.(event.detail)
  })
  nv.addEventListener('locationChange', (event) => {
    self.postMessage({ type: 'location', value: event.detail.string })
  })
  await nv.attachToCanvas(canvas)
  return { backend: nv.backend }
}

async function loadVolume(file) {
  if (!nv) throw new Error('Renderer is not initialized')
  await nv.loadVolumes([{ url: file }])
  return summarizeVolume(nv.volumes[0])
}

async function setWindow(windowOptions) {
  if (!nv || nv.volumes.length < 1) throw new Error('No volume is loaded')
  const framePromise = new Promise((resolve) => {
    pendingFrameResolve = resolve
  })
  nv.perf.tagFrame('window-level')
  const timing = {
    rafWaitTotalMs: 0,
    rafCount: 0,
    callbackIntervalTotalMs: 0,
    callbackIntervalCount: 0,
  }
  activeFrameTiming = timing
  const startedAt = performance.now()
  try {
    await nv.setVolume(0, windowOptions)
    const updatedAt = performance.now()
    const report = await framePromise
    return {
      workerCpuMs: updatedAt - startedAt,
      frameReportWaitMs: performance.now() - updatedAt,
      ...timing,
      animationFrameSource,
      renderCpuMs: report.cpuMs,
      gpuSubmitJsMs: report.submitMs,
      renderCpuAndSubmitMs: report.totalMs,
      backend: nv.backend,
    }
  } finally {
    activeFrameTiming = null
    pendingFrameResolve = null
  }
}

function resize(width, height) {
  if (!canvas || !nv?.view) return
  if (canvas.width === width && canvas.height === height) return
  canvas.width = width
  canvas.height = height
  nv.view.resize()
  nv.drawScene()
}

self.onmessage = (event) => {
  const message = event.data
  if (message.type === 'resetCallbackTiming') {
    lastAnimationCallbackAt = null
    return
  }
  if (message.type === 'windowLatest') {
    message.receivedAt = performance.now()
    latestWindowMessage = message
    void drainWindowUpdates()
    return
  }
  if (message.type === 'resize') {
    resize(message.width, message.height)
    return
  }
  void (async () => {
    try {
      if (message.type === 'initialize') {
        reply(message.id, await initialize(message))
      } else if (message.type === 'probeNativeFrames') {
        reply(message.id, await probeNativeFrames())
      } else if (message.type === 'loadVolume') {
        reply(message.id, await loadVolume(message.file))
      } else if (message.type === 'setWindow') {
        reply(message.id, await setWindow(message.window))
      } else {
        throw new Error(`Unknown worker request: ${message.type}`)
      }
    } catch (error) {
      replyError(message.id, error)
    }
  })()
}
