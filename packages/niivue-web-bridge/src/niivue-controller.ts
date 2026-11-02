import type NiiVue from '@niivue/niivue'
import {
  lookupColorMap,
  type NVImage,
  type NVMesh,
  type VolumeUpdate,
} from '@niivue/niivue'
import type { Bridge } from './bridge'
import type { PropAllowlist } from './prop-allowlist'
import { wirePropBridge } from './prop-bridge'

export type LoadVolumePayload = {
  name: string
  bytesBase64: string
  /** Keep loaded images and add this one on top; otherwise replace them. */
  add?: boolean
}

export type SetBackendPayload = {
  backend: 'webgl2' | 'webgpu'
}

export type SetVolumePayload = { index: number } & Pick<
  VolumeUpdate,
  'colormap' | 'calMin' | 'calMax' | 'opacity'
>

/** Display state of one loaded volume, as sent to the native host. */
export type VolumeSummary = {
  name: string
  colormap: string
  /** Colormap control points as [position 0..1, r, g, b], for swatches. */
  colormapStops: number[][]
  calMin: number
  calMax: number
  /** Intensity range of the data, bounding the calMin/calMax controls. */
  globalMin: number
  globalMax: number
  opacity: number
  /** RAS dimensions [x, y, z] and voxel size in mm. */
  dims: number[]
  pixDims: number[]
}

/** One loaded mesh, as sent to the native host. */
export type MeshSummary = {
  name: string
}

export function meshSummaries(meshes: readonly NVMesh[]): MeshSummary[] {
  return meshes.map((m) => ({ name: m.name ?? 'Mesh' }))
}

function colormapStops(name: string): number[][] {
  const cm = lookupColorMap(name)
  if (!cm || cm.R.length < 2) return []
  const I = cm.I ?? cm.R.map((_, i) => (i * 255) / (cm.R.length - 1))
  const first = I[0]
  const span = I[I.length - 1] - first || 1
  return cm.R.map((r, i) => [
    (I[i] - first) / span,
    r / 255,
    cm.G[i] / 255,
    cm.B[i] / 255,
  ])
}

export function volumeSummaries(volumes: readonly NVImage[]): VolumeSummary[] {
  return volumes.map((v) => ({
    name: v.name,
    colormap: v.colormap ?? 'gray',
    colormapStops: colormapStops(v.colormap ?? 'gray'),
    calMin: v.calMin,
    calMax: v.calMax,
    globalMin: v.globalMin,
    globalMax: v.globalMax,
    opacity: v.opacity ?? 1,
    dims: (v.dimsRAS ?? v.hdr.dims).slice(1, 4),
    pixDims: (v.pixDimsRAS ?? v.hdr.pixDims).slice(1, 4),
  }))
}

export type WireNiiVueOptions = {
  /** Forwarded to `wirePropBridge`. */
  allowlist?: PropAllowlist
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

/**
 * Runs `load`, which adds to the scene. When `replace`, whatever was loaded
 * before is then removed, so a load that throws or adds nothing (NiiVue logs
 * some failures instead of throwing) keeps the old scene. Returns whether
 * anything new appeared.
 */
async function loadInto(
  nv: InstanceType<typeof NiiVue>,
  load: () => Promise<void>,
  replace: boolean,
): Promise<boolean> {
  const volumes = [...nv.volumes]
  const meshes = [...nv.meshes]
  const signals = [...nv.signals]
  await load()
  const hasNew = <T>(now: readonly T[], old: readonly T[]) =>
    now.some((item) => !old.includes(item))
  if (
    !hasNew(nv.volumes, volumes) &&
    !hasNew(nv.meshes, meshes) &&
    !hasNew(nv.signals, signals)
  ) {
    return false
  }
  if (!replace) return true
  // Highest index first, so earlier indices stay valid.
  for (let i = nv.volumes.length - 1; i >= 0; i--) {
    if (volumes.includes(nv.volumes[i])) await nv.removeVolume(i)
  }
  for (let i = nv.meshes.length - 1; i >= 0; i--) {
    if (meshes.includes(nv.meshes[i])) await nv.removeMesh(i)
  }
  for (let i = nv.signals.length - 1; i >= 0; i--) {
    if (signals.includes(nv.signals[i])) nv.removeSignal(i)
  }
  return true
}

/**
 * Loads one file. Without `add` it replaces every volume, mesh and signal,
 * not only its own kind. Throws when nothing loads.
 */
export async function loadFile(
  nv: InstanceType<typeof NiiVue>,
  file: File,
  add: boolean,
): Promise<void> {
  if (!(await loadInto(nv, () => nv.addImage(file), !add))) {
    throw new Error(`could not load ${file.name}`)
  }
}

/**
 * Loads dropped files with `nv.loadFiles` (documents, sidecar pairing). Every
 * file is added, and without `add` the previous scene is removed afterwards,
 * so a multi-file drop gives a base plus overlays. Failures are logged.
 */
export async function loadDroppedFiles(
  nv: InstanceType<typeof NiiVue>,
  files: readonly File[],
  add: boolean,
): Promise<void> {
  await loadInto(nv, () => nv.loadFiles(files, { add: true }), !add)
}

/**
 * Registers bridge handlers that drive the given NiiVue instance and
 * forwards niivue events back to the native host.
 *
 * Adds:
 *   - `loadVolume(name, bytesBase64, add)` -> `loadFile(File, add)`
 *   - `setBackend(backend)` -> `nv.reinitializeView({ backend })` (+ emits `backendChange`)
 *   - generic prop-bridge (setProp / getProps / propChange)
 *   - forwards successful image loads as `imageLoaded`
 *   - `getVolumes()`, `setVolume(index, ...)`, `removeVolume(index)`, `getColormaps()`
 *   - emits `volumesChange` with the volume list whenever it changes
 *   - `getMeshes()`, `removeMesh(index)`; emits `meshesChange` likewise
 *   - emits `signalsChange` with the signal count on each load or removal
 *   - forwards `locationChange` as an event with `{ mm, voxel, values, string }`
 */
export function wireNiiVueToBridge(
  nv: InstanceType<typeof NiiVue>,
  bridge: Bridge,
  options: WireNiiVueOptions = {},
): void {
  bridge.handle('loadVolume', async (raw) => {
    const { name, bytesBase64, add } = raw as LoadVolumePayload
    const buffer = base64ToArrayBuffer(bytesBase64)
    const file = new File([buffer], name, { type: 'application/octet-stream' })
    await loadFile(nv, file, add ?? false)
    return { ok: true }
  })

  bridge.handle('setBackend', async (raw) => {
    const { backend } = raw as SetBackendPayload
    if (backend !== 'webgl2' && backend !== 'webgpu') {
      throw new Error(`invalid backend '${backend}'`)
    }
    if (nv.backend === backend) {
      return { backend: nv.backend }
    }
    await nv.reinitializeView({ backend })
    // NiiVue may downgrade webgpu -> webgl2 if the adapter is unavailable;
    // report back what actually ended up active.
    bridge.emit('backendChange', { backend: nv.backend })
    return { backend: nv.backend }
  })

  bridge.handle('getVolumes', async () => volumeSummaries(nv.volumes))

  bridge.handle('setVolume', async (raw) => {
    const { index, ...update } = raw as SetVolumePayload
    await nv.setVolume(index, update)
    return { ok: true }
  })

  bridge.handle('removeVolume', async (raw) => {
    await nv.removeVolume((raw as { index: number }).index)
    return { ok: true }
  })

  bridge.handle('getMeshes', async () => meshSummaries(nv.meshes))

  bridge.handle('removeMesh', async (raw) => {
    await nv.removeMesh((raw as { index: number }).index)
    return { ok: true }
  })

  bridge.handle('getSignalCount', async () => ({ count: nv.signals.length }))

  bridge.handle('getColormaps', async () => nv.colormapNames('continuous'))

  wirePropBridge(nv, bridge, { allowlist: options.allowlist })

  const emitVolumes = () =>
    bridge.emit('volumesChange', volumeSummaries(nv.volumes))

  nv.addEventListener('volumeLoaded', (event) => {
    bridge.emit('imageLoaded', {
      name: event.detail.volume.name,
      kind: 'volume',
    })
    emitVolumes()
  })
  nv.addEventListener('volumeUpdated', emitVolumes)
  nv.addEventListener('volumeRemoved', emitVolumes)

  const emitMeshes = () => bridge.emit('meshesChange', meshSummaries(nv.meshes))

  nv.addEventListener('meshLoaded', (event) => {
    bridge.emit('imageLoaded', {
      name: event.detail.mesh.name,
      kind: 'mesh',
    })
    emitMeshes()
  })
  nv.addEventListener('meshRemoved', emitMeshes)

  const emitSignals = () =>
    bridge.emit('signalsChange', { count: nv.signals.length })

  nv.addEventListener('signalLoaded', (event) => {
    bridge.emit('imageLoaded', {
      name: event.detail.signal.name,
      kind: 'signal',
    })
    emitSignals()
  })
  nv.addEventListener('signalRemoved', emitSignals)

  nv.addEventListener('locationChange', (e) => {
    const detail = (e as CustomEvent).detail
    const mm = detail?.mm ?? null
    const voxel = detail?.vox ?? null
    const string = detail?.string ?? ''
    const values = (detail?.values ?? []).map(
      (v: { name: string; value: number }) => ({
        name: v.name,
        value: v.value,
      }),
    )
    bridge.emit('locationChange', { mm, voxel, values, string })
  })
}
