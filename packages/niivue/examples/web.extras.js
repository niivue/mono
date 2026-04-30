import NiiVue from '../src/index.ts'
import { SHOW_RENDER } from '../src/NVConstants.ts'

// Load from the community asset repositories rather than bundling.
// All four base URLs below serve a `manifest.json` listing available
// files, plus the files themselves.
const VOLUME_BASE =
  'https://raw.githubusercontent.com/niivue/niivue-demo-images/main/'
const FONT_BASE = 'https://raw.githubusercontent.com/niivue/fonts/main/fonts/'
const CMAP_BASE =
  'https://raw.githubusercontent.com/niivue/Py2NiiVueColormaps/main/SciPy/'
const MATCAP_BASE =
  'https://raw.githubusercontent.com/niivue/matcaps/main/matcaps/'
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
fontSlide.oninput = function () {
  nv1.fontScale = Number(this.value) * 0.01
  nv1.resize()
}
async function fetchManifest(baseUrl) {
  const resp = await fetch(`${baseUrl}manifest.json`)
  if (!resp.ok)
    throw new Error(
      `Failed to fetch ${baseUrl}manifest.json: ${resp.status} ${resp.statusText}`,
    )
  return resp.json()
}
function populateSelect(selectEl, items) {
  for (const item of items) {
    const opt = document.createElement('option')
    opt.textContent = item
    selectEl.appendChild(opt)
  }
}
// Fetch a manifest and populate the matching <select>. On failure, log and
// overwrite the hidden placeholder with a visible error message — a per-
// section failure leaves the other two sections usable instead of aborting
// the whole module with an unhandled top-level rejection.
async function populateFromManifest(selectEl, baseUrl, label) {
  try {
    populateSelect(selectEl, await fetchManifest(baseUrl))
  } catch (err) {
    console.error(`Could not load ${label} manifest from ${baseUrl}:`, err)
    selectEl.options[0].textContent = `(failed to load ${label} list)`
    selectEl.options[0].hidden = false
  }
}
const nv1 = new NiiVue({
  is3DCrosshairVisible: true,
  isColorbarVisible: true,
  crosshairGap: 6,
  showRender: SHOW_RENDER.ALWAYS,
  backgroundColor: [0.2, 0.2, 0.2, 1],
  volumeIllumination: 1.0,
})
await nv1.attachToCanvas(gl1)
nv1.setClipPlane([0, 180, 20])
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
// --- Volumes -------------------------------------------------------
await populateFromManifest(volumeSelect, VOLUME_BASE, 'volume')
volumeSelect.onchange = async () => {
  await nv1.removeAllVolumes()
  const base = VOLUME_BASE + volumeSelect.value
  await nv1.addVolume({ url: `${base}` })
}
// --- Fonts ---------------------------------------------------------
// setFontFromUrl({ atlas, metrics }) fetches the PNG + JSON pair and
// swaps the active font atlas. The PNG URL is kept verbatim and used
// as the GPU texture source, so the atlas texture loads lazily when
// the view next renders.
await populateFromManifest(fontSelect, FONT_BASE, 'font')
fontSelect.onchange = async () => {
  const base = FONT_BASE + fontSelect.value
  await nv1.setFontFromUrl({ atlas: `${base}.png`, metrics: `${base}.json` })
}
// --- Colormaps -----------------------------------------------------
// Lazy-load: populate the dropdown from the manifest but only fetch
// each LUT the first time the user selects it. Avoids hammering the
// server with ~N parallel requests on page load and demonstrates the
// intended happy path for addColormapFromUrl. `nv1.colormaps` is
// consulted to skip re-registration on second-visit selections.
await populateFromManifest(cmapSelect, CMAP_BASE, 'colormap')
cmapSelect.onchange = async () => {
  const name = cmapSelect.value
  if (!nv1.hasColormap(name)) {
    try {
      await nv1.addColormapFromUrl(`${CMAP_BASE}${name}.json`, name)
    } catch (err) {
      console.error(`Failed to load colormap "${name}":`, err)
      return
    }
  }
  await nv1.setVolume(0, { colormap: name })
}
// --- Matcaps -------------------------------------------------------
// loadMatcap() accepts either a registered name or a direct URL. No
// pre-registration is required for URL-based matcaps.
await populateFromManifest(matSelect, MATCAP_BASE, 'matcap')
matSelect.onchange = async () => {
  await nv1.loadMatcap(`${MATCAP_BASE}${matSelect.value}.jpg`)
  mat2Select.selectedIndex = -1
}
// Third-party matcap collection (makio135) — demonstrates loading from
// an unrelated origin. The list below is hand-curated since that host
// does not publish a manifest.
const mat2Items = [
  '302721_CAC1BB_7A706A_91959B',
  '0404E8_0404B5_0404CB_3333FC',
  '045C5C_0DBDBD_049393_04A4A4',
  '046363_0CC3C3_049B9B_04ACAC',
  '0489C5_0DDDF9_04C3EE_04AFE1',
  '04989A_0CE3E4_04D2D5_04C7C8',
  '04C455_0EFABC_04F097_04E17A',
  '04CC77_0CF7CA_04E9A7_04AB54',
  '04E804_04B504_04CB04_33FC33',
  '04E8E8_04B5B5_04CCCC_33FCFC',
  '050505_747474_4C4C4C_333333',
  '070B0C_B2C7CE_728FA3_5B748B',
  '090909_9C9C9C_555555_7C7C7C',
  '0A0A0A_A9A9A9_525252_747474',
  '0C0CC3_04049F_040483_04045C',
  '0C430C_257D25_439A43_3C683C',
  '0D0DBD_040497_04047B_040455',
  '0D0DE3_040486_0404AF_0404CF',
  '0DBD0D_049704_047B04_045504',
  '0F0F0F_4B4B4B_1C1C1C_2C2C2C',
  '0F990F_047B04_044604_046704',
]
populateSelect(mat2Select, mat2Items)
mat2Select.onchange = async () => {
  await nv1.loadMatcap(
    `https://makio135.com/matcaps/64/${mat2Select.value}-64px.png`,
  )
  matSelect.selectedIndex = -1
}
