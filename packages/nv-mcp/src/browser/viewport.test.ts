import { describe, expect, it, mock } from 'bun:test'

import { baseView, hostOf } from '../testing/fake-view'
import type { View, Viewport } from './view'
import { viewportHandlers } from './viewport'

/** A view whose canvas can be panned and zoomed and bounded. */
function pannable(overrides: Partial<View> = {}) {
  let viewport: Viewport = { pan: [0, 0], zoom: 1 }
  return baseView({
    getViewport: () => viewport,
    setViewport: mock((next: Viewport) => {
      viewport = next
    }),
    setBounds: mock(),
    clearBounds: mock(),
    ...overrides,
  })
}

describe('set_viewport', () => {
  it('pans and zooms, keeping what was not given', () => {
    const view = pannable()
    const { set_viewport } = viewportHandlers(hostOf(view))
    expect(set_viewport({ zoom: 2 })).toEqual({
      viewport: { pan: [0, 0], zoom: 2 },
    })
    expect(set_viewport({ pan: [10, -5] })).toEqual({
      viewport: { pan: [10, -5], zoom: 2 },
    })
    expect(set_viewport({ reset: true })).toEqual({
      viewport: { pan: [0, 0], zoom: 1 },
    })
    expect(view.drawScene).toHaveBeenCalledTimes(3)
  })

  it('bounds the drawing to a box, or clears the bounds', () => {
    const view = pannable()
    const { set_viewport } = viewportHandlers(hostOf(view))
    set_viewport({ bounds: [0.1, 0.1, 0.9, 0.9] })
    expect(view.setBounds).toHaveBeenCalledWith([0.1, 0.1, 0.9, 0.9])
    set_viewport({ bounds: null })
    expect(view.clearBounds).toHaveBeenCalledTimes(1)
    expect(() => set_viewport({ bounds: [0, 0, 2, 1] })).toThrow(
      'bounds must be [x1, y1, x2, y2], each 0 to 1, or null.',
    )
  })

  it('refuses nothing to do, a zoom of zero, and a page that cannot', () => {
    const { set_viewport } = viewportHandlers(hostOf(pannable()))
    expect(() => set_viewport({})).toThrow(
      'set_viewport needs something to set: pan, zoom, bounds or reset.',
    )
    expect(() => set_viewport({ zoom: 0 })).toThrow('zoom must be above 0.')
    const bare = viewportHandlers(hostOf(baseView()))
    expect(() => bare.set_viewport({ zoom: 2 })).toThrow(
      "This page's NiiVue cannot pan or zoom its canvas.",
    )
    expect(() => bare.set_viewport({ bounds: null })).toThrow(
      "This page's NiiVue cannot bound its drawing.",
    )
  })
})

describe('map_point', () => {
  const mapping = () =>
    baseView({
      hitTest: (x, y) =>
        x < 0
          ? null
          : {
              isRender: false,
              sliceType: 0,
              normalizedX: x / 100,
              normalizedY: y / 100,
              tileIndex: 0,
            },
      canvasToMM: (x, y) => (x < 0 ? null : [x, y, 0]),
      mmToCanvas: (mm) => ({ tileIndex: 0, x: mm[0], y: mm[1] }),
      vox2frac: (vox) => [vox[0] / 100, vox[1] / 100, vox[2] / 100],
    })

  it('says what is under a canvas pixel', () => {
    const { map_point } = viewportHandlers(hostOf(mapping()))
    expect(map_point({ canvas: [20, 40] })).toEqual({
      canvas: [20, 40],
      hit: {
        isRender: false,
        sliceType: 0,
        slice: 'axial',
        normalizedX: 0.2,
        normalizedY: 0.4,
        tileIndex: 0,
      },
      mm: [20, 40, 0],
      frac: [0.6, 0.7, 0.5],
    })
    expect(map_point({ canvas: [-1, 0] })).toEqual({
      canvas: [-1, 0],
      hit: null,
      mm: null,
    })
  })

  it('places a millimetre point and a voxel on the canvas', () => {
    const { map_point } = viewportHandlers(hostOf(mapping()))
    expect(map_point({ mm: [10, 20, 30] })).toEqual({
      mm: [10, 20, 30],
      frac: [0.55, 0.6, 0.65],
      canvas: { tileIndex: 0, x: 10, y: 20 },
    })
    expect(map_point({ vox: [50, 50, 50] })).toEqual({
      vox: [50, 50, 50],
      frac: [0.5, 0.5, 0.5],
      mm: [0, 0, 0],
      canvas: { tileIndex: 0, x: 0, y: 0 },
    })
  })

  it('refuses no point and a page that cannot map', () => {
    const { map_point } = viewportHandlers(hostOf(mapping()))
    expect(() => map_point({})).toThrow(
      'map_point needs canvas ([x, y] pixels), mm or vox.',
    )
    const bare = viewportHandlers(hostOf(baseView()))
    expect(() => bare.map_point({ canvas: [0, 0] })).toThrow(
      "This page's NiiVue cannot say what is under a pixel.",
    )
    expect(() => bare.map_point({ mm: [0, 0, 0] })).toThrow(
      "This page's NiiVue cannot place a point on its canvas.",
    )
    expect(() => bare.map_point({ vox: [0, 0, 0] })).toThrow(
      "This page's NiiVue cannot place a voxel.",
    )
  })
})

describe('set_slide', () => {
  it('sets or clears the slide plane level and works the slide drawing', () => {
    const view = baseView({
      setSlidePlaneLevel: mock(),
      clearSlidePlane: mock(),
      createSlideDrawing: mock(),
      clearSlideDrawing: mock(),
      slideDrawUndo: mock(),
      slideDrawEnd: mock(),
    })
    const { set_slide } = viewportHandlers(hostOf(view))
    expect(set_slide({ level: 2 })).toEqual({ level: 2 })
    expect(view.setSlidePlaneLevel).toHaveBeenCalledWith(2)
    expect(set_slide({ level: null })).toEqual({ level: null })
    expect(view.setSlidePlaneLevel).toHaveBeenLastCalledWith(undefined)
    set_slide({ clear_plane: true })
    expect(view.clearSlidePlane).toHaveBeenCalledTimes(1)
    expect(set_slide({ drawing: 'create', max_raster: 512 })).toEqual({
      drawing: 'create',
    })
    expect(view.createSlideDrawing).toHaveBeenCalledWith({ maxRaster: 512 })
    set_slide({ drawing: 'create' })
    expect(view.createSlideDrawing).toHaveBeenLastCalledWith(undefined)
    set_slide({ drawing: 'undo' })
    set_slide({ drawing: 'end' })
    set_slide({ drawing: 'clear' })
    expect(view.slideDrawUndo).toHaveBeenCalledTimes(1)
    expect(view.slideDrawEnd).toHaveBeenCalledTimes(1)
    expect(view.clearSlideDrawing).toHaveBeenCalledTimes(1)
    expect(() => set_slide({})).toThrow(
      'set_slide needs something to do: level, clear_plane or drawing.',
    )
    expect(() => set_slide({ drawing: 'paint' })).toThrow(
      'Unknown drawing "paint". One of: create, clear, undo, end.',
    )
  })

  it('refuses a page without a slide plane or slide drawing', () => {
    const { set_slide } = viewportHandlers(hostOf(baseView()))
    expect(() => set_slide({ level: 1 })).toThrow(
      "This page's NiiVue has no slide plane.",
    )
    expect(() => set_slide({ drawing: 'undo' })).toThrow(
      "This page's NiiVue has no slide drawing.",
    )
  })
})

describe('chunk_stats', () => {
  it('reports the stream, timing and compensation, rebaking or resetting when asked', () => {
    const view = baseView({
      chunkStreamStats: () => ({ inFlight: 2 }),
      chunkTimingStats: () => ({ fetchMs: 12 }),
      resetChunkTiming: mock(),
      lodCompensation: () => ({ level: 1 }),
      rebakeChunkedOverlays: mock(),
    })
    const { chunk_stats } = viewportHandlers(hostOf(view))
    expect(chunk_stats({})).toEqual({
      stream: { inFlight: 2 },
      timing: { fetchMs: 12 },
      lodCompensation: { level: 1 },
    })
    expect(chunk_stats({ rebake: true, reset_timing: true })).toEqual({
      stream: { inFlight: 2 },
      timing: { fetchMs: 12 },
      lodCompensation: { level: 1 },
      timingReset: true,
    })
    expect(view.rebakeChunkedOverlays).toHaveBeenCalledTimes(1)
    expect(view.resetChunkTiming).toHaveBeenCalledTimes(1)
  })

  it('refuses a page that streams nothing', () => {
    const { chunk_stats } = viewportHandlers(hostOf(baseView()))
    expect(() => chunk_stats({})).toThrow(
      "This page's NiiVue streams no chunked volumes.",
    )
    const partial = viewportHandlers(
      hostOf(baseView({ chunkStreamStats: () => null })),
    )
    expect(partial.chunk_stats({})).toEqual({ stream: null })
    expect(() => partial.chunk_stats({ rebake: true })).toThrow(
      "This page's NiiVue cannot rebake its overlays.",
    )
    expect(() => partial.chunk_stats({ reset_timing: true })).toThrow(
      "This page's NiiVue keeps no chunk timing.",
    )
  })
})

describe('save', () => {
  const saving = () =>
    baseView({
      volumes: [{ name: 'base.nii.gz' }, { name: 'overlay.nii.gz' }],
      meshes: [{ name: 'lh.pial' }],
      saveDocument: mock(),
      saveVolume: mock(async () => {}),
      saveMesh: mock(async () => {}),
      saveBitmap: mock(async () => {}),
      saveDrawing: mock(async () => {}),
    })

  it('saves a document with its settings policy and format', async () => {
    const view = saving()
    const { save } = viewportHandlers(hostOf(view))
    expect(await save({ what: 'document' })).toEqual({
      saved: 'document',
      filename: 'scene.nvd',
    })
    expect(view.saveDocument).toHaveBeenLastCalledWith('scene.nvd', {})
    await save({
      what: 'document',
      filename: 'a.nvd',
      format: 'cbor',
      settings_never_saved: ['thumbnailUrl'],
    })
    expect(view.saveDocument).toHaveBeenLastCalledWith('a.nvd', {
      format: 'cbor',
      settings: { neverSave: ['thumbnailUrl'] },
    })
  })

  it('saves a volume, a mesh, a bitmap and the drawing', async () => {
    const view = saving()
    const { save } = viewportHandlers(hostOf(view))
    expect(
      await save({ what: 'volume', volume: 'overlay', drawing: true }),
    ).toEqual({ saved: 'volume', volume: 'overlay.nii.gz', drawing: true })
    expect(view.saveVolume).toHaveBeenLastCalledWith({
      isSaveDrawing: true,
      volumeByIndex: 1,
    })
    expect(await save({ what: 'volume', filename: 'out.nii' })).toEqual({
      saved: 'volume',
      volume: 'base.nii.gz',
      drawing: false,
      filename: 'out.nii',
    })
    expect(await save({ what: 'mesh' })).toEqual({
      saved: 'mesh',
      mesh: 'lh.pial',
      filename: 'mesh.mz3',
    })
    expect(view.saveMesh).toHaveBeenLastCalledWith(0, undefined)
    expect(await save({ what: 'bitmap', quality: 2 })).toEqual({
      saved: 'bitmap',
      filename: 'myBitmap.png',
    })
    expect(view.saveBitmap).toHaveBeenLastCalledWith(undefined, 1)
    expect(await save({ what: 'drawing', filename: 'd.nii' })).toEqual({
      saved: 'drawing',
      filename: 'd.nii',
    })
    expect(view.saveDrawing).toHaveBeenLastCalledWith('d.nii')
  })

  it('refuses no kind, an unknown kind and a page that cannot save', async () => {
    const { save } = viewportHandlers(hostOf(saving()))
    await expect(save({})).rejects.toThrow(
      'save needs what: one of document, volume, mesh, bitmap, drawing.',
    )
    await expect(save({ what: 'scene' })).rejects.toThrow(
      'Unknown what "scene"',
    )
    const bare = viewportHandlers(hostOf(baseView()))
    for (const [what, why] of [
      ['document', 'a document'],
      ['volume', 'a volume'],
      ['mesh', 'a mesh'],
      ['bitmap', 'a picture'],
      ['drawing', 'a drawing'],
    ]) {
      await expect(bare.save({ what })).rejects.toThrow(
        `This page's NiiVue cannot save ${why}.`,
      )
    }
  })
})

describe('load_document', () => {
  it('loads a document and reports what is shown afterwards', async () => {
    const view = baseView({
      meshes: [],
      loadDocument: mock(async (url: string) => {
        if (url.endsWith('bad')) throw new Error('not a document')
        view.volumes = [{ name: 'from-doc.nii.gz' }]
        view.meshes = [{ name: 'from-doc.mz3' }]
      }),
    })
    const { load_document } = viewportHandlers(hostOf(view))
    expect(
      await load_document({ url: 'https://x/scene.nvd', fill: 'current' }),
    ).toEqual({
      url: 'https://x/scene.nvd',
      fill: 'current',
      volumes: ['from-doc.nii.gz'],
      meshes: ['from-doc.mz3'],
    })
    expect(view.loadDocument).toHaveBeenLastCalledWith('https://x/scene.nvd', {
      fill: 'current',
    })
    expect(view.drawScene).toHaveBeenCalledTimes(1)
    await expect(load_document({ url: 'https://x/bad' })).rejects.toThrow(
      'The document at https://x/bad could not be loaded: not a document',
    )
    await expect(load_document({})).rejects.toThrow(
      'load_document needs a url.',
    )
    await expect(
      viewportHandlers(hostOf(baseView())).load_document({
        url: 'https://x/a',
      }),
    ).rejects.toThrow("This page's NiiVue cannot load a document.")
  })
})
