import type { ImageFromUrlOptions, NVImage } from '@niivue/niivue'
import {
  DRAG_MODE,
  defaultSliceLayouts,
  type NiivueSceneElement,
  type NiivueViewerElement,
  SLICE_TYPE,
} from '@niivue/nv-web-component'
import '@niivue/nv-web-component'
import './styles.css'

const mniVolumeName = 'MNI152'
const mniVolumeUrl = '/volumes/mni152.nii.gz'

const mniVolume: ImageFromUrlOptions = {
  url: mniVolumeUrl,
  name: mniVolumeName,
  colormap: 'gray',
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Element #${id} not found`)
  }
  return element as T
}

const viewer = getElement<NiivueViewerElement>('viewer')
const scene = getElement<NiivueSceneElement>('scene')
const loadViewerBtn = getElement<HTMLButtonElement>('loadViewerBtn')
const clearViewerBtn = getElement<HTMLButtonElement>('clearViewerBtn')
const layoutSelect = getElement<HTMLSelectElement>('layoutSelect')
const broadcastingCheckbox = getElement<HTMLInputElement>(
  'broadcastingCheckbox',
)
const loadSceneBtn = getElement<HTMLButtonElement>('loadSceneBtn')
const colormapSelect = getElement<HTMLSelectElement>('colormapSelect')
const dragModeSelect = getElement<HTMLSelectElement>('dragModeSelect')
const sliceLayoutSelect = getElement<HTMLSelectElement>('sliceLayoutSelect')
const colorbarCheckbox = getElement<HTMLInputElement>('colorbarCheckbox')
const crosshairCheckbox = getElement<HTMLInputElement>('crosshairCheckbox')

viewer.sliceType = SLICE_TYPE.AXIAL
viewer.options = { crosshairGap: 5 }

function log(message: string): void {
  console.info(message)
}

function selectedDragMode(): number {
  switch (dragModeSelect.value) {
    case 'pan':
      return DRAG_MODE.pan
    case 'contrast':
      return DRAG_MODE.contrast
    case 'none':
      return DRAG_MODE.none
    default:
      return DRAG_MODE.crosshair
  }
}

async function applyViewerSettings(): Promise<void> {
  await viewer.setColormap(0, colormapSelect.value)
  viewer.setColorbarVisible(colorbarCheckbox.checked)
  viewer.setCrosshairVisible(crosshairCheckbox.checked)
  viewer.setPrimaryDragMode(selectedDragMode())
}

async function applySceneSettings(): Promise<void> {
  await Promise.all([
    ...sceneViewerIndexes().map((index) =>
      scene.setColormap(index, 0, colormapSelect.value),
    ),
    applySceneSliceLayouts(),
  ])
  scene.setColorbarVisible(colorbarCheckbox.checked)
  scene.setCrosshairVisible(crosshairCheckbox.checked)
  scene.setPrimaryDragMode(selectedDragMode())
}

async function applySceneSliceLayouts(): Promise<void> {
  const layout =
    sliceLayoutSelect.value === 'default'
      ? null
      : defaultSliceLayouts[sliceLayoutSelect.value]?.layout
  await Promise.all(
    sceneViewerIndexes().map((index) =>
      scene.setViewerSliceLayout(index, layout ?? null),
    ),
  )
}

function sceneViewerIndexes(): number[] {
  return Array.from(
    { length: scene.snapshot.viewerCount },
    (_value, index) => index,
  )
}

async function applySettings(): Promise<void> {
  await Promise.all([applyViewerSettings(), applySceneSettings()])
  log('Applied viewer settings.')
}

function hasMniVolume(volumes: readonly NVImage[]): boolean {
  return volumes.some(
    (volume) => volume.name === mniVolumeName || volume.url === mniVolumeUrl,
  )
}

async function fetchMniFile(): Promise<File> {
  const response = await fetch(mniVolumeUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch MNI152: ${response.status}`)
  }
  const blob = await response.blob()
  return new File([blob], 'mni152.nii.gz', { type: 'application/gzip' })
}

loadViewerBtn.onclick = async () => {
  try {
    if (viewer.nv && hasMniVolume(viewer.nv.volumes)) {
      await applyViewerSettings()
      log('MNI152 is already loaded in the standalone viewer.')
      return
    }

    const file = await fetchMniFile()
    viewer.volumes = [{ ...mniVolume, url: file }]
    log(
      'Fetched MNI152 with fetch() and loaded the File in the standalone viewer.',
    )
  } catch (error) {
    console.error(error)
    log('Failed to fetch MNI152. See the browser console for details.')
  }
}

clearViewerBtn.onclick = () => {
  viewer.volumes = []
  log('Standalone viewer volumes cleared.')
}

layoutSelect.onchange = () => {
  scene.layout = layoutSelect.value
  log(`Scene layout changed to ${scene.layout}.`)
}

broadcastingCheckbox.onchange = () => {
  scene.broadcasting = broadcastingCheckbox.checked
  log(`Scene broadcasting ${scene.broadcasting ? 'enabled' : 'disabled'}.`)
}

loadSceneBtn.onclick = async () => {
  try {
    const viewerCount = scene.snapshot.viewerCount
    await Promise.all(
      sceneViewerIndexes().map((index) => {
        const niivue = scene.scene.getNiivue(index)
        if (niivue && hasMniVolume(niivue.volumes)) {
          return Promise.resolve(undefined)
        }
        return scene.loadVolume(index, mniVolume)
      }),
    )
    await applySceneSettings()
    log(`Loaded MNI152 into ${viewerCount} scene viewer(s).`)
  } catch (error) {
    console.error(error)
    log('Failed to load scene volumes. See the browser console for details.')
  }
}

colormapSelect.onchange = () => {
  applySettings().catch((error: unknown) => {
    console.error(error)
    log('Failed to apply colormap. See the browser console for details.')
  })
}

colorbarCheckbox.onchange = () => {
  applySettings().catch((error: unknown) => {
    console.error(error)
    log(
      'Failed to apply colorbar setting. See the browser console for details.',
    )
  })
}

crosshairCheckbox.onchange = () => {
  applySettings().catch((error: unknown) => {
    console.error(error)
    log(
      'Failed to apply crosshair setting. See the browser console for details.',
    )
  })
}

dragModeSelect.onchange = () => {
  applySettings().catch((error: unknown) => {
    console.error(error)
    log('Failed to apply drag mode. See the browser console for details.')
  })
}

sliceLayoutSelect.onchange = () => {
  applySceneSliceLayouts()
    .then(() => log(`Applied ${sliceLayoutSelect.value} slice layout.`))
    .catch((error: unknown) => {
      console.error(error)
      log('Failed to apply slice layout. See the browser console for details.')
    })
}

viewer.addEventListener('image-loaded', (event) => {
  const volume = (event as CustomEvent<{ name?: string }>).detail
  log(`Standalone image loaded: ${volume.name ?? 'unnamed volume'}.`)
})

viewer.addEventListener('location-change', (event) => {
  const location = (event as CustomEvent<{ string?: string }>).detail
  if (location.string) {
    console.info(location.string)
  }
})

scene.addEventListener('scene-change', (event) => {
  const snapshot = (event as CustomEvent<NiivueSceneElement['snapshot']>).detail
  console.info('Scene changed', snapshot)
})

scene.addEventListener('image-loaded', (event) => {
  const detail = (
    event as CustomEvent<{
      viewerIndex: number
      volume: { name?: string }
    }>
  ).detail
  log(
    `Scene viewer ${detail.viewerIndex} loaded ${detail.volume.name ?? 'a volume'}.`,
  )
})

for (const element of [viewer, scene]) {
  element.addEventListener('niivue-error', (event) => {
    console.error((event as CustomEvent<unknown>).detail)
    log('NiiVue error. See the browser console for details.')
  })
}

await customElements.whenDefined('niivue-viewer')
await customElements.whenDefined('niivue-scene')
