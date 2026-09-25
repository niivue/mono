import { describe, expect, it, mock } from 'bun:test'

import { clipNormal, PLANE_ANGLES, PLANE_NONE, viewDirection } from '../planes'
import {
  type AtlasLike,
  type AtlasRegion,
  coreHandlers,
  looksMni,
  type NiiVueHost,
  nameFromUrl,
  sceneState,
  type View,
} from './scene'

/** A volume 200 mm across, centred on the origin: mm = (frac - 0.5) * 200. */
function fakeView(overrides: Partial<View> = {}): View {
  const crosshairPos = new Float32Array([0.5, 0.5, 0.5])
  const view: View = {
    canvas: null,
    volumes: [{ name: 'mni152.nii.gz' }],
    azimuth: 110,
    elevation: 15,
    crosshairPos,
    getCrosshairPos: () => Array.from(crosshairPos).map((f) => (f - 0.5) * 200),
    getClipPlaneDepthAziElev: mock(
      () => [PLANE_NONE, 0, 0] as [number, number, number],
    ),
    setClipPlane: mock(),
    loadVolumes: mock(async () => undefined),
    drawScene: mock(),
    model: {
      mm2scene: (mm) => mm.map((v) => v / 200 + 0.5),
      scene2mm: (frac) => frac.map((f) => (f - 0.5) * 200),
    },
    ...overrides,
  }
  return view
}

const REGIONS: AtlasRegion[] = [
  {
    label: 'Insula_L',
    name: 'left insula',
    centroid: [-36, 6, 2],
    voxels: 100,
    value: 29,
  },
  {
    label: 'Insula_R',
    name: 'right insula',
    centroid: [38, 6, 2],
    voxels: 100,
    value: 30,
  },
  {
    label: 'Precentral_L',
    name: 'left precentral gyrus',
    centroid: [-40, -6, 50],
    voxels: 300,
    value: 1,
  },
  {
    label: 'Hippocampus_L',
    name: 'left hippocampus',
    centroid: [-24, -20, -14],
    voxels: 200,
    value: 37,
  },
]

/** Each region owns the 10 mm around its centroid, except the hippocampus, whose centroid is outside it. */
const fakeAtlas = (): AtlasLike => ({
  regions: () => REGIONS,
  regionAt: (mm) => REGIONS.find((r) => near(r.centroid, mm))?.name ?? null,
  valueAt: (mm) => {
    const region = REGIONS.find((r) => near(r.centroid, mm))
    if (!region) return 0
    return region.label === 'Hippocampus_L' ? 0 : region.value
  },
  nearestIn: (value, mm) => (value === 37 ? [mm[0], mm[1] - 6, mm[2]] : null),
})

/** Rounded, with -0 tidied, so two directions compare as numbers. */
const tidy = (v: readonly number[]) => v.map((n) => +n.toFixed(6) + 0)

const near = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 10

function host(view = fakeView(), extra: Partial<NiiVueHost> = {}): NiiVueHost {
  return { view, atlas: async () => fakeAtlas(), ...extra }
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
})

describe('go_to_region', () => {
  it('lands on the centroid, cuts through it, faces the cut, samples, and announces', async () => {
    const view = fakeView()
    const moved = mock()
    const announce = mock()
    const h = host(view, {
      moved,
      announce,
      describe: () => 'left insula. left, front, level.',
      beforeAnswer: mock(),
    })
    const result = (await coreHandlers(h).go_to_region({
      region: 'left insula',
      plane: 'left',
    })) as Record<string, unknown>
    expect(result).toMatchObject({
      region: { label: 'Insula_L', name: 'left insula' },
      landed: { mm: [-36, 6, 2], frac: [0.32, 0.53, 0.51] },
      snapped: false,
      plane: { name: 'left', azimuth: 270, elevation: 0 },
      camera: { azimuth: 90, elevation: 0 },
      description: 'left insula. left, front, level.',
    })
    expect(Array.from(view.crosshairPos)).toEqual(
      [0.32, 0.53, 0.51].map((f) => Math.fround(f)),
    )
    expect(moved).toHaveBeenCalledWith([0.32, 0.53, 0.51])
    expect(announce).toHaveBeenCalledWith('left insula. left, front, level.')
    expect(h.beforeAnswer).toHaveBeenCalled()
    // The plane passes through the landing point: the plane's depth undoes the point's offset along the normal.
    const [depth, az, el] = (view.setClipPlane as ReturnType<typeof mock>).mock
      .calls[0][0] as number[]
    const n = clipNormal(az, el)
    expect(n[0] * (0.32 - 0.5) + n[1] * 0.03 + n[2] * 0.01 + depth).toBeCloseTo(
      0,
      6,
    )
  })

  it.each(
    PLANE_ANGLES.map((p) => [p.name, p.azimuth, p.elevation] as const),
  )('cuts %s and looks along the normal at the exposed face', async (name, azimuth, elevation) => {
    const view = fakeView()
    const result = (await coreHandlers(host(view)).go_to_region({
      region: 'Insula_R',
      plane: name,
    })) as {
      plane: { azimuth: number; elevation: number }
      camera: { azimuth: number; elevation: number }
    }
    expect(result.plane).toMatchObject({ name, azimuth, elevation })
    const looking = viewDirection(
      result.camera.azimuth,
      result.camera.elevation,
    )
    const normal = clipNormal(azimuth, elevation)
    expect(tidy(looking)).toEqual(tidy(normal))
    expect(view.azimuth).toBe(result.camera.azimuth)
  })

  it('accepts the slice names and `current`, and cuts coronal when nothing is cut', async () => {
    const view = fakeView()
    const handlers = coreHandlers(host(view))
    expect(
      await handlers.go_to_region({ region: 'Insula_R', plane: 'axial' }),
    ).toMatchObject({ plane: { name: 'superior' } })
    expect(await handlers.go_to_region({ region: 'Insula_R' })).toMatchObject({
      plane: { name: 'posterior' },
    })
    ;(view.getClipPlaneDepthAziElev as ReturnType<typeof mock>).mockReturnValue(
      [0.1, 90, 0],
    )
    expect(
      await handlers.go_to_region({ region: 'Insula_R', plane: 'current' }),
    ).toMatchObject({ plane: { name: 'right' } })
  })

  it('refuses an ambiguous name with the choices, and an unknown one with advice', async () => {
    const handlers = coreHandlers(host())
    await expect(handlers.go_to_region({ region: 'insula' })).rejects.toThrow(
      '"insula" could mean 2 regions: Insula_L (left insula), Insula_R (right insula). Say which.',
    )
    await expect(handlers.go_to_region({ region: 'thalamus' })).rejects.toThrow(
      'No region matches "thalamus". Call list_regions',
    )
    await expect(handlers.go_to_region({})).rejects.toThrow(
      'needs a region name',
    )
    await expect(
      handlers.go_to_region({ region: 'Insula_L', plane: 'diagonal' }),
    ).rejects.toThrow('Unknown plane "diagonal"')
  })

  it('snaps into a region whose centroid lies outside it', async () => {
    const result = await coreHandlers(host()).go_to_region({
      region: 'Hippocampus_L',
    })
    expect(result).toMatchObject({
      snapped: true,
      landed: { mm: [-24, -26, -14] },
    })
  })

  it('refuses without a volume, without an atlas that applies, or outside the volume', async () => {
    await expect(
      coreHandlers(host(fakeView({ volumes: [] }))).go_to_region({
        region: 'Insula_L',
      }),
    ).rejects.toThrow('No volume is loaded yet')
    await expect(
      coreHandlers(
        host(fakeView(), { atlasApplies: () => false }),
      ).go_to_region({ region: 'Insula_L' }),
    ).rejects.toThrow('not in MNI space')
    await expect(
      coreHandlers({ view: fakeView() }).go_to_region({ region: 'Insula_L' }),
    ).rejects.toThrow('no atlas')
    const small = fakeView({
      model: {
        mm2scene: (mm) => mm.map((v) => v / 20 + 0.5),
        scene2mm: (f) => f.map((v) => (v - 0.5) * 20),
      },
    })
    await expect(
      coreHandlers(host(small)).go_to_region({ region: 'Insula_L' }),
    ).rejects.toThrow('lies outside the loaded volume')
  })
})

describe('list_regions', () => {
  it('lists every region as a summary, or those a query mentions', async () => {
    const handlers = coreHandlers(host())
    const all = (await handlers.list_regions({})) as unknown[]
    expect(all).toHaveLength(4)
    expect(all[0]).toEqual({
      label: 'Insula_L',
      name: 'left insula',
      centroid: [-36, 6, 2],
      voxels: 100,
    })
    expect(await handlers.list_regions({ query: 'precentral' })).toEqual([
      {
        label: 'Precentral_L',
        name: 'left precentral gyrus',
        centroid: [-40, -6, 50],
        voxels: 300,
      },
    ])
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

describe('add_overlay', () => {
  it('keeps the base, loads the overlay over it, and draws a label map with its table', async () => {
    const setColormapLabel = mock()
    const view = fakeView({ setColormapLabel })
    const handlers = coreHandlers(host(view))
    await handlers.load_volume({ url: 'http://h/t1/sub-01_T1w.nii.gz' })
    const result = (await handlers.add_overlay({
      url: 'http://h/labels/synthseg.nii.gz',
      labels: 'freesurfer',
    })) as {
      volumes: Array<{ name: string; labels?: string; opacity?: number }>
    }
    expect(view.loadVolumes).toHaveBeenLastCalledWith([
      {
        url: 'http://h/t1/sub-01_T1w.nii.gz',
        name: 'sub-01_T1w.nii.gz',
        colormap: 'gray',
      },
      {
        url: 'http://h/labels/synthseg.nii.gz',
        name: 'synthseg.nii.gz',
        colormap: 'gray',
        opacity: 0.5,
      },
    ])
    expect(setColormapLabel).toHaveBeenCalledWith(1, 'freesurfer')
    expect(result.volumes.map((v) => v.name)).toEqual([
      'sub-01_T1w.nii.gz',
      'synthseg.nii.gz',
    ])
    expect(result.volumes[1]).toMatchObject({
      labels: 'freesurfer',
      opacity: 0.5,
    })
  })

  it('uses a colormap for a non-label overlay and clamps the opacity', async () => {
    const view = fakeView()
    const handlers = coreHandlers(host(view))
    await handlers.load_volume({ url: 'http://h/t1.nii.gz' })
    await handlers.add_overlay({
      url: 'http://h/zstat.nii.gz',
      colormap: 'red',
      opacity: 3,
    })
    expect(view.loadVolumes).toHaveBeenLastCalledWith([
      { url: 'http://h/t1.nii.gz', name: 't1.nii.gz', colormap: 'gray' },
      {
        url: 'http://h/zstat.nii.gz',
        name: 'zstat.nii.gz',
        colormap: 'red',
        opacity: 1,
      },
    ])
  })

  it('refuses without a base loaded through load_volume, an unknown table, or a page that cannot draw labels', async () => {
    const view = fakeView()
    const handlers = coreHandlers(host(view))
    await expect(
      handlers.add_overlay({ url: 'http://h/x.nii.gz' }),
    ).rejects.toThrow(/load_volume/)
    await handlers.load_volume({ url: 'http://h/t1.nii.gz' })
    await expect(
      handlers.add_overlay({ url: 'http://h/x.nii.gz', labels: 'aal' }),
    ).rejects.toThrow(/Unknown label table/)
    await expect(
      handlers.add_overlay({ url: 'http://h/x.nii.gz', labels: 'freesurfer' }),
    ).rejects.toThrow(/label maps/)
  })

  it('keeps what was shown when the overlay fails to load', async () => {
    let calls = 0
    const view = fakeView({
      loadVolumes: mock(async () => {
        if (++calls === 2) throw new Error('404')
      }),
    })
    const handlers = coreHandlers(host(view))
    await handlers.load_volume({ url: 'http://h/t1.nii.gz' })
    await expect(
      handlers.add_overlay({ url: 'http://h/missing.nii.gz' }),
    ).rejects.toThrow(/could not be loaded: 404/)
    await handlers.add_overlay({ url: 'http://h/ok.nii.gz' })
    expect(view.loadVolumes).toHaveBeenLastCalledWith([
      { url: 'http://h/t1.nii.gz', name: 't1.nii.gz', colormap: 'gray' },
      {
        url: 'http://h/ok.nii.gz',
        name: 'ok.nii.gz',
        colormap: 'warm',
        opacity: 0.7,
      },
    ])
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
