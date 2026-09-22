// Volume interpolation workbench: hardware trilinear vs tricubic B-spline.
//
// Two audiences:
//   - debugging. When a 3D render looks wrong, the reconstruction filter is one
//     of the first suspects and one of the hardest to judge by eye, because the
//     two filters differ by a fraction of a gray level per pixel. This page pins
//     everything except the filter so the difference is attributable.
//   - figures. `volumeIsCubicInterpolation` is off by default (it costs roughly
//     2x in the fine ray-march), but for a still image destined for a paper or a
//     slide the cost is irrelevant and the C2 reconstruction is visibly cleaner.
//     Set the camera, turn the filter on, and export the PNG.
//
// What the filter does and does not fix: trilinear is only C0, so a band edge
// crossing the voxel grid carries a blocky texel staircase. The cubic B-spline
// is C2 and removes that staircase. It is APPROXIMATING, not interpolating, so
// it cannot overshoot and cannot ring -- which also means it does not remove
// ringing that is already in the data. If concentric rings survive the switch,
// they are in the reconstruction, not in the sampling.
//
// Add `?backend=webgpu` to the URL for the WebGPU renderer.

import NiiVue, { SHOW_RENDER, SLICE_TYPE } from '../src/index.ts'

const backend =
  new URLSearchParams(location.search).get('backend') === 'webgpu'
    ? 'webgpu'
    : 'webgl2'

const el = (id) => document.getElementById(id)

const els = {
  canvas: el('gl1'),
  volume: el('volume'),
  interp: el('interp'),
  ab: el('ab'),
  splitCtl: el('splitCtl'),
  split: el('split'),
  splitVal: el('splitVal'),
  samples: el('samples'),
  samplesVal: el('samplesVal'),
  illum: el('illum'),
  illumVal: el('illumVal'),
  measure: el('measure'),
  savePng: el('savePng'),
  abOverlay: el('ab-overlay'),
  abBadge: el('ab-badge'),
  status: el('status'),
}

let nv = null
let busy = false

function setStatus(text) {
  els.status.textContent = text
}

// --------------------------------------------------------------------------
// Render settings

function applySampleRate() {
  const rate = Number(els.samples.value) || 1
  els.samplesVal.textContent = rate.toFixed(1)
  if (!nv) return
  // Pure render-time setting: the setter already redraws.
  nv.volumeSampleRate = rate
}

function applyIllumination() {
  const amount = Number(els.illum.value) || 0
  els.illumVal.textContent = amount.toFixed(2)
  if (!nv) return
  nv.volumeIllumination = amount
}

// The one setting this page exists to exercise. 8 texture fetches per sample
// instead of 1, so pair it with a lower sample rate if fill rate matters.
function applyInterp() {
  if (!nv) return
  nv.volumeIsCubicInterpolation = els.interp.value === 'cubic'
  scheduleAbCapture()
}

// --------------------------------------------------------------------------
// A/B filter comparison
//
// Judging the two filters across a control change relies on memory of the
// previous frame and is not trustworthy. Both modes pin everything else:
//
//   split -- draw the SAME frame twice back to back inside ONE animation frame,
//            changing only the uniform between the two view.render() calls, and
//            snapshot each. Camera, window and lighting are identical by
//            construction: nothing runs between the two draws.
//   flip  -- leave the live render alone and toggle the filter on a timer, so
//            the eye does the differencing instead of memory.
//
// The overlay canvas takes no pointer events and the divider is a header slider,
// so nothing on the canvas competes with the camera: the volume rotates, pans
// and zooms normally under a split. Any such interaction drops straight back to
// the live render (the captured pair is stale the moment the camera moves) and
// re-snapshots once the interaction settles.
const AB_FLIP_MS = 700
const AB_CAPTURE_DEBOUNCE_MS = 220

const ab = {
  mode: 'off',
  a: null,
  b: null,
  split: 0.5,
  flipTimer: 0,
  flipCubic: false,
  capturing: false,
  again: false,
  captureTimer: 0,
}

function setAbMode(mode) {
  if (ab.flipTimer) {
    clearInterval(ab.flipTimer)
    ab.flipTimer = 0
  }
  ab.mode = mode
  els.abBadge.classList.toggle('on', mode === 'flip')
  els.splitCtl.hidden = mode !== 'split'
  if (mode === 'split') {
    // The overlay reveals itself once there is a pair to show (drawAbSplit).
    scheduleAbCapture()
    return
  }
  els.abOverlay.classList.remove('on')
  ab.a = null
  ab.b = null
  if (mode === 'flip') {
    ab.flipCubic = true
    tickAbFlip()
    ab.flipTimer = window.setInterval(tickAbFlip, AB_FLIP_MS)
    return
  }
  els.abBadge.textContent = ''
  // Hand the filter back to the Interp selector.
  applyInterp()
}

function tickAbFlip() {
  if (!nv) return
  ab.flipCubic = !ab.flipCubic
  nv.volumeIsCubicInterpolation = ab.flipCubic
  els.abBadge.textContent = ab.flipCubic ? 'cubic B-spline' : 'linear'
  els.abBadge.style.color = ab.flipCubic ? '#9cdc85' : '#e2b85f'
}

// Called whenever something invalidates the captured pair. The overlay hides at
// once so the user sees the LIVE render while they drag, and drawAbSplit brings
// it back when the new pair lands.
function scheduleAbCapture() {
  if (ab.mode !== 'split') return
  els.abOverlay.classList.remove('on')
  if (ab.captureTimer) clearTimeout(ab.captureTimer)
  ab.captureTimer = window.setTimeout(() => {
    ab.captureTimer = 0
    captureAbPair()
  }, AB_CAPTURE_DEBOUNCE_MS)
}

// Snapshot the drawing buffer with one filter. Neither backend preserves the
// drawing buffer, so the copy has to happen in the same task as the draw.
function snapshotWith(cubic) {
  nv.volumeIsCubicInterpolation = cubic
  nv.view.render()
  const src = els.canvas
  const off = document.createElement('canvas')
  off.width = src.width
  off.height = src.height
  off.getContext('2d').drawImage(src, 0, 0)
  return off
}

function captureAbPair() {
  if (!nv || ab.mode !== 'split') return
  if (ab.capturing) {
    ab.again = true
    return
  }
  ab.capturing = true
  requestAnimationFrame(() => {
    const wanted = els.interp.value === 'cubic'
    try {
      ab.a = snapshotWith(false)
      ab.b = snapshotWith(true)
    } catch (err) {
      ab.a = null
      ab.b = null
      console.warn('A/B capture failed', err)
    } finally {
      // Leave the live render on whatever the Interp selector asks for, so
      // turning the split off does not silently change the picture.
      nv.volumeIsCubicInterpolation = wanted
      ab.capturing = false
    }
    drawAbSplit()
    if (ab.again) {
      ab.again = false
      scheduleAbCapture()
    }
  })
}

function abLabel(ctx, text, x, y, scale, align) {
  const fs = Math.max(10, Math.round(13 * scale))
  const pad = Math.round(6 * scale)
  ctx.font = `${fs}px ui-monospace, monospace`
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  const tw = ctx.measureText(text).width
  const bx = align === 'left' ? x - pad : x - tw - pad
  ctx.fillStyle = 'rgba(5, 8, 8, 0.82)'
  ctx.fillRect(bx, y - fs, tw + pad * 2, fs * 2)
  ctx.fillStyle = '#edf4f1'
  ctx.fillText(text, x, y)
}

function drawAbSplit() {
  if (ab.mode !== 'split') return
  if (!ab.a || !ab.b) return
  const c = els.abOverlay
  const w = ab.a.width
  const h = ab.a.height
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  const ctx = c.getContext('2d')
  const x = Math.round(w * ab.split)
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(ab.a, 0, 0, x, h, 0, 0, x, h)
  ctx.drawImage(ab.b, x, 0, w - x, h, x, 0, w - x, h)
  ctx.fillStyle = 'rgba(122, 215, 209, 0.85)'
  ctx.fillRect(x - 1, 0, 2, h)
  // The backing store is device pixels; scale the chrome to match.
  const scale = c.clientWidth > 0 ? w / c.clientWidth : 1
  // Flank the divider rather than the frame corners: a label at the seam is
  // unambiguous about which side it names. Near the TOP because the bottom of
  // this page carries the colorbar and the orientation cube. A label runs
  // off-canvas once the divider reaches that edge, which is fine -- that side
  // has no image left to name.
  const y = Math.round(28 * scale)
  const gap = Math.round(10 * scale)
  abLabel(ctx, 'linear', x - gap, y, scale, 'right')
  abLabel(ctx, 'cubic B-spline', x + gap, y, scale, 'left')
  c.classList.add('on')
}

// Slider-driven divider. Repositioning the wipe only re-blits the two captures,
// so it needs no re-render and stays smooth during a drag.
function applySplit() {
  const pct = Number(els.split.value) || 50
  els.splitVal.textContent = `${Math.round(pct)}%`
  ab.split = pct / 100
  drawAbSplit()
}

// --------------------------------------------------------------------------
// Benchmark
//
// Sustained RAF loop rather than a burst: both backends pipeline, so a batch of
// synchronous draws measures how fast the queue fills, not how fast it drains.
// The flip side is that a frame cheaper than the display refresh reports the
// refresh interval, so the readout says so instead of pretending to a number.

const BENCH_WARM = 20
const BENCH_FRAMES = 90

function renderFrames(n) {
  return new Promise((resolve) => {
    let i = 0
    const step = () => {
      nv.view.render()
      i += 1
      if (i >= n) {
        resolve()
        return
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
}

async function timeFilter(cubic) {
  nv.volumeIsCubicInterpolation = cubic
  await renderFrames(BENCH_WARM)
  const t0 = performance.now()
  await renderFrames(BENCH_FRAMES)
  return (performance.now() - t0) / BENCH_FRAMES
}

async function runBenchmark() {
  if (!nv || busy) return
  busy = true
  const wasAb = els.ab.value
  const wanted = els.interp.value === 'cubic'
  els.measure.disabled = true
  setStatus('measuring...')
  try {
    // The A/B modes drive the filter themselves, so park them for the run.
    if (wasAb !== 'off') setAbMode('off')
    const lin = await timeFilter(false)
    const cub = await timeFilter(true)
    const rate = Number(els.samples.value) || 1
    const vsync = Math.min(lin, cub) < 17.5
    setStatus(
      `${backend} @ ${els.canvas.width}x${els.canvas.height}, samples ${rate.toFixed(1)}: ` +
        `linear ${lin.toFixed(2)} ms/frame, cubic ${cub.toFixed(2)} ms/frame ` +
        `(${(cub / lin).toFixed(2)}x)` +
        (vsync
          ? ' -- at the refresh rate, so raise samples or the window size for a real number'
          : ''),
    )
  } finally {
    nv.volumeIsCubicInterpolation = wanted
    if (wasAb !== 'off') setAbMode(wasAb)
    els.measure.disabled = false
    busy = false
  }
}

// --------------------------------------------------------------------------
// PNG export
//
// There is no controller-level snapshot API, and neither backend preserves the
// drawing buffer, so the copy has to happen in the same task as the draw. With
// a split up the composite IS the deliverable, so export that instead.

function downloadCanvas(canvas, name) {
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}

function savePng() {
  if (!nv) return
  if (ab.mode === 'split' && ab.a && ab.b) {
    downloadCanvas(els.abOverlay, 'niivue-interp-split.png')
    return
  }
  const cubic = nv.volumeIsCubicInterpolation
  requestAnimationFrame(() => {
    nv.view.render()
    const off = document.createElement('canvas')
    off.width = els.canvas.width
    off.height = els.canvas.height
    off.getContext('2d').drawImage(els.canvas, 0, 0)
    downloadCanvas(off, `niivue-interp-${cubic ? 'cubic' : 'linear'}.png`)
  })
}

// --------------------------------------------------------------------------

async function loadSelectedVolume() {
  if (!nv || busy) return
  busy = true
  els.volume.disabled = true
  setStatus('loading...')
  try {
    await nv.loadVolumes([{ url: els.volume.value }])
    setStatus(describeVolume())
  } catch (err) {
    setStatus(`load failed: ${err?.message ?? err}`)
  } finally {
    els.volume.disabled = false
    busy = false
  }
  scheduleAbCapture()
}

function describeVolume() {
  const vol = nv.volumes[0]
  if (!vol) return `${backend}: no volume`
  const d = vol.hdr?.dims ?? []
  return `${backend} - ${vol.name ?? ''} ${d[1]}x${d[2]}x${d[3]} - drag to rotate, wheel to zoom`
}

async function main() {
  nv = new NiiVue({
    backend,
    backgroundColor: [0.02, 0.03, 0.03, 1],
    isColorbarVisible: true,
    sliceType: SLICE_TYPE.RENDER,
    showRender: SHOW_RENDER.ALWAYS,
  })
  await nv.attachToCanvas(els.canvas)
  await nv.loadVolumes([{ url: els.volume.value }])
  setStatus(describeVolume())

  // Browsers restore a control's value across a reload, so push the current
  // positions into the fresh instance rather than assuming the defaults.
  applySampleRate()
  applyIllumination()
  applyInterp()
  applySplit()
  // A restored 'split' must re-arm the overlay, or the page comes up showing a
  // mode the control claims is active but nothing is.
  setAbMode(els.ab.value)

  els.volume.addEventListener('change', loadSelectedVolume)
  els.interp.addEventListener('change', applyInterp)
  els.ab.addEventListener('change', () => setAbMode(els.ab.value))
  els.split.addEventListener('input', applySplit)
  els.samples.addEventListener('input', applySampleRate)
  els.illum.addEventListener('input', applyIllumination)
  els.measure.addEventListener('click', runBenchmark)
  els.savePng.addEventListener('click', savePng)

  // Any control except the divider invalidates the captured pair: the divider
  // only re-blits what is already captured.
  const headerInvalidates = (e) => {
    if (e.target !== els.split) scheduleAbCapture()
  }
  const header = document.querySelector('header')
  header.addEventListener('change', headerInvalidates)
  header.addEventListener('input', headerInvalidates)
  window.addEventListener('resize', scheduleAbCapture)
  // Rotating/panning: show the live render for the whole drag, then re-snapshot.
  els.canvas.addEventListener('pointerdown', () => {
    if (ab.mode === 'split') els.abOverlay.classList.remove('on')
  })
  els.canvas.addEventListener('pointerup', scheduleAbCapture)
  els.canvas.addEventListener('wheel', scheduleAbCapture, { passive: true })
}

main().catch((err) => {
  console.error(err)
  setStatus(`failed: ${err?.message ?? err}`)
})
