import { describe, expect, it, mock } from 'bun:test'

import { clipNormal, PLANE_ANGLES, PLANE_NONE, viewDirection } from '../planes'
import { nameFromUrl } from './params'
import {
  coreHandlers,
  looksMni,
  planeIsCut,
  sceneState,
  viewState,
} from './scene'
import type { NiiVueHost, ShownVolume, View, VolumeToLoad } from './view'

/** A volume as NiiVue would keep it after loading `volume`. */
const shown = (volume: VolumeToLoad): ShownVolume => ({
  name: volume.name ?? volume.url,
  url: volume.url,
  ...(volume.colormap === undefined ? {} : { colormap: volume.colormap }),
  ...(volume.opacity === undefined ? {} : { opacity: volume.opacity }),
})

/**
 * A volume 200 mm across, centred on the origin: mm = (frac - 0.5) * 200.
 * Loading replaces or extends `volumes` as NiiVue's model would.
 */
function fakeView(overrides: Partial<View> = {}): View {
  const volumes = () => view.volumes as ShownVolume[]
  const view: View = {
    canvas: null,
    volumes: [{ name: 'mni152.nii.gz' }],
    azimuth: 110,
    elevation: 15,
    crosshairPos: new Float32Array([0.5, 0.5, 0.5]),
    getCrosshairPos: () =>
      Array.from(view.crosshairPos).map((f) => (f - 0.5) * 200),
    getClipPlaneDepthAziElev: mock(
      () => [PLANE_NONE, 0, 0] as [number, number, number],
    ),
    setClipPlane: mock(),
    loadVolumes: mock(async (next: VolumeToLoad[]) => {
      volumes().splice(0, volumes().length, ...next.map(shown))
    }),
    drawScene: mock(),
    model: {
      mm2scene: (mm) => mm.map((v) => v / 200 + 0.5),
      scene2mm: (frac) => frac.map((f) => (f - 0.5) * 200),
    },
    ...overrides,
  }
  return view
}

/** Rounded, with -0 tidied, so two directions compare as numbers. */
const tidy = (v: readonly number[]) => v.map((n) => +n.toFixed(6) + 0)

function host(view = fakeView(), extra: Partial<NiiVueHost> = {}): NiiVueHost {
  return { view, ...extra }
}

describe('sceneState', () => {
  it("reports the volume, the crosshair in mm, the plane by name, and the host's extras", () => {
    const view = fakeView()
    view.crosshairPos[0] = 0.25
    const h = host(view, { extraState: () => ({ sounding: true }) })
    expect(sceneState(h)).toEqual({
      volume: 'mni152.nii.gz',
      crosshair: { mm: [-50, 0, 0] },
      plane: { name: 'off', depth: PLANE_NONE, azimuth: 0, elevation: 0 },
      sounding: true,
    })
  })

  it('is empty before a volume is loaded', () => {
    expect(sceneState(host(fakeView({ volumes: [] })))).toEqual({
      volume: null,
      crosshair: null,
      plane: null,
    })
  })

  it("calls a fresh NiiVue's default plane off, though it reads back at depth -2", () => {
    const view = fakeView({
      getClipPlaneDepthAziElev: () => [-PLANE_NONE, 0, 0],
    })
    expect(sceneState(host(view)).plane).toEqual({
      name: 'off',
      depth: -PLANE_NONE,
      azimuth: 0,
      elevation: 0,
    })
    expect(planeIsCut([-PLANE_NONE, 0, 0])).toBe(false)
    expect(planeIsCut([PLANE_NONE, 0, 0])).toBe(false)
    expect(planeIsCut([0, 0, 0])).toBe(true)
  })
})

describe('where_am_i', () => {
  it('reports the crosshair both ways, the plane, the camera, the description, and extras', async () => {
    const view = fakeView()
    view.crosshairPos[2] = 0.75
    const h = host(view, {
      describe: async () => 'up.',
      extraState: () => ({ sounding: false, mode: 'tone' }),
    })
    expect(await coreHandlers(h).where_am_i({})).toEqual({
      volume: 'mni152.nii.gz',
      crosshair: { mm: [0, 0, 50], frac: [0.5, 0.5, 0.75] },
      plane: { name: 'off', depth: PLANE_NONE, azimuth: 0, elevation: 0 },
      camera: { azimuth: 110, elevation: 15 },
      description: 'up.',
      sounding: false,
      mode: 'tone',
    })
  })

  it('describes the position itself when the host does not, and says so before a volume', async () => {
    expect(await coreHandlers(host()).where_am_i({})).toMatchObject({
      description: 'Crosshair at 0, 0, 0 mm.',
    })
    expect(
      await coreHandlers(host(fakeView({ volumes: [] }))).where_am_i({}),
    ).toEqual({ volume: null, description: 'No volume is loaded yet.' })
  })
})

describe('set_clip_plane', () => {
  it.each(
    PLANE_ANGLES.map((p) => [p.name, p.azimuth, p.elevation] as const),
  )('cuts %s at the depth asked and faces it', async (name, azimuth, elevation) => {
    const view = fakeView()
    const result = coreHandlers(host(view)).set_clip_plane({
      plane: name,
      depth: 0.25,
    })
    expect(view.setClipPlane).toHaveBeenCalledWith([0.25, azimuth, elevation])
    expect(result).toMatchObject({
      plane: { name, depth: 0.25, azimuth, elevation },
    })
    const looking = viewDirection(view.azimuth, view.elevation)
    expect(tidy(looking)).toEqual(tidy(clipNormal(azimuth, elevation)))
  })

  it('leaves the camera alone when told not to face the cut, and turns the plane off', () => {
    const view = fakeView()
    const announce = mock()
    const handlers = coreHandlers(host(view, { announce }))
    handlers.set_clip_plane({ plane: 'coronal', face: false })
    expect(view.setClipPlane).toHaveBeenLastCalledWith([0, 0, 0])
    expect(view.azimuth).toBe(110)
    expect(announce).toHaveBeenLastCalledWith('Cut plane: posterior.')
    handlers.set_clip_plane({ plane: 'off' })
    expect(view.setClipPlane).toHaveBeenLastCalledWith([PLANE_NONE, 0, 0])
    expect(announce).toHaveBeenLastCalledWith('Cut plane: off.')
    expect(() => handlers.set_clip_plane({ plane: 'current' })).toThrow(
      'Unknown plane "current"',
    )
    expect(() =>
      handlers.set_clip_plane({ plane: 'left', depth: 9 }),
    ).not.toThrow()
    expect(view.setClipPlane).toHaveBeenLastCalledWith([1.5, 270, 0])
  })
})

describe('set_camera', () => {
  it('turns the camera, wrapping the azimuth and clamping the elevation', () => {
    const view = fakeView()
    const result = coreHandlers(host(view)).set_camera({
      azimuth: -90,
      elevation: 120,
    })
    expect(result).toMatchObject({ camera: { azimuth: 270, elevation: 90 } })
    expect(view.drawScene).toHaveBeenCalled()
    expect(() =>
      coreHandlers(host(view)).set_camera({
        azimuth: 'sideways',
        elevation: 0,
      }),
    ).toThrow('azimuth must be a number')
  })
})

describe('set_view', () => {
  const laidOut = () =>
    fakeView({
      sliceType: 4,
      multiplanarType: 0,
      mosaicString: '',
      showRender: 2,
      isRadiological: false,
      isColorbarVisible: false,
    })

  it('sets each part by name, leaving the rest, and reports the whole layout', () => {
    const view = laidOut()
    const handlers = coreHandlers(host(view))
    expect(handlers.set_view({ slice: 'multiplanar', layout: 'grid' })).toEqual(
      {
        view: {
          slice: 'multiplanar',
          layout: 'grid',
          showRender: 'auto',
          radiological: false,
          colorbar: false,
        },
      },
    )
    expect([view.sliceType, view.multiplanarType]).toEqual([3, 2])
    expect(
      handlers.set_view({
        show_render: 'never',
        radiological: true,
        colorbar: true,
      }),
    ).toMatchObject({
      view: { showRender: 'never', radiological: true, colorbar: true },
    })
    expect(view.showRender).toBe(0)
    expect(
      handlers.set_view({ mosaic: ' A 0 20 40; C -10 0 10 ' }),
    ).toMatchObject({
      view: { mosaic: 'A 0 20 40; C -10 0 10', slice: 'multiplanar' },
    })
    expect(handlers.set_view({ mosaic: '' })).not.toHaveProperty('view.mosaic')
    expect(view.mosaicString).toBe('')
    expect(handlers.set_view({ slice: 'Axial' })).toMatchObject({
      view: { slice: 'axial' },
    })
    expect(view.drawScene).toHaveBeenCalledTimes(5)
  })

  it('works before a volume is loaded, and names a number it does not know as other', () => {
    const view = laidOut()
    view.volumes = []
    expect(
      coreHandlers(host(view)).set_view({ slice: 'render' }),
    ).toMatchObject({ view: { slice: 'render' } })
    view.sliceType = 5
    expect(viewState(view).slice).toBe('other')
  })

  it('refuses an unknown name, nothing to set, or a page without a layout', () => {
    const handlers = coreHandlers(host(laidOut()))
    expect(() => handlers.set_view({ slice: 'oblique' })).toThrow(
      'Unknown slice "oblique". One of: axial, coronal, sagittal, multiplanar, render.',
    )
    expect(() => handlers.set_view({ layout: 'stack' })).toThrow(
      'Unknown layout "stack"',
    )
    expect(() => handlers.set_view({ show_render: 'maybe' })).toThrow(
      'Unknown show_render "maybe"',
    )
    expect(() => handlers.set_view({})).toThrow('needs something to set')
    expect(() =>
      coreHandlers(host(fakeView())).set_view({ slice: 'axial' }),
    ).toThrow('no view layout')
  })
})

describe('screenshot', () => {
  it('draws, then returns the canvas as base64 PNG with its size', () => {
    const calls: string[] = []
    const canvas = {
      width: 640,
      height: 480,
      toDataURL: (type: string) => {
        calls.push(`toDataURL:${type}`)
        return 'data:image/png;base64,iVBORw0KGgo='
      },
    } as unknown as HTMLCanvasElement
    const view = fakeView({
      canvas,
      drawScene: mock(() => calls.push('draw')),
    })
    expect(coreHandlers(host(view)).screenshot({})).toEqual({
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
      width: 640,
      height: 480,
      canvas: { width: 640, height: 480 },
    })
    expect(calls).toEqual(['draw', 'toDataURL:image/png'])
    expect(() => coreHandlers(host(fakeView())).screenshot({})).toThrow(
      'no canvas',
    )
  })

  it('sizes an unsized canvas first and has the render backend draw the frame now', () => {
    const calls: string[] = []
    const canvas = {
      width: 300,
      height: 150,
      getBoundingClientRect: () => ({ width: 640, height: 480 }),
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
    } as unknown as HTMLCanvasElement
    const view = fakeView({
      canvas,
      resize: mock(() => calls.push('resize')),
      drawScene: mock(() => calls.push('draw')),
      view: { render: () => calls.push('render') },
    })
    coreHandlers(host(view)).screenshot({})
    expect(calls).toEqual(['resize', 'draw', 'render'])
  })

  it('refuses while the tab is in the background, where nothing is drawn', () => {
    const global = globalThis as { document?: unknown }
    const before = global.document
    global.document = { visibilityState: 'hidden' }
    try {
      const canvas = { width: 1, height: 1 } as unknown as HTMLCanvasElement
      expect(() =>
        coreHandlers(host(fakeView({ canvas }))).screenshot({}),
      ).toThrow(/background/)
    } finally {
      if (before === undefined) delete global.document
      else global.document = before
    }
  })
})

describe('load_volume', () => {
  it('loads by url with a name and colormap, guesses MNI from the name, and reports the extent', async () => {
    const view = fakeView()
    const loaded = mock()
    const result = await coreHandlers(host(view, { loaded })).load_volume({
      url: 'https://x/y/MNI152_T1.nii.gz?x=1',
    })
    expect(view.loadVolumes).toHaveBeenCalledWith([
      {
        url: 'https://x/y/MNI152_T1.nii.gz?x=1',
        name: 'MNI152_T1.nii.gz',
        colormap: 'gray',
      },
    ])
    expect(loaded).toHaveBeenCalledWith({
      url: 'https://x/y/MNI152_T1.nii.gz?x=1',
      name: 'MNI152_T1.nii.gz',
      mni: true,
    })
    expect(result).toMatchObject({
      mni: true,
      bounds: { mm: { min: [-100, -100, -100], max: [100, 100, 100] } },
    })
    const head = await coreHandlers(host(view, { loaded })).load_volume({
      url: 'https://x/chris_t1.nii.gz',
      mni: false,
      colormap: 'bone',
    })
    expect(head).toMatchObject({ mni: false })
    expect(view.loadVolumes).toHaveBeenLastCalledWith([
      {
        url: 'https://x/chris_t1.nii.gz',
        name: 'chris_t1.nii.gz',
        colormap: 'bone',
      },
    ])
  })

  it('says why a load failed, in words', async () => {
    const view = fakeView({
      loadVolumes: mock(async () => Promise.reject(new Error('404'))),
    })
    await expect(
      coreHandlers(host(view)).load_volume({ url: 'https://x/none.nii.gz' }),
    ).rejects.toThrow(
      'The volume at https://x/none.nii.gz could not be loaded: 404',
    )
    await expect(coreHandlers(host(view)).load_volume({})).rejects.toThrow(
      'needs a url',
    )
  })

  it('names a file from its url and spots MNI in a name', () => {
    expect(
      nameFromUrl('https://niivue.github.io/niivue-demo-images/mni152.nii.gz'),
    ).toBe('mni152.nii.gz')
    expect(nameFromUrl('blob:http://localhost/abc')).toBe('abc')
    expect(looksMni('mni152.nii.gz')).toBe(true)
    expect(looksMni('chris_t1.nii.gz')).toBe(false)
  })
})

describe('go_to_point', () => {
  it('lands on the point, cuts through it facing the camera, samples, and announces with the label', async () => {
    const view = fakeView()
    const moved = mock()
    const announce = mock()
    const handlers = coreHandlers(
      host(view, { moved, announce, describe: () => 'left, back, low.' }),
    )
    const result = (await handlers.go_to_point({
      mm: [-24, -20, -14],
      plane: 'left',
      label: 'Left hippocampus',
    })) as {
      landed: { mm: number[]; frac: number[] }
      plane: { name: string; depth: number }
      description: string
    }
    expect(tidy(result.landed.frac)).toEqual([0.38, 0.4, 0.43])
    expect(tidy(Array.from(view.crosshairPos))).toEqual([0.38, 0.4, 0.43])
    expect(view.setClipPlane).toHaveBeenCalledTimes(1)
    expect(result.plane.name).toBe('left')
    expect(moved).toHaveBeenCalledWith(
      [0.38, 0.4, 0.43].map((f) => expect.closeTo(f, 6)),
    )
    expect(result.description).toBe('Left hippocampus. left, back, low.')
    expect(announce).toHaveBeenCalledWith('Left hippocampus. left, back, low.')
  })

  it("works without an atlas, which a subject's own scan does not have", async () => {
    const view = fakeView({ volumes: [{ name: 'sub-01_T1w.nii.gz' }] })
    const handlers = coreHandlers({ view })
    const result = (await handlers.go_to_point({ mm: [10, 0, 0] })) as {
      description: string
    }
    expect(result.description).toBe('Crosshair at 10, 0, 0 mm.')
  })

  it('refuses a point outside the volume, a malformed point, or no volume', async () => {
    const handlers = coreHandlers(host())
    await expect(handlers.go_to_point({ mm: [500, 0, 0] })).rejects.toThrow(
      /outside the loaded volume/,
    )
    await expect(handlers.go_to_point({ mm: [1, 2] })).rejects.toThrow(
      /three numbers/,
    )
    await expect(
      coreHandlers(host(fakeView({ volumes: [] }))).go_to_point({
        mm: [0, 0, 0],
      }),
    ).rejects.toThrow(/load_volume/)
  })
})
