import type NiiVue from '@niivue/niivue'
import type { Bridge } from './bridge'
import { wirePropBridge } from './prop-bridge'

export type LoadVolumePayload = {
  name: string
  bytesBase64: string
}

export type SetBackendPayload = {
  backend: 'webgl2' | 'webgpu'
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

/**
 * Registers bridge handlers that drive the given NiiVue instance and
 * forwards niivue events back to the native host.
 */
export function wireNiiVueToBridge(
  nv: InstanceType<typeof NiiVue>,
  bridge: Bridge,
): void {
  bridge.handle('loadVolume', async (raw) => {
    const { name, bytesBase64 } = raw as LoadVolumePayload
    const buffer = base64ToArrayBuffer(bytesBase64)
    const file = new File([buffer], name, { type: 'application/octet-stream' })
    await nv.loadImage(file)
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
    // NiiVue may downgrade webgpu→webgl2 if the adapter is unavailable; report
    // back what actually ended up active.
    bridge.emit('backendChange', { backend: nv.backend })
    return { backend: nv.backend }
  })

  // Generic property sync: setProp / getProps / propChange.
  wirePropBridge(nv, bridge)

  nv.addEventListener('locationChange', (e) => {
    const detail = (e as CustomEvent).detail
    const mm = detail?.mm ?? null
    const voxel = detail?.vox ?? null
    const string = detail?.string ?? ''
    bridge.emit('locationChange', { mm, voxel, string })
  })
}
