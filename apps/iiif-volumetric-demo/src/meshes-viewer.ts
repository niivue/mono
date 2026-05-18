// Mesh demo page for the iiif-volumetric-demo app.
//
// All assets are served by the `devImagesPlugin` Vite plugin (see
// vite.config.ts), which exposes `@niivue/dev-images` under `/meshes/*`.
// This page deliberately does not talk to the IIIF server — it just
// drives niivue's mesh, tract and connectome APIs.

import type { MeshFromUrlOptions } from '@niivue/niivue'
import NiiVue from '@niivue/niivue'

interface ViewerState {
  nv: NiiVue | null
  meshName: string
  tractName: string
  connectomeName: string
  layerCurv: boolean
  layerMotor: boolean
  opacity: number
  xray: number
  thickness: number
  sliceType: number
  backend: 'webgpu' | 'webgl2'
}

const state: ViewerState = {
  nv: null,
  meshName: 'inflated',
  tractName: '',
  connectomeName: '',
  layerCurv: false,
  layerMotor: false,
  opacity: 1,
  xray: 0,
  thickness: 200,
  sliceType: 4,
  backend: 'webgpu',
}

;(window as unknown as { __meshState: ViewerState }).__meshState = state

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  niivuePill: el<HTMLSpanElement>('niivuePill'),
  meshSelect: el<HTMLSelectElement>('meshSelect'),
  shaderSelect: el<HTMLSelectElement>('shaderSelect'),
  layerToggle: el<HTMLInputElement>('layerToggle'),
  motorToggle: el<HTMLInputElement>('motorToggle'),
  opacityRange: el<HTMLInputElement>('opacityRange'),
  opacityVal: el<HTMLSpanElement>('opacityVal'),
  xrayRange: el<HTMLInputElement>('xrayRange'),
  xrayVal: el<HTMLSpanElement>('xrayVal'),
  thicknessRange: el<HTMLInputElement>('thicknessRange'),
  thicknessVal: el<HTMLSpanElement>('thicknessVal'),
  tractSelect: el<HTMLSelectElement>('tractSelect'),
  connectomeSelect: el<HTMLSelectElement>('connectomeSelect'),
  sliceType: el<HTMLSelectElement>('sliceType'),
  backendCheck: el<HTMLInputElement>('backendCheck'),
  status: el<HTMLDivElement>('status'),
}

const THICKNESS_MAX = 200

main().catch((err: unknown) => {
  console.error(err)
  setStatus(`Error: ${errMsg(err)}`)
})

async function main(): Promise<void> {
  state.nv = new NiiVue({
    backgroundColor: [0.05, 0.05, 0.07, 1],
    isColorbarVisible: true,
    isDragDropEnabled: false,
  })
  state.nv.opts.isDragDropEnabled = false
  await state.nv.attachToCanvas(els.canvas)
  state.nv.sliceType = state.sliceType
  els.niivuePill.textContent = 'niivue · ready'
  els.niivuePill.classList.add('green')

  populateShaderSelect()
  wireControls()
  await refreshScene()
}

function populateShaderSelect(): void {
  const nv = state.nv
  if (!nv) return
  els.shaderSelect.innerHTML = ''
  const shaders = nv.meshShaders ?? []
  for (const shader of shaders) {
    const opt = document.createElement('option')
    opt.value = shader
    opt.textContent = shader.charAt(0).toUpperCase() + shader.slice(1)
    if (shader === 'phong') opt.selected = true
    els.shaderSelect.appendChild(opt)
  }
}

function wireControls(): void {
  els.meshSelect.addEventListener('change', () => {
    state.meshName = els.meshSelect.value
    void refreshScene()
  })

  els.shaderSelect.addEventListener('change', () => {
    void applyShader()
  })

  els.layerToggle.addEventListener('change', () => {
    state.layerCurv = els.layerToggle.checked
    void refreshScene()
  })

  els.motorToggle.addEventListener('change', () => {
    state.layerMotor = els.motorToggle.checked
    void refreshScene()
  })

  els.opacityRange.addEventListener('input', () => {
    state.opacity = Number(els.opacityRange.value)
    els.opacityVal.textContent = state.opacity.toFixed(2)
    void applyOpacity()
  })

  els.xrayRange.addEventListener('input', () => {
    state.xray = Number(els.xrayRange.value)
    els.xrayVal.textContent = state.xray.toFixed(2)
    if (state.nv) state.nv.meshXRay = state.xray
  })

  els.thicknessRange.addEventListener('input', () => {
    state.thickness = Number(els.thicknessRange.value)
    const isInfinity = state.thickness >= THICKNESS_MAX
    els.thicknessVal.textContent = isInfinity ? '∞' : String(state.thickness)
    if (state.nv) {
      state.nv.meshThicknessOn2D = isInfinity
        ? Number.POSITIVE_INFINITY
        : state.thickness
    }
  })

  els.tractSelect.addEventListener('change', () => {
    state.tractName = els.tractSelect.value
    void refreshScene()
  })

  els.connectomeSelect.addEventListener('change', () => {
    state.connectomeName = els.connectomeSelect.value
    void refreshScene()
  })

  els.sliceType.addEventListener('change', () => {
    state.sliceType = Number(els.sliceType.value)
    if (state.nv) state.nv.sliceType = state.sliceType
  })

  els.backendCheck.addEventListener('change', () => {
    const nextBackend: 'webgpu' | 'webgl2' = els.backendCheck.checked
      ? 'webgpu'
      : 'webgl2'
    if (nextBackend === state.backend || !state.nv) return
    state.backend = nextBackend
    void switchBackend(nextBackend)
  })
}

async function refreshScene(): Promise<void> {
  const nv = state.nv
  if (!nv) return
  setStatus('Loading…')
  try {
    const meshList = buildMeshList()
    await nv.loadMeshes(meshList)
    await applyShader()
    await applyOpacity()
    nv.meshXRay = state.xray
    nv.meshThicknessOn2D =
      state.thickness >= THICKNESS_MAX
        ? Number.POSITIVE_INFINITY
        : state.thickness
    setStatus(describeScene(meshList))
  } catch (err) {
    setStatus(`Error: ${errMsg(err)}`)
  }
}

function buildMeshList(): MeshFromUrlOptions[] {
  const items: MeshFromUrlOptions[] = []

  if (state.meshName) {
    const layers = [] as NonNullable<MeshFromUrlOptions['layers']>
    if (state.layerCurv && state.meshName === 'BrainMesh_ICBM152.lh') {
      layers.push({
        url: '/meshes/BrainMesh_ICBM152.lh.curv',
        colormap: 'gray',
        calMin: 0.3,
        calMax: 0.5,
        opacity: 1,
        isColorbarVisible: false,
      })
    }
    if (state.layerMotor && state.meshName === 'BrainMesh_ICBM152.lh') {
      layers.push({
        url: '/meshes/BrainMesh_ICBM152.lh.motor.mz3',
        calMin: 1.5,
        calMax: 5,
        calMinNeg: -1.5,
        calMaxNeg: -2,
        colormap: 'warm',
        colormapNegative: 'winter',
        opacity: 0.7,
      })
    }
    const meshOpts: MeshFromUrlOptions = {
      url: `/meshes/${state.meshName}.mz3`,
      opacity: state.opacity,
    }
    if (layers.length) meshOpts.layers = layers
    items.push(meshOpts)
  }

  if (state.tractName) {
    items.push({ url: `/meshes/${state.tractName}` })
  }

  if (state.connectomeName) {
    items.push({
      url: `/meshes/${state.connectomeName}`,
      isLegendVisible: true,
    })
  }

  return items
}

async function applyShader(): Promise<void> {
  const nv = state.nv
  if (!nv) return
  const meshes = nv.model.getMeshes()
  const shader = els.shaderSelect.value
  if (!shader) return
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i]
    if (!m || m.kind !== 'mesh') continue
    await nv.setMesh(i, { shaderType: shader })
  }
}

async function applyOpacity(): Promise<void> {
  const nv = state.nv
  if (!nv) return
  const meshes = nv.model.getMeshes()
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i]
    if (!m || m.kind !== 'mesh') continue
    await nv.setMesh(i, { opacity: state.opacity })
  }
}

async function switchBackend(backend: 'webgpu' | 'webgl2'): Promise<void> {
  const nv = state.nv
  if (!nv) return
  setStatus(`Switching to ${backend}…`)
  try {
    await nv.reinitializeView({ backend })
    populateShaderSelect()
    await refreshScene()
  } catch (err) {
    setStatus(`Backend switch failed: ${errMsg(err)}`)
  }
}

function describeScene(meshes: MeshFromUrlOptions[]): string {
  if (meshes.length === 0) return 'No meshes loaded.'
  return meshes
    .map((m) => {
      const url = typeof m.url === 'string' ? m.url : m.url.name
      const layerCount = m.layers?.length ?? 0
      return layerCount ? `${url} (+${layerCount} layer)` : url
    })
    .join(', ')
}

function setStatus(msg: string): void {
  els.status.textContent = msg
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
