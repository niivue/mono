import { expect, spyOn, test } from 'bun:test'
import NiiVue, { NVSlide, type NVSlideManifest } from '@/index'
import {
  captureWarnings,
  documentFile,
  niftiBytes,
  parseJsonDocument,
} from '@/testing/headless'

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const manifest: NVSlideManifest = {
  id: 'restore',
  name: 'restore',
  width: 16,
  height: 16,
  tileSize: 16,
  dtype: 'uint8',
  channels: 'encoded-rgb',
  levels: [
    {
      index: 0,
      width: 16,
      height: 16,
      downsample: 1,
      tileWidth: 16,
      tileHeight: 16,
      columns: 1,
      rows: 1,
      codec: 'image/jpeg',
      tiles: [],
      plane: { z: 0, t: 0 },
    },
  ],
}
const manifestUrl = 'https://example.invalid/slide.json'
function saved(hosted = true): Uint8Array {
  const nv = new NiiVue({ backend: 'webgl2' })
  const slide = new NVSlide(manifest, hosted ? { manifestUrl } : {})
  nv.setSlidePlane(slide, { pixelToWorld: transform })
  const bytes = nv.serializeDocument({ format: 'json' })
  nv.destroy()
  slide.dispose()
  return bytes
}

for (const replacement of [
  'document',
  'volumes',
  'image',
  'destroy',
] as const) {
  test(`a ${replacement} supersedes a slide restore even when fetch ignores abort`, async () => {
    const bytes = saved()
    const nv = new NiiVue({ backend: 'webgl2' })
    const empty = nv.serializeDocument()
    const entered = Promise.withResolvers<AbortSignal>()
    const pending = Promise.withResolvers<Response>()
    const cancelled = Promise.withResolvers<void>()
    const originalFetch = globalThis.fetch
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(((
      input,
      init,
    ) => {
      if (input !== manifestUrl) return originalFetch(input, init)
      entered.resolve(init?.signal as AbortSignal)
      return pending.promise
    }) as typeof fetch)
    try {
      const first = nv.loadDocument(documentFile(bytes))
      const signal = await entered.promise
      if (replacement === 'document') await nv.loadDocument(documentFile(empty))
      else if (replacement === 'volumes') await nv.loadVolumes([])
      else if (replacement === 'image')
        await nv.loadImage(
          new File(
            [
              niftiBytes({
                dims: [2, 2, 2],
                datatype: 'uint8',
                voxel: () => 1,
              }),
            ],
            'next.nii',
          ),
        )
      else nv.destroy()
      await first
      expect(signal.aborted).toBe(true)
      expect(nv.slidePlaneIndex).toBeNull()
      pending.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled.resolve()
            },
          }),
        ),
      )
      await cancelled.promise
      expect(nv.slidePlaneIndex).toBeNull()
    } finally {
      fetchMock.mockRestore()
      nv.destroy()
    }
  })
}

for (const status of [200, 502]) {
  test(`aborting an HTTP ${status} manifest body settles and cancels the reader`, async () => {
    const entered = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream(
          {
            pull() {
              entered.resolve()
            },
            cancel() {
              cancelled.resolve()
            },
          },
          { highWaterMark: 0 },
        ),
        { status, headers: { 'content-type': 'application/json' } },
      ),
    )
    const controller = new AbortController()
    try {
      const loaded = NVSlide.fromManifestUrl(manifestUrl, {}, controller.signal)
      const rejected = loaded.catch((error: unknown) => error)
      await entered.promise
      controller.abort()
      expect(await rejected).toBeInstanceOf(DOMException)
      await cancelled.promise
    } finally {
      fetchMock.mockRestore()
    }
  })
}

for (const replacement of ['clear', 'replace', 'destroy'] as const) {
  test(`document-owned slides are disposed on ${replacement}; caller-owned slides are borrowed`, async () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    const bytes = saved(false)
    const dispose = spyOn(NVSlide.prototype, 'dispose')
    const borrowed = new NVSlide(manifest)
    try {
      await nv.loadDocument(documentFile(bytes))
      expect(nv.slidePlaneIndex).toEqual({ z: 0, t: 0 })
      expect(dispose).not.toHaveBeenCalled()
      if (replacement === 'clear') nv.clearSlidePlane()
      else if (replacement === 'replace')
        nv.setSlidePlane(borrowed, { pixelToWorld: transform })
      else nv.destroy()
      expect(dispose).toHaveBeenCalledTimes(1)
      if (replacement !== 'destroy') {
        nv.setSlidePlane(borrowed, { pixelToWorld: transform })
        nv.clearSlidePlane()
        expect(dispose).toHaveBeenCalledTimes(1)
      }
    } finally {
      dispose.mockRestore()
      nv.destroy()
      borrowed.dispose()
    }
  })
}

test('a slide that fails attachment is disposed immediately', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const doc = parseJsonDocument(saved(false))
  ;(doc.slidePlane as { pixelToWorld: unknown }).pixelToWorld = null
  const dispose = spyOn(NVSlide.prototype, 'dispose')
  const warnings = captureWarnings()
  try {
    await nv.loadDocument(documentFile(JSON.stringify(doc)))
    expect(nv.slidePlaneIndex).toBeNull()
    expect(dispose).toHaveBeenCalledTimes(1)
    nv.destroy()
    expect(dispose).toHaveBeenCalledTimes(1)
  } finally {
    warnings.restore()
    dispose.mockRestore()
    nv.destroy()
  }
})

test('clearing a slide during attachment disposes it without retaining ownership', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const bytes = saved(false)
  const dispose = spyOn(NVSlide.prototype, 'dispose')
  const location = spyOn(nv, 'createOnLocationChange').mockImplementation(
    () => {
      if (nv.slidePlaneIndex) nv.clearSlidePlane()
    },
  )
  try {
    await nv.loadDocument(documentFile(bytes))
    expect(nv.slidePlaneIndex).toBeNull()
    expect(dispose).toHaveBeenCalledTimes(1)
    nv.destroy()
    expect(dispose).toHaveBeenCalledTimes(1)
  } finally {
    location.mockRestore()
    dispose.mockRestore()
    nv.destroy()
  }
})

test('destroy releases an owned slide without invoking the renderer', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadDocument(documentFile(saved(false)))
  const dispose = spyOn(NVSlide.prototype, 'dispose')
  const draw = spyOn(nv, 'drawScene').mockImplementation(() => {
    throw new Error('simulated render failure')
  })
  try {
    nv.destroy()
    expect(nv.slidePlaneIndex).toBeNull()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(draw).not.toHaveBeenCalled()
  } finally {
    draw.mockRestore()
    dispose.mockRestore()
    nv.destroy()
  }
})

// A source with three focal planes; documents reopen it by its descriptor.
function planeSource(url = 'https://example.invalid/slide.tif') {
  const at = (z: number): NVSlideManifest => ({
    ...manifest,
    levels: manifest.levels.map((l) => ({ ...l, plane: { z, t: 0 } })),
  })
  return {
    manifest: at(0),
    descriptor: { kind: 'test/slide', url: `${url}?token=secret` },
    planes: { z: 3, t: 1 },
    disposed: false,
    bind() {},
    fetchTileBytes: () => Promise.reject(new Error('no tiles')),
    preparePlane: async (p: { z: number }) => at(p.z),
    dispose() {
      this.disposed = true
    },
  }
}

test('a saved focal plane reopens through resolveSource before attaching', async () => {
  const before = new NiiVue({ backend: 'webgl2' })
  const slide = NVSlide.fromSource(planeSource())
  before.setSlidePlane(slide, { pixelToWorld: transform })
  await slide.setPlaneIndex({ z: 2, t: 0 })
  const bytes = before.serializeDocument({ format: 'json' })
  before.destroy()
  slide.dispose()
  const nv = new NiiVue({ backend: 'webgl2' })
  const seen: unknown[] = []
  let attachedAt: unknown
  const attach = spyOn(nv, 'setSlidePlane').mockImplementation(function (
    this: NiiVue,
    s,
    o,
  ) {
    attachedAt = s.planeIndex
    attach.mockRestore()
    return this.setSlidePlane(s, o)
  })
  try {
    await nv.loadDocument(documentFile(bytes), {
      resolveSource: (d, ctx) => {
        seen.push({ d, slide: ctx.slide })
        return planeSource()
      },
    })
    expect(seen).toEqual([
      {
        d: { kind: 'test/slide', url: 'https://example.invalid/slide.tif' },
        slide: true,
      },
    ])
    expect(attachedAt).toEqual({ z: 2, t: 0 })
    expect(nv.slidePlaneIndex).toEqual({ z: 2, t: 0 })
  } finally {
    nv.destroy()
  }
})

test('an unavailable saved source is skipped, not shown as broken tiles', async () => {
  const before = new NiiVue({ backend: 'webgl2' })
  const slide = NVSlide.fromSource(planeSource())
  before.setSlidePlane(slide, { pixelToWorld: transform })
  const bytes = before.serializeDocument({ format: 'json' })
  before.destroy()
  slide.dispose()
  const warnings = captureWarnings()
  const nv = new NiiVue({ backend: 'webgl2' })
  try {
    await nv.loadDocument(documentFile(bytes), { resolveSource: () => null })
    expect(nv.slidePlaneIndex).toBeNull()
    expect(warnings.messages.join('\n')).toContain('unavailable')
  } finally {
    warnings.restore()
    nv.destroy()
  }
})

for (const call of ['set', 'clear'] as const) {
  test(`a caller's ${call}SlidePlane supersedes a pending document slide restore`, async () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    const bytes = saved()
    const mine = new NVSlide(manifest)
    const entered = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<Response>()
    const originalFetch = globalThis.fetch
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(((
      input,
      init,
    ) => {
      if (input !== manifestUrl) return originalFetch(input, init)
      entered.resolve()
      return pending.promise
    }) as typeof fetch)
    const dispose = spyOn(NVSlide.prototype, 'dispose')
    try {
      const load = nv.loadDocument(documentFile(bytes))
      await entered.promise
      if (call === 'set') nv.setSlidePlane(mine, { pixelToWorld: transform })
      else nv.clearSlidePlane()
      const set = spyOn(nv, 'setSlidePlane')
      pending.resolve(Response.json(manifest))
      await load
      expect(set).not.toHaveBeenCalled()
      set.mockRestore()
      expect(nv.slidePlaneIndex).toEqual(call === 'set' ? { z: 0, t: 0 } : null)
      // The restored slide is disposed, the caller's is not.
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(dispose.mock.contexts[0]).not.toBe(mine)
    } finally {
      dispose.mockRestore()
      fetchMock.mockRestore()
      nv.destroy()
      mine.dispose()
    }
  })
}
