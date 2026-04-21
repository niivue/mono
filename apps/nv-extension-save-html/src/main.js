/**
 * Demo: Save NiiVue scene as a self-contained HTML file.
 *
 * 1. Loads a volume in NiiVue.
 * 2. Fetches the self-contained niivue bundle (built by vite.config.standalone.js).
 * 3. On button click, calls saveHTML() to download the scene as HTML.
 */
import NiiVueGPU from '@niivue/niivue'
import { saveHTML } from '@niivue/nv-save-html'

const status = document.getElementById('status')
const saveBtn = document.getElementById('saveBtn')
const sliceTypeSelect = document.getElementById('sliceType')

// --- Initialize NiiVue ---
const nv = new NiiVueGPU()
await nv.attachTo('gl1')
nv.sliceType = 3 // A+C+S+R

// --- Load a sample volume ---
status.textContent = 'Loading volume…'
await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
status.textContent = 'Volume loaded.'

// --- Fetch the standalone niivue bundle (built at build time) ---
status.textContent = 'Fetching niivue bundle…'
let bundleSource = null
try {
  const resp = await fetch('/niivue-standalone.js')
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
  bundleSource = await resp.text()
  status.textContent = `Ready — bundle size: ${(bundleSource.length / 1024).toFixed(0)} KB`
  saveBtn.disabled = false
} catch (err) {
  status.textContent = `⚠️ Could not load niivue bundle: ${err.message}`
  console.error('Failed to load standalone bundle:', err)
}

// --- View controls ---
sliceTypeSelect.addEventListener('change', () => {
  nv.sliceType = Number(sliceTypeSelect.value)
})

// --- Save as HTML ---
saveBtn.addEventListener('click', async () => {
  if (!bundleSource) return
  status.textContent = 'Generating HTML…'
  try {
    await saveHTML(nv, 'niivue-scene.html', {
      niivueBundleSource: bundleSource,
      title: 'NiiVue Scene Export',
    })
    status.textContent = 'HTML saved!'
  } catch (err) {
    status.textContent = `⚠️ Save failed: ${err.message}`
    console.error('Save HTML failed:', err)
  }
})
