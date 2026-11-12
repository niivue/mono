import { expect, test } from 'bun:test'
import * as depthPick from './depthPick'

// Bun has no WebGPU: stub the flag namespaces depthPick reads.
Object.assign(globalThis, {
  GPUBufferUsage: { COPY_DST: 8, MAP_READ: 1 },
  GPUTextureUsage: { RENDER_ATTACHMENT: 16, COPY_SRC: 1 },
  GPUMapMode: { READ: 1 },
})

function fakeDevice() {
  const mapping = Promise.withResolvers<void>()
  const device = {
    createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
    // A real buffer rejects a pending mapAsync with AbortError on destroy.
    createBuffer: () => ({
      mapAsync: () => mapping.promise,
      destroy: () =>
        mapping.reject(new DOMException('destroyed', 'AbortError')),
    }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ setViewport: () => {}, end: () => {} }),
      copyTextureToBuffer: () => {},
      finish: () => ({}),
    }),
    queue: { submit: () => {} },
  }
  return device as unknown as GPUDevice
}

const params = (device: GPUDevice): depthPick.DepthPickDrawParams => ({
  device,
  volumeBindGroup: null,
  volumeVertexBuffer: null,
  volumeIndexBuffer: null,
  volumeIndexCount: 0,
  volumeParamsBuffer: null,
  volumeUniformData: null,
  meshes: [],
})

test('a pick pending when the view is destroyed resolves null, not AbortError', async () => {
  const device = fakeDevice()
  depthPick.init(device, null, null)
  const picking = depthPick.pick(params(device))
  depthPick.destroy(device)
  expect(await picking).toBeNull()
})
