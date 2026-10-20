import { describe, expect, it, mock } from 'bun:test'

import { PLANE_NONE } from '../planes'
import { nameFromUrl } from './params'
import { coreHandlers, looksMni, planeIsCut, sceneState } from './scene'
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
