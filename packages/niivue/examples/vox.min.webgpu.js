import NiiVue from '../src/index.webgpu.ts'

const gl1 = document.getElementById('gl1')

// WebKit (Safari, and every iOS browser) runs WebGPU about 4x slower with
// anti-aliasing on (#381), so it is off there and on elsewhere (as slides.js).
const isWebKit =
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\//.test(navigator.userAgent) // iOS Edge (EdgiOS) is WebKit
const nv1 = new NiiVue({ isAntiAlias: !isWebKit })
await nv1.attachToCanvas(gl1)
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
