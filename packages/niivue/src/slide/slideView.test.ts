import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { NVSlide, NVSlideSample, NVSlideViewport } from './NVSlide'
import {
  attachSlideLens,
  createSlideViewWith,
  formatSlideSample,
  linkSlideViews,
  type SlideBackendFactory,
  type SlideRenderBackend,
  type SlideView,
  slideStatsSummary,
} from './slideView'

// No DOM under bun: an EventTarget canvas, counted observers and media queries.
let observers = 0
let ratioListeners = 0
let size = { width: 200, height: 100 }
const saved = {
  ResizeObserver: globalThis.ResizeObserver,
  matchMedia: globalThis.matchMedia,
  window: globalThis.window,
}
beforeEach(() => {
  observers = 0
  ratioListeners = 0
  size = { width: 200, height: 100 }
  Object.assign(globalThis, {
    ResizeObserver: class {
      observe() {
        observers++
      }
      disconnect() {
        observers--
      }
    },
    matchMedia: () => ({
      addEventListener: () => ratioListeners++,
      removeEventListener: () => ratioListeners--,
    }),
    window: { devicePixelRatio: 2 },
  })
})
afterEach(() => Object.assign(globalThis, saved))

function fakeCanvas(): HTMLCanvasElement {
  const canvas = Object.assign(new EventTarget(), {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ left: 0, top: 0, ...size }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    replaced: null as unknown,
    parentNode: {},
    cloneNode: () => fakeCanvas(),
    replaceWith(next: unknown) {
      canvas.replaced = next
    },
  })
  return canvas as unknown as HTMLCanvasElement
}

function fakeRenderer() {
  const r = {
    renders: 0,
    destroys: 0,
    clears: 0,
    isNearestInterpolation: false,
    overlay: null,
    overlayDraw: null as SlideRenderBackend['overlayDraw'],
    render() {
      r.renders++
    },
    clearTextures() {
      r.clears++
    },
    destroy() {
      r.destroys++
    },
  }
  return r
}

function backend(
  kind: 'webgpu' | 'webgl2',
  make: (canvas: HTMLCanvasElement) => SlideRenderBackend | null,
): SlideBackendFactory & { canvases: HTMLCanvasElement[] } {
  const canvases: HTMLCanvasElement[] = []
  return {
    kind,
    canvases,
    create: async (canvas) => {
      canvases.push(canvas)
      return make(canvas)
    },
  }
}

function fakeSlide(
  spacing?: [number, number],
  width = 1000,
  height = 1000,
): NVSlide & { disposed: number; fits: number } {
  const s = Object.assign(new EventTarget(), {
    disposed: 0,
    fits: 0,
    viewport: { centerX: 0, centerY: 0, scale: 1 } as NVSlideViewport,
    manifest: { width, height, pixelSpacingMM: spacing, levels: [] },
    setViewport(v: NVSlideViewport) {
      s.viewport = { ...v }
      s.dispatchEvent(new Event('change'))
    },
    fitToScreen() {
      s.fits++
      s.viewport = { centerX: width / 2, centerY: height / 2, scale: 0.1 }
    },
    clampViewport() {},
    dispose() {
      s.disposed++
    },
  })
  return s as unknown as NVSlide & { disposed: number; fits: number }
}

const frame = () => new Promise((r) => setTimeout(r, 5))

describe('createSlideView', () => {
  test('falls back to WebGL2 when WebGPU is unavailable', async () => {
    const gl = fakeRenderer()
    const view = await createSlideViewWith(
      [backend('webgpu', () => null), backend('webgl2', () => gl)],
      fakeCanvas(),
    )
    expect(view.backend).toBe('webgl2')
    expect(view.renderer).toBe(gl)
    view.destroy()
  })

  test("backend: 'webgl2' tries WebGL2 first", async () => {
    const gpu = backend('webgpu', () => fakeRenderer())
    const view = await createSlideViewWith(
      [gpu, backend('webgl2', () => fakeRenderer())],
      fakeCanvas(),
      { backend: 'webgl2' },
    )
    expect(view.backend).toBe('webgl2')
    expect(gpu.canvases).toEqual([])
    view.destroy()
  })

  test('a WebGPU failure keeps the canvas when WebGL2 starts on it', async () => {
    const canvas = fakeCanvas()
    const view = await createSlideViewWith(
      [
        backend('webgpu', () => {
          throw new Error('requestDevice')
        }),
        backend('webgl2', () => fakeRenderer()),
      ],
      canvas,
    )
    expect(view.canvas).toBe(canvas)
    expect((canvas as unknown as { replaced: unknown }).replaced).toBeNull()
    view.destroy()
  })

  test('WebGL2 refused on a canvas WebGPU locked: retried on a clone', async () => {
    const canvas = fakeCanvas()
    const gl = backend('webgl2', (c) => (c === canvas ? null : fakeRenderer()))
    const view = await createSlideViewWith(
      [backend('webgpu', () => null), gl],
      canvas,
    )
    expect(view.canvas).not.toBe(canvas)
    expect(gl.canvases).toEqual([canvas, view.canvas])
    expect((canvas as unknown as { replaced: unknown }).replaced).toBe(
      view.canvas,
    )
    view.destroy()
  })

  test('WebGPU refused on a canvas a failed WebGL2 locked: retried on a clone', async () => {
    const canvas = fakeCanvas()
    const gpu = backend('webgpu', (c) => (c === canvas ? null : fakeRenderer()))
    const view = await createSlideViewWith(
      [
        gpu,
        backend('webgl2', () => {
          throw new Error('init failed after getContext')
        }),
      ],
      canvas,
      { backend: 'webgl2' },
    )
    expect(view.backend).toBe('webgpu')
    expect(gpu.canvases).toEqual([canvas, view.canvas])
    view.destroy()
  })

  test('all backends failing leaves the original canvas in place', async () => {
    const canvas = fakeCanvas()
    const gl = backend('webgl2', () => null)
    await expect(
      createSlideViewWith([backend('webgpu', () => null), gl], canvas),
    ).rejects.toThrow('No slide backend')
    const clone = gl.canvases[1] as unknown as { replaced: unknown }
    expect(clone.replaced).toBe(canvas)
  })

  test('a borrowed renderer keeps its kind and its overlay hook', async () => {
    const r = fakeRenderer()
    const own: string[] = []
    r.overlayDraw = () => own.push('own')
    const view = await createSlideViewWith([], fakeCanvas(), { renderer: r })
    expect(view.backend).toBe('webgpu')
    view.addOverlay({ drawOverlay: () => own.push('added') })
    r.overlayDraw?.({} as Parameters<NonNullable<typeof r.overlayDraw>>[0])
    view.destroy()
    r.overlayDraw?.({} as Parameters<NonNullable<typeof r.overlayDraw>>[0])
    expect(own).toEqual(['own', 'added', 'own'])
  })

  test("destroy leaves a borrowed renderer's own overlay", async () => {
    const r = fakeRenderer()
    const own = {} as SlideRenderBackend['overlay']
    Object.assign(r, { overlay: own })
    const view = await createSlideViewWith([], fakeCanvas(), { renderer: r })
    view.renderNow()
    view.destroy()
    expect(r.overlay as unknown).toBe(own)
  })

  test('setSlide after destroy releases an owned slide', async () => {
    const view = await createSlideViewWith(
      [backend('webgl2', () => fakeRenderer())],
      fakeCanvas(),
    )
    view.destroy()
    const late = fakeSlide()
    view.setSlide(late)
    expect(late.disposed).toBe(1)
    expect(view.slide).toBeNull()
  })

  test('no backend: rejects and attaches nothing', async () => {
    await expect(
      createSlideViewWith(
        [backend('webgpu', () => null), backend('webgl2', () => null)],
        fakeCanvas(),
      ),
    ).rejects.toThrow('No slide backend')
    expect(observers).toBe(0)
    expect(ratioListeners).toBe(0)
  })

  test('aborted while starting: rejects AbortError and frees the renderer', async () => {
    const r = fakeRenderer()
    const ac = new AbortController()
    const pending = createSlideViewWith(
      [
        backend('webgl2', () => {
          ac.abort()
          return r
        }),
      ],
      fakeCanvas(),
      { signal: ac.signal },
    )
    await expect(pending).rejects.toThrow('aborted')
    expect(r.destroys).toBe(1)
    expect(observers).toBe(0)
  })

  test('aborted after a clone swap: the original canvas goes back', async () => {
    const canvas = fakeCanvas()
    const ac = new AbortController()
    const gl = backend('webgl2', (c) => {
      if (c === canvas) return null
      ac.abort()
      return fakeRenderer()
    })
    await expect(
      createSlideViewWith([backend('webgpu', () => null), gl], canvas, {
        signal: ac.signal,
      }),
    ).rejects.toThrow('aborted')
    const clone = gl.canvases[1] as unknown as { replaced: unknown }
    expect(clone.replaced).toBe(canvas)
  })

  test('an overlay remover after destroy leaves a borrowed hook alone', async () => {
    const r = fakeRenderer()
    const own = () => {}
    r.overlayDraw = own
    const view = await createSlideViewWith([], fakeCanvas(), { renderer: r })
    const remove = view.addOverlay({ drawOverlay: () => {} })
    view.destroy()
    expect(r.overlayDraw).toBe(own)
    // The owner hooks something else in; a late remover must not undo it.
    const next = () => {}
    r.overlayDraw = next
    remove()
    expect(r.overlayDraw).toBe(next)
  })

  test('fits on the first sized frame, then keeps the view', async () => {
    size = { width: 0, height: 0 }
    const slide = fakeSlide()
    const view = await createSlideViewWith(
      [backend('webgl2', () => fakeRenderer())],
      fakeCanvas(),
      { slide },
    )
    view.renderNow()
    expect(slide.fits).toBe(0)
    size = { width: 200, height: 100 }
    view.renderNow()
    expect(slide.fits).toBe(1)
    expect(view.canvas.width).toBe(400) // DPR 2
    view.renderNow()
    expect(slide.fits).toBe(1)
    view.destroy()
  })

  test('a resize refits until the user moves the view', async () => {
    const slide = fakeSlide()
    const view = await createSlideViewWith(
      [backend('webgl2', () => fakeRenderer())],
      fakeCanvas(),
      { slide },
    )
    view.renderNow()
    size = { width: 300, height: 100 }
    view.renderNow()
    expect(slide.fits).toBe(2)
    slide.setViewport({ centerX: 1, centerY: 1, scale: 1 })
    size = { width: 400, height: 100 }
    view.renderNow()
    expect(slide.fits).toBe(2)
    view.destroy()
  })

  test('hidpi false draws one canvas pixel per CSS pixel', async () => {
    const view = await createSlideViewWith(
      [backend('webgl2', () => fakeRenderer())],
      fakeCanvas(),
      { hidpi: false },
    )
    view.renderNow()
    expect(view.canvas.width).toBe(200)
    view.destroy()
  })

  test('setSlide releases the previous slide and its textures', async () => {
    const r = fakeRenderer()
    const a = fakeSlide()
    const b = fakeSlide()
    const view = await createSlideViewWith(
      [backend('webgl2', () => r)],
      fakeCanvas(),
      { slide: a },
    )
    view.setSlide(b)
    expect(a.disposed).toBe(1)
    expect(r.clears).toBe(2)
    expect(view.slide).toBe(b)
    view.destroy()
    expect(b.disposed).toBe(1)
  })

  test('ownsSlide false leaves slides to the caller', async () => {
    const a = fakeSlide()
    const view = await createSlideViewWith(
      [backend('webgl2', () => fakeRenderer())],
      fakeCanvas(),
      { slide: a, ownsSlide: false },
    )
    view.setSlide(null)
    view.destroy()
    expect(a.disposed).toBe(0)
  })

  test('slide changes schedule one frame', async () => {
    const r = fakeRenderer()
    const slide = fakeSlide()
    const view = await createSlideViewWith(
      [backend('webgl2', () => r)],
      fakeCanvas(),
      { slide },
    )
    await frame()
    const before = r.renders
    slide.dispatchEvent(new Event('change'))
    slide.dispatchEvent(new Event('change'))
    await frame()
    expect(r.renders).toBe(before + 1)
    view.destroy()
  })

  test('overlays compose into the renderer hook', async () => {
    const r = fakeRenderer()
    const view = await createSlideViewWith(
      [backend('webgl2', () => r)],
      fakeCanvas(),
    )
    const drawn: string[] = []
    const removeA = view.addOverlay({ drawOverlay: () => drawn.push('a') })
    view.addOverlay({ drawOverlay: () => drawn.push('b') })
    r.overlayDraw?.({} as Parameters<NonNullable<typeof r.overlayDraw>>[0])
    removeA()
    r.overlayDraw?.({} as Parameters<NonNullable<typeof r.overlayDraw>>[0])
    expect(drawn).toEqual(['a', 'b', 'b'])
    view.destroy()
    expect(r.overlayDraw).toBeNull()
  })

  test('destroy is idempotent; a borrowed renderer survives it', async () => {
    const owned = fakeRenderer()
    const view = await createSlideViewWith(
      [backend('webgl2', () => owned)],
      fakeCanvas(),
    )
    view.destroy()
    view.destroy()
    expect(owned.destroys).toBe(1)
    const borrowed = fakeRenderer()
    const second = await createSlideViewWith([], fakeCanvas(), {
      renderer: borrowed,
    })
    second.destroy()
    expect(borrowed.destroys).toBe(0)
  })

  test('50 create/destroy cycles leave no observer, listener or frame', async () => {
    let renders = 0
    for (let i = 0; i < 50; i++) {
      const r = fakeRenderer()
      r.render = () => {
        renders++
      }
      const view = await createSlideViewWith(
        [backend('webgl2', () => r)],
        fakeCanvas(),
        { slide: fakeSlide() },
      )
      view.destroy()
    }
    await frame()
    expect([observers, ratioListeners, renders]).toEqual([0, 0, 0])
  })
})

async function viewOf(slide: NVSlide): Promise<SlideView> {
  return createSlideViewWith(
    [backend('webgl2', () => fakeRenderer())],
    fakeCanvas(),
    { slide, controller: false, ownsSlide: false },
  )
}

describe('linkSlideViews', () => {
  test('syncs in millimetres across slides with different spacing, with no echo', async () => {
    const a = fakeSlide([0.001, 0.001])
    const b = fakeSlide([0.002, 0.002], 500, 500)
    const [va, vb] = [await viewOf(a), await viewOf(b)]
    va.renderNow()
    vb.renderNow()
    const unlink = linkSlideViews([va, vb])
    a.setViewport({ centerX: 400, centerY: 200, scale: 2 })
    va.renderNow()
    expect(b.viewport).toEqual({ centerX: 200, centerY: 100, scale: 4 })
    const sets = { ...b.viewport }
    vb.renderNow() // the echo frame: a stays put
    expect(a.viewport).toEqual({ centerX: 400, centerY: 200, scale: 2 })
    expect(b.viewport).toEqual(sets)
    b.setViewport({ centerX: 50, centerY: 50, scale: 4 })
    vb.renderNow()
    expect(a.viewport).toEqual({ centerX: 100, centerY: 100, scale: 2 })
    unlink()
    a.setViewport({ centerX: 1, centerY: 1, scale: 1 })
    va.renderNow()
    expect(b.viewport.centerX).toBe(50)
    va.destroy()
    vb.destroy()
  })

  test('a gesture on a view before its echo frame still moves the others', async () => {
    const a = fakeSlide([0.001, 0.001])
    const b = fakeSlide([0.001, 0.001])
    const [va, vb] = [await viewOf(a), await viewOf(b)]
    va.renderNow()
    vb.renderNow()
    linkSlideViews([va, vb])
    a.setViewport({ centerX: 10, centerY: 10, scale: 1 })
    va.renderNow()
    b.setViewport({ centerX: 30, centerY: 30, scale: 1 }) // before b's frame
    vb.renderNow()
    expect(a.viewport).toEqual({ centerX: 30, centerY: 30, scale: 1 })
    va.destroy()
    vb.destroy()
  })

  test('a slide swapped for one with other spacing at the same pixels moves the others', async () => {
    const a = fakeSlide([0.001, 0.001])
    const b = fakeSlide([0.001, 0.001])
    const [va, vb] = [await viewOf(a), await viewOf(b)]
    va.renderNow()
    vb.renderNow()
    linkSlideViews([va, vb])
    a.setViewport({ centerX: 100, centerY: 100, scale: 1 })
    va.renderNow()
    vb.renderNow()
    const c = fakeSlide([0.002, 0.002])
    c.setViewport({ ...b.viewport })
    vb.setSlide(c, { fit: false })
    vb.renderNow()
    expect(a.viewport.centerX).toBe(200)
    va.destroy()
    vb.destroy()
  })

  test('linking moves the others to the first view, not back', async () => {
    const a = fakeSlide([0.001, 0.001])
    const b = fakeSlide([0.001, 0.001])
    const va = await viewOf(a)
    va.renderNow() // fitted, then the user moves it
    a.setViewport({ centerX: 10, centerY: 20, scale: 3 })
    va.renderNow()
    const vb = await createSlideViewWith(
      [backend('webgl2', () => fakeRenderer())],
      fakeCanvas(),
      { controller: false, ownsSlide: false },
    )
    vb.setSlide(b, { fit: false })
    linkSlideViews([va, vb])
    vb.renderNow()
    va.renderNow()
    expect(a.viewport).toEqual({ centerX: 10, centerY: 20, scale: 3 })
    expect(b.viewport).toEqual({ centerX: 10, centerY: 20, scale: 3 })
    va.destroy()
    vb.destroy()
  })

  test('without spacing, the same fraction of each slide', async () => {
    const a = fakeSlide(undefined, 1000, 1000)
    const b = fakeSlide([0.002, 0.002], 500, 250)
    const [va, vb] = [await viewOf(a), await viewOf(b)]
    va.renderNow()
    vb.renderNow()
    linkSlideViews([va, vb])
    a.setViewport({ centerX: 500, centerY: 100, scale: 1 })
    va.renderNow()
    expect(b.viewport).toEqual({ centerX: 250, centerY: 25, scale: 2 })
    va.destroy()
    vb.destroy()
  })

  test('a lens clips to a circle at the pointer and is linked', async () => {
    const a = fakeSlide()
    const b = fakeSlide()
    const [va, vb] = [await viewOf(a), await viewOf(b)]
    va.renderNow()
    vb.renderNow()
    const detach = attachSlideLens(va, vb, { radiusCss: 10 })
    va.canvas.dispatchEvent(
      Object.assign(new Event('pointermove'), { clientX: 30, clientY: 40 }),
    )
    expect(vb.canvas.style.clipPath).toBe('circle(10px at 30px 40px)')
    expect(vb.canvas.style.pointerEvents).toBe('none')
    a.setViewport({ centerX: 7, centerY: 8, scale: 3 })
    va.renderNow()
    expect(b.viewport).toEqual({ centerX: 7, centerY: 8, scale: 3 })
    detach()
    expect(vb.canvas.style.clipPath).toBe('')
    expect(vb.canvas.style.pointerEvents).toBe('')
    va.destroy()
    vb.destroy()
  })
})

describe('readout helpers', () => {
  const sample = (over: Partial<NVSlideSample>): NVSlideSample => ({
    channel: 0,
    name: 'DAPI',
    value: 12,
    stored: 12,
    level: 0,
    exact: true,
    ...over,
  })

  test('formatSlideSample lists each channel, missing ones by reason', () => {
    expect(
      formatSlideSample(10.7, 3.2, [
        sample({}),
        sample({ name: 'CD3', value: 0.123456, level: 0 }),
        sample({ name: 'CD8', value: null, missing: 'uncached' }),
        sample({ name: 'Ki67', value: 65535, stored: 65535, clipped: true }),
      ]),
    ).toBe('10,3 DAPI 12, CD3 0.12346, CD8 uncached, Ki67 >=65535 (L0)')
    // Clipped at the low end is an upper bound; int16 ends; unknown is ~.
    expect(
      formatSlideSample(0, 0, [
        sample({ name: 'lo', value: 0, stored: 0, clipped: true }),
        sample({ name: 'i16lo', value: -32768, stored: -32768, clipped: true }),
        sample({ name: 'i16hi', value: 32767, stored: 32767, clipped: true }),
        sample({ name: 'odd', value: 7, stored: 7, clipped: true }),
      ]),
    ).toBe('0,0 lo <=0, i16lo <=-32768, i16hi >=32767, odd ~7 (L0)')
    expect(
      formatSlideSample(0, 0, [sample({ value: null, missing: 'outside' })]),
    ).toBe('')
  })

  test('slideStatsSummary reports the drawn level and the stats', () => {
    const slide = {
      name: 'cmu',
      manifest: { levels: [{}, {}] },
      lastVisibleTiles: {
        level: { index: 1, width: 10, height: 20, codec: 'jpeg' },
        tiles: [1, 2],
        fallback: [],
      },
      stats: {
        completed: 3,
        requested: 4,
        rangeHits: 3,
        fullFileFallbacks: 0,
        wireBytes: 2e6,
        cacheBytes: 1e6,
        cacheHits: 7,
        failures: 0,
      },
      viewport: { scale: 0.5 },
      levelChoice: 'auto',
      pendingCount: 1,
      colorLut: null,
    } as unknown as NVSlide
    expect(
      Object.fromEntries(
        slideStatsSummary(slide, { widthCss: 1, heightCss: 1 }),
      ),
    ).toEqual({
      slide: 'cmu: 2 levels',
      level: 'L1 auto 10x20',
      codec: 'jpeg',
      zoom: '1:2.0',
      tiles: '2 visible, 1 pending',
      requests: '3/4 done, 3 HTTP 206, 0 HTTP 200',
      wire: '2.00 MB',
      cache: '1.00 MB, 7 hits',
      failures: '0',
    })
  })
})
