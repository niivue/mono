import { expect, test } from 'bun:test'
import { VolumeRenderer as GLRenderer } from '@/gl/render'
import type { NVImage } from '@/NVTypes'
import { VolumeRenderer } from '@/wgpu/render'

type Fake = Record<string, unknown> & VolumeRenderer
const fakeRenderer = (texCache: Map<string, unknown>): Fake =>
  Object.assign(Object.create(VolumeRenderer.prototype), {
    isReady: true,
    maxTextureDimension3D: 2048,
    _texCache: texCache,
    _bindGroupCache: new Map(),
    _activeChunked: null,
    _activeVolKey: null,
    volumeOrientCache: null,
    volumeRgbaCache: null,
  })

const fakeTexture = () => ({
  destroyed: false,
  destroy() {
    this.destroyed = true
  },
})

test('binding a cached chunked volume drops the single bind group', () => {
  const chunk = {
    kind: 'chunked',
    volume: { colormapLabel: false },
    manager: {
      getChunk: () => ({ volumeTexture: {}, volumeGradientTexture: null }),
    },
  }
  const r = fakeRenderer(new Map([['chunked', chunk]]))
  r.bindGroup = {} as GPUBindGroup
  expect(r.bindCachedVolume('chunked')).toBe(true)
  expect(r.bindGroup).toBeNull()
})

test('the plain single-volume path leaves per-volume cached textures alive', async () => {
  const volumeTexture = fakeTexture()
  const volumeGradientTexture = fakeTexture()
  const entry = {
    kind: 'single',
    volumeTexture,
    volumeGradientTexture,
    isLabel: false,
  }
  const r = fakeRenderer(new Map([['cached', entry]]))
  r.bindCachedVolume('cached')
  const vol = {
    hdr: { dims: [3, 4, 4, 4], datatypeCode: 16 },
    chunkPlan: null,
    mm000: [0, 0, 0],
    mm100: [1, 0, 0],
    mm010: [0, 1, 0],
    mm001: [0, 0, 1],
  } as unknown as NVImage
  // The fake device stops the upload after the old textures are released.
  await r.updateVolume({} as GPUDevice, vol).catch(() => {})
  expect(volumeTexture.destroyed).toBe(false)
  expect(volumeGradientTexture.destroyed).toBe(false)
})

test('a plan swap re-points the chunk-0 aliases at the new plan', () => {
  const live = { volumeTexture: {}, volumeGradientTexture: {} }
  const entry = { manager: { getChunk: () => live } }
  const r = fakeRenderer(new Map())
  Object.assign(r, {
    _activeChunked: entry,
    volumeTexture: {},
    volumeGradientTexture: {},
  })
  ;(r as unknown as { _onPlanSwapped(e: unknown): void })._onPlanSwapped(entry)
  expect(r.volumeTexture).toBe(live.volumeTexture as GPUTexture)
  expect(r.volumeGradientTexture).toBe(live.volumeGradientTexture as GPUTexture)
})

test('gl: the plain single-volume path leaves per-volume cached textures alive', async () => {
  const volumeTexture = {}
  const volumeGradientTexture = {}
  const entry = {
    kind: 'single',
    volumeTexture,
    volumeGradientTexture,
    isLabel: false,
  }
  const deleted: unknown[] = []
  const r = Object.assign(Object.create(GLRenderer.prototype), {
    isReady: true,
    max3D: 2048,
    _texCache: new Map([['cached', entry]]),
    _activeChunked: null,
    volumeOrientCache: null,
    volumeRgbaCache: null,
  }) as GLRenderer
  r.bindCachedVolume('cached')
  const vol = {
    hdr: { dims: [3, 4, 4, 4], datatypeCode: 16 },
    chunkPlan: null,
    mm000: [0, 0, 0],
    mm100: [1, 0, 0],
    mm010: [0, 1, 0],
    mm001: [0, 0, 1],
  } as unknown as NVImage
  // Records deletes, then the orient pass fails on the fake context.
  const gl = {
    deleteTexture: (t: unknown) => deleted.push(t),
  } as unknown as WebGL2RenderingContext
  await r.updateVolume(gl, vol).catch(() => {})
  expect(deleted).not.toContain(volumeTexture)
  expect(deleted).not.toContain(volumeGradientTexture)
})
