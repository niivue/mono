// Smoke test for detached-header deferred 4D reload.
//
// Load DT_V1 (AFNI .HEAD + .BRIK pair, 3-component vector → 4D with 3 frames)
// using limitFrames4D=1, then trigger loadDeferred4DVolumes from the button.
//
// Before the _urlImageData fix: the deferred call routes loadVolume(.HEAD) with
// no pairedImgData, so the AFNI reader throws "pairedImgData not set" and the
// status line reports the error.
// After the fix: loadVolume re-receives the .BRIK URL, the reload succeeds, and
// nFrame4D goes 1 → 3.
import NiiVue from '../src/index.ts'

const statusEl = document.getElementById('status')
const btn = document.getElementById('reloadBtn')
const nextBtn = document.getElementById('nextFrameBtn')

function status(msg) {
  statusEl.textContent = ` ${msg}`
}

const nv = new NiiVue({
  backgroundColor: [0, 0, 0, 1],
  isColorbarVisible: false,
})
nv.addEventListener('locationChange', (e) => {
  document.getElementById('location').innerHTML =
    `&nbsp;&nbsp;${e.detail.string}`
})
await nv.attachTo('gl1')

await nv.loadVolumes([
  {
    url: '/volumes/afni/DT_V1+orig.HEAD',
    urlImageData: '/volumes/afni/DT_V1+orig.BRIK.gz',
    limitFrames4D: 1,
    opacity: 1,
  },
])

const vol0 = nv.volumes[0]
status(
  `loaded: nFrame4D=${vol0?.nFrame4D} nTotalFrame4D=${vol0?.nTotalFrame4D} ` +
    `(expect 1 / 3 before reload)`,
)

btn.onclick = async () => {
  const v = nv.volumes[0]
  if (!v?.id) {
    status('no volume to reload')
    return
  }
  btn.disabled = true
  status('reloading deferred frames…')
  try {
    await nv.loadDeferred4DVolumes(v.id)
    const after = nv.volumes[0]
    status(
      `after: nFrame4D=${after?.nFrame4D} nTotalFrame4D=${after?.nTotalFrame4D} ` +
        `(expect 3 / 3)`,
    )
  } catch (err) {
    status(`reload failed: ${err?.message ?? err}`)
    console.error(err)
  } finally {
    btn.disabled = false
  }
}

// Cycle through loaded frames: with limitFrames4D=1 and no reload the only
// reachable frame is 0; after a successful deferred reload all three frames
// (0, 1, 2) are addressable. The button wraps via `% nFrame4D` so it always
// lands on an in-memory frame — setFrame4D would otherwise clamp the request
// down to nFrame4D-1 and silently appear stuck.
nextBtn.onclick = async () => {
  const v = nv.volumes[0]
  if (!v?.id) {
    status('no volume to cycle')
    return
  }
  const frames = v.nFrame4D ?? 1
  if (frames < 1) {
    status('no frames loaded yet')
    return
  }
  const next = ((v.frame4D ?? 0) + 1) % frames
  await nv.setFrame4D(v.id, next)
  // Clamp the displayed upper bound to the in-memory range; even though
  // `frames < 1` is gated above, this keeps the on-screen string honest
  // if a future fail-safe leaves the volume at zero frames.
  const upper = Math.max(0, frames - 1)
  status(`frame ${nv.volumes[0]?.frame4D} / ${upper} (cycle of ${frames})`)
}
