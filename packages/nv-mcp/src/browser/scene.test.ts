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
import type {
  AtlasLike,
  AtlasRegion,
  NiiVueHost,
  ShownVolume,
  View,
  VolumeToLoad,
  VolumeUpdate,
} from './view'

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
    addVolume: mock(async (volume: VolumeToLoad) => {
      volumes().push(shown(volume))
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
      volumes: [{ index: 0, name: 'mni152.nii.gz' }],
      crosshair: { mm: [0, 0, 50], frac: [0.5, 0.5, 0.75] },
      plane: { name: 'off', depth: PLANE_NONE, azimuth: 0, elevation: 0 },
      camera: { azimuth: 110, elevation: 15 },
      description: 'up.',
      sounding: false,
      mode: 'tone',
    })
  })

  it('adds the view layout by name when the page has one, and each volume with its window', async () => {
    const view = fakeView({
      volumes: [
        { name: 'mni152.nii.gz', calMin: 0, calMax: 100, nFrame4D: 1 },
        {
          name: 'bold.nii.gz',
          colormap: 'warm',
          opacity: 0.7,
          calMin: 10,
          calMax: 90,
          globalMin: -5,
          globalMax: 120,
          frame4D: 3,
          nFrame4D: 200,
          isColormapInverted: true,
        },
      ],
      sliceType: 3,
      multiplanarType: 2,
      mosaicString: '',
      showRender: 2,
      isRadiological: false,
      isColorbarVisible: true,
    })
    expect(await coreHandlers(host(view)).where_am_i({})).toMatchObject({
      volumes: [
        { index: 0, name: 'mni152.nii.gz', calMin: 0, calMax: 100 },
        {
          index: 1,
          name: 'bold.nii.gz',
          colormap: 'warm',
          opacity: 0.7,
          calMin: 10,
          calMax: 90,
          globalMin: -5,
          globalMax: 120,
          frame: 3,
          frames: 200,
          inverted: true,
        },
      ],
      view: {
        slice: 'multiplanar',
        layout: 'grid',
        showRender: 'auto',
        radiological: false,
        colorbar: true,
      },
    })
    expect(
      (await coreHandlers(host(view)).where_am_i({})) as { view: object },
    ).not.toHaveProperty('view.mosaic')
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

/** A view whose NiiVue can change a volume, with a 4D overlay over the base. */
function settableView(): View {
  const view = fakeView({
    volumes: [
      { name: 'mni152.nii.gz', calMin: 0, calMax: 100, nFrame4D: 1 },
      {
        name: 'bold.nii.gz',
        colormap: 'warm',
        opacity: 0.7,
        calMin: 10,
        calMax: 90,
        globalMin: -5,
        globalMax: 120,
        frame4D: 0,
        nFrame4D: 200,
      },
      { name: 'bold_mask.nii.gz' },
    ],
    setVolume: mock(async (index: number, update: VolumeUpdate) => {
      Object.assign(view.volumes[index], update)
    }),
  })
  return view
}

describe('set_volume', () => {
  it('changes only what was asked on the base volume, and reports it as drawn now', async () => {
    const view = settableView()
    const result = await coreHandlers(host(view)).set_volume({
      colormap: 'bone',
      cal_max: 80,
    })
    expect(view.setVolume).toHaveBeenCalledWith(0, {
      colormap: 'bone',
      calMax: 80,
    })
    expect(result).toEqual({
      volume: {
        index: 0,
        name: 'mni152.nii.gz',
        colormap: 'bone',
        calMin: 0,
        calMax: 80,
      },
    })
    expect(view.drawScene).toHaveBeenCalled()
  })

  it('finds the volume by index or by name, clamps the opacity, and picks a frame', async () => {
    const view = settableView()
    const handlers = coreHandlers(host(view))
    expect(
      await handlers.set_volume({ volume: 1, opacity: 2, frame: 7 }),
    ).toMatchObject({
      volume: {
        index: 1,
        name: 'bold.nii.gz',
        opacity: 1,
        frame: 7,
        frames: 200,
      },
    })
    expect(view.setVolume).toHaveBeenLastCalledWith(1, {
      opacity: 1,
      frame4D: 7,
    })
    expect(
      await handlers.set_volume({ volume: 'bold_mask', invert: true }),
    ).toMatchObject({ volume: { index: 2, inverted: true } })
    expect(
      await handlers.set_volume({ volume: 'BOLD.nii.gz', invert: false }),
    ).toMatchObject({ volume: { index: 1 } })
    expect(view.setVolume).toHaveBeenLastCalledWith(1, {
      isColormapInverted: false,
    })
    expect(
      await handlers.set_volume({ volume: '2', opacity: 0 }),
    ).toMatchObject({ volume: { index: 2, opacity: 0 } })
  })

  it('refuses an empty window, a frame the volume does not have, and nothing to set', async () => {
    const handlers = coreHandlers(host(settableView()))
    await expect(
      handlers.set_volume({ volume: 1, cal_min: 95 }),
    ).rejects.toThrow('cal_min (95) must not be above cal_max (90)')
    await expect(
      handlers.set_volume({ cal_min: 50, cal_max: 40 }),
    ).rejects.toThrow('cal_min (50) must not be above cal_max (40)')
    await expect(handlers.set_volume({ frame: 1 })).rejects.toThrow(
      'mni152.nii.gz has one frame only',
    )
    await expect(
      handlers.set_volume({ volume: 1, frame: 200 }),
    ).rejects.toThrow('bold.nii.gz has 200 frames, numbered 0 to 199')
    await expect(
      handlers.set_volume({ volume: 1, frame: 1.5 }),
    ).rejects.toThrow('whole number')
    await expect(handlers.set_volume({})).rejects.toThrow(
      'needs something to set',
    )
    await expect(handlers.set_volume({ opacity: 'thin' })).rejects.toThrow(
      'opacity must be a number',
    )
  })

  it('refuses a volume it cannot find, an ambiguous name, no volume, or a page that cannot change one', async () => {
    const handlers = coreHandlers(host(settableView()))
    await expect(
      handlers.set_volume({ volume: 3, opacity: 1 }),
    ).rejects.toThrow('There is no volume 3: 3 shown, numbered from 0')
    await expect(
      handlers.set_volume({ volume: 'bold', opacity: 1 }),
    ).rejects.toThrow(
      '"bold" could mean 2 volumes: 1 (bold.nii.gz), 2 (bold_mask.nii.gz). Say which',
    )
    await expect(
      handlers.set_volume({ volume: 'zstat', opacity: 1 }),
    ).rejects.toThrow('No volume is named "zstat". Shown: mni152.nii.gz, bold')
    await expect(
      coreHandlers(host(fakeView({ volumes: [] }))).set_volume({ opacity: 1 }),
    ).rejects.toThrow(/load_volume/)
    await expect(
      coreHandlers(host(fakeView())).set_volume({ opacity: 1 }),
    ).rejects.toThrow('cannot change a volume')
  })
})

describe('set_volume chunk_grid and spread', () => {
  /** A view whose NiiVue tiles and spreads, keeping the volume's fields as NiiVue would. */
  function chunkableView(): View {
    const view = settableView()
    view.setVolumeChunkGrid = mock(async (index: number, grid) => {
      const volume = view.volumes[index]
      volume.chunkPlan = grid ? { gridDims: grid } : undefined
      if (!grid) volume.chunkExplode = undefined
    })
    view.setVolumeChunkExplode = mock((index: number, explode) => {
      view.volumes[index].chunkExplode = explode ?? undefined
    })
    return view
  }

  it('tiles the volume into the grid asked for and reports it', async () => {
    const view = chunkableView()
    const got = await coreHandlers(host(view)).set_volume({
      chunk_grid: [2, 3, 4],
    })
    expect(view.setVolumeChunkGrid).toHaveBeenCalledWith(0, [2, 3, 4])
    expect(view.setVolumeChunkExplode).not.toHaveBeenCalled()
    expect(got).toMatchObject({ volume: { chunkGrid: [2, 3, 4] } })
    expect(got).not.toHaveProperty('volume.spread')
    expect(view.drawScene).toHaveBeenCalled()
  })

  it('tiles 3 by 3 by 3 before spreading a volume that is one texture', async () => {
    const view = chunkableView()
    const got = await coreHandlers(host(view)).set_volume({ spread: 1.5 })
    expect(view.setVolumeChunkGrid).toHaveBeenCalledWith(0, [3, 3, 3])
    expect(view.setVolumeChunkExplode).toHaveBeenCalledWith(0, {
      enabled: true,
      scale: [1.5, 1.5, 1.5],
    })
    expect(got).toMatchObject({
      volume: { chunkGrid: [3, 3, 3], spread: 1.5 },
    })
  })

  it('uses the grid given in the same call, and a spread of 1 closes the bricks up', async () => {
    const view = chunkableView()
    const handlers = coreHandlers(host(view))
    await handlers.set_volume({ volume: 1, chunk_grid: [2, 2, 2], spread: 2 })
    expect(view.setVolumeChunkGrid).toHaveBeenCalledTimes(1)
    expect(view.setVolumeChunkGrid).toHaveBeenCalledWith(1, [2, 2, 2])
    expect(view.setVolumeChunkExplode).toHaveBeenCalledWith(1, {
      enabled: true,
      scale: [2, 2, 2],
    })
    const closed = await handlers.set_volume({ volume: 1, spread: 1 })
    expect(view.setVolumeChunkExplode).toHaveBeenLastCalledWith(1, null)
    expect(closed).toMatchObject({ volume: { chunkGrid: [2, 2, 2] } })
    expect(closed).not.toHaveProperty('volume.spread')
    const single = await handlers.set_volume({ volume: 1, chunk_grid: null })
    expect(view.setVolumeChunkGrid).toHaveBeenLastCalledWith(1, null)
    expect(single).not.toHaveProperty('volume.chunkGrid')
  })

  it('refuses a bad grid or spread before changing anything, and a page that cannot', async () => {
    const view = chunkableView()
    const handlers = coreHandlers(host(view))
    await expect(handlers.set_volume({ chunk_grid: [2, 2] })).rejects.toThrow(
      /chunk_grid/,
    )
    await expect(
      handlers.set_volume({ chunk_grid: [2, 2.5, 2] }),
    ).rejects.toThrow(/chunk_grid/)
    await expect(handlers.set_volume({ spread: 0.5 })).rejects.toThrow(/spread/)
    expect(view.setVolumeChunkGrid).not.toHaveBeenCalled()
    const plain = coreHandlers(host(settableView()))
    await expect(plain.set_volume({ chunk_grid: [2, 2, 2] })).rejects.toThrow(
      /cannot chunk/,
    )
    await expect(plain.set_volume({ spread: 2 })).rejects.toThrow(
      /cannot spread/,
    )
  })
})

describe('set_labels', () => {
  it('labels regions at their centroids with their spoken names, and points with their text', async () => {
    const labels = mock()
    const view = fakeView()
    const got = await coreHandlers(host(view, { labels })).set_labels({
      labels: [
        { region: 'Insula_L' },
        { region: 'right insula', text: 'Insula' },
        { mm: [1, 2, 3], text: 'here' },
      ],
    })
    expect(labels).toHaveBeenCalledWith([
      { text: 'left insula', mm: [-36, 6, 2] },
      { text: 'Insula', mm: [38, 6, 2] },
      { text: 'here', mm: [1, 2, 3] },
    ])
    expect(got).toEqual({
      labels: [
        { text: 'left insula', mm: [-36, 6, 2], region: 'Insula_L' },
        { text: 'Insula', mm: [38, 6, 2], region: 'Insula_R' },
        { text: 'here', mm: [1, 2, 3] },
      ],
    })
    expect(view.drawScene).toHaveBeenCalled()
  })

  function brickedView(): View {
    const corners = (mm: ArrayLike<number>): Array<[number, number, number]> =>
      Array.from({ length: 8 }, (_, c) => [
        mm[0] + (c & 1 ? 1 : -1),
        mm[1] + (c & 2 ? 1 : -1),
        mm[2] + (c & 4 ? 1 : -1),
      ])
    return fakeView({
      volumes: [{ name: 'mni152.nii.gz', chunkPlan: { gridDims: [2, 1, 1] } }],
      chunkBrickIndexAt: mock((mm: ArrayLike<number>) =>
        mm[0] < 0 ? 0 : mm[0] < 100 ? 1 : -1,
      ),
      chunkBrickCornersAt: mock(corners),
      setVolumeBrickOpacity: mock(),
    })
  }

  it('on a tiled volume names and outlines each brick, and dims the others when asked', async () => {
    const labels = mock()
    const view = brickedView()
    const handlers = coreHandlers(host(view, { labels }))
    const got = await handlers.set_labels({
      labels: [{ region: 'Insula_L' }, { mm: [500, 0, 0], text: 'outside' }],
      dim_others: 0.2,
    })
    expect(got).toEqual({
      labels: [
        { text: 'left insula', mm: [-36, 6, 2], region: 'Insula_L', brick: 0 },
        { text: 'outside', mm: [500, 0, 0] },
      ],
      dimOthers: 0.2,
    })
    expect(labels).toHaveBeenCalledWith([
      {
        text: 'left insula',
        mm: [-36, 6, 2],
        boxMM: [
          [-37, 5, 1],
          [-35, 5, 1],
          [-37, 7, 1],
          [-35, 7, 1],
          [-37, 5, 3],
          [-35, 5, 3],
          [-37, 7, 3],
          [-35, 7, 3],
        ],
      },
      { text: 'outside', mm: [500, 0, 0] },
    ])
    expect(view.setVolumeBrickOpacity).toHaveBeenLastCalledWith(0, [1, 0.2])
    // Without dim_others the bricks are drawn alike again, as they are on clear.
    await handlers.set_labels({ labels: [{ mm: [10, 0, 0], text: 'right' }] })
    expect(view.setVolumeBrickOpacity).toHaveBeenLastCalledWith(0, null)
    await handlers.set_labels({ clear: true })
    expect(view.setVolumeBrickOpacity).toHaveBeenLastCalledWith(0, null)
    expect(labels).toHaveBeenLastCalledWith([])
  })

  it('counts bricks from the plan and refuses dim_others where it cannot apply', async () => {
    const labels = mock()
    const view = brickedView()
    view.volumes[0].chunkPlan = { gridDims: [3, 1, 1], chunks: [1, 2, 3] }
    await coreHandlers(host(view, { labels })).set_labels({
      labels: [{ mm: [10, 0, 0], text: 'b' }],
      dim_others: 0,
    })
    expect(view.setVolumeBrickOpacity).toHaveBeenLastCalledWith(0, [0, 1, 0])
    await expect(
      coreHandlers(host(view, { labels })).set_labels({
        labels: [{ mm: [10, 0, 0], text: 'b' }],
        dim_others: 2,
      }),
    ).rejects.toThrow(/0 to 1/)
    await expect(
      coreHandlers(
        host(fakeView({ setVolumeBrickOpacity: mock() }), { labels }),
      ).set_labels({
        labels: [{ mm: [10, 0, 0], text: 'b' }],
        dim_others: 0.5,
      }),
    ).rejects.toThrow(/chunk_grid/)
    const plain = brickedView()
    plain.setVolumeBrickOpacity = undefined
    await expect(
      coreHandlers(host(plain, { labels })).set_labels({
        labels: [{ mm: [10, 0, 0], text: 'b' }],
        dim_others: 0.5,
      }),
    ).rejects.toThrow(/cannot dim/)
    // A plain volume's labels carry no brick and no box.
    await coreHandlers(host(fakeView(), { labels })).set_labels({
      labels: [{ mm: [10, 0, 0], text: 'b' }],
    })
    expect(labels).toHaveBeenLastCalledWith([{ text: 'b', mm: [10, 0, 0] }])
  })

  it('clears with an empty list, and refuses nothing to do', async () => {
    const labels = mock()
    const handlers = coreHandlers(host(fakeView(), { labels }))
    expect(await handlers.set_labels({ clear: true })).toEqual({ labels: [] })
    expect(labels).toHaveBeenCalledWith([])
    await expect(handlers.set_labels({})).rejects.toThrow(/needs labels/)
    await expect(handlers.set_labels({ labels: [] })).rejects.toThrow(
      /needs labels/,
    )
  })

  it('refuses an unknown or ambiguous region, a point without text, and a page without the hook', async () => {
    const labels = mock()
    const handlers = coreHandlers(host(fakeView(), { labels }))
    await expect(
      handlers.set_labels({ labels: [{ region: 'Amygdala' }] }),
    ).rejects.toThrow(/No region matches/)
    await expect(
      handlers.set_labels({ labels: [{ region: 'insula' }] }),
    ).rejects.toThrow(/Insula_L/)
    await expect(
      handlers.set_labels({ labels: [{ mm: [0, 0, 0] }] }),
    ).rejects.toThrow(/needs its text/)
    await expect(
      handlers.set_labels({ labels: [{ text: 'lost' }] }),
    ).rejects.toThrow(/region or gives mm/)
    expect(labels).not.toHaveBeenCalled()
    await expect(
      coreHandlers(host(fakeView())).set_labels({
        labels: [{ region: 'Insula_L' }],
      }),
    ).rejects.toThrow(/cannot draw labels/)
    await expect(
      coreHandlers(
        host(fakeView(), { labels, atlasApplies: () => false }),
      ).set_labels({ labels: [{ region: 'Insula_L' }] }),
    ).rejects.toThrow(/MNI/)
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
  it('draws, then returns the canvas as base64 PNG with its size', async () => {
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
    expect(await coreHandlers(host(view)).screenshot({})).toEqual({
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
      width: 640,
      height: 480,
      canvas: { width: 640, height: 480 },
    })
    expect(calls).toEqual(['draw', 'toDataURL:image/png'])
    await expect(coreHandlers(host(fakeView())).screenshot({})).rejects.toThrow(
      'no canvas',
    )
  })

  it('waits for the bricks of a chunked volume to arrive before drawing', async () => {
    const calls: string[] = []
    const canvas = {
      width: 640,
      height: 480,
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
    } as unknown as HTMLCanvasElement
    const view = fakeView({
      canvas,
      whenChunkStreamSettles: mock(async () => {
        calls.push('settle')
      }),
      drawScene: mock(() => calls.push('draw')),
    })
    await coreHandlers(host(view)).screenshot({})
    expect(calls).toEqual(['settle', 'draw'])
  })

  it('sizes an unsized canvas first and has the render backend draw the frame now', async () => {
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
    await coreHandlers(host(view)).screenshot({})
    expect(calls).toEqual(['resize', 'draw', 'render'])
  })

  it('refuses while the tab is in the background, where nothing is drawn', async () => {
    const global = globalThis as { document?: unknown }
    const before = global.document
    global.document = { visibilityState: 'hidden' }
    try {
      const canvas = { width: 1, height: 1 } as unknown as HTMLCanvasElement
      await expect(
        coreHandlers(host(fakeView({ canvas }))).screenshot({}),
      ).rejects.toThrow(/background/)
    } finally {
      if (before === undefined) delete global.document
      else global.document = before
    }
  })
})

/**
 * Three volumes whose remove, move and affine members finish on a later
 * microtask, as NiiVue's GPU update does: an answer given too soon would
 * describe the stack before the change.
 */
function stackView(): View {
  const view = fakeView({
    volumes: [
      { name: 'mni152.nii.gz' },
      { name: 'bold.nii.gz' },
      { name: 'bold_mask.nii.gz' },
    ],
  })
  const volumes = () => view.volumes as ShownVolume[]
  const later = async (change: () => void) => {
    await Promise.resolve()
    change()
  }
  const moveTo = (index: number, to: number) => {
    const [moved] = volumes().splice(index, 1)
    volumes().splice(to, 0, moved)
  }
  return Object.assign(view, {
    removeVolume: mock((index: number) =>
      later(() => volumes().splice(index, 1)),
    ),
    removeAllVolumes: mock(() => later(() => volumes().splice(0))),
    moveVolumeUp: mock((index: number) =>
      later(() => moveTo(index, index + 1)),
    ),
    moveVolumeDown: mock((index: number) =>
      later(() => moveTo(index, index - 1)),
    ),
    moveVolumeToTop: mock((index: number) => later(() => moveTo(index, 2))),
    moveVolumeToBottom: mock((index: number) => later(() => moveTo(index, 0))),
    setVolume: mock(async () => {}),
    volumeTransforms: ['smooth'],
    volumeTransform: {
      smooth: async (volume: ShownVolume) => ({
        name: `${volume.name}+smooth`,
      }),
    },
  })
}

describe('remove_volume', () => {
  it('removes one volume by name or index, or all of them, answering once NiiVue has', async () => {
    const view = stackView()
    const { remove_volume } = coreHandlers(host(view))
    expect(await remove_volume({ volume: 'mask' })).toEqual({
      removed: 'bold_mask.nii.gz',
      volumes: [
        expect.objectContaining({ index: 0, name: 'mni152.nii.gz' }),
        expect.objectContaining({ index: 1, name: 'bold.nii.gz' }),
      ],
    })
    expect(view.drawScene).toHaveBeenCalled()
    await expect(remove_volume({})).rejects.toThrow('Say which volume')
    expect(await remove_volume({ all: true })).toEqual({ volumes: [] })
    expect(view.volumes).toHaveLength(0)
    const bare = coreHandlers(host(fakeView()))
    await expect(bare.remove_volume({ volume: 0 })).rejects.toThrow(
      "This page's NiiVue cannot remove a volume.",
    )
    await expect(bare.remove_volume({ all: true })).rejects.toThrow(
      "This page's NiiVue cannot remove its volumes.",
    )
  })
})

describe('reorder_volume', () => {
  it('moves a volume each way and reports where it landed, once NiiVue has moved it', async () => {
    const view = stackView()
    const { reorder_volume } = coreHandlers(host(view))
    expect(await reorder_volume({ volume: 0, move: 'up' })).toMatchObject({
      moved: 'mni152.nii.gz',
      index: 1,
    })
    expect(await reorder_volume({ volume: 1, move: 'Down' })).toMatchObject({
      moved: 'mni152.nii.gz',
      index: 0,
    })
    expect(await reorder_volume({ volume: 0, move: 'top' })).toMatchObject({
      moved: 'mni152.nii.gz',
      index: 2,
    })
    expect(await reorder_volume({ volume: 2, move: 'bottom' })).toMatchObject({
      moved: 'mni152.nii.gz',
      index: 0,
      volumes: [
        expect.objectContaining({ index: 0, name: 'mni152.nii.gz' }),
        expect.objectContaining({ index: 1, name: 'bold.nii.gz' }),
        expect.objectContaining({ index: 2, name: 'bold_mask.nii.gz' }),
      ],
    })
    await expect(reorder_volume({ volume: 0 })).rejects.toThrow(
      'reorder_volume needs move: up, down, top or bottom.',
    )
    await expect(
      coreHandlers(host(fakeView())).reorder_volume({ volume: 0, move: 'up' }),
    ).rejects.toThrow("This page's NiiVue cannot reorder its volumes.")
  })
})

describe('transform_volume', () => {
  it('runs a page transform, adds the result, and drops the source only once it is gone', async () => {
    const view = stackView()
    const { transform_volume } = coreHandlers(host(view))
    expect(
      await transform_volume({
        volume: 1,
        name: 'smooth',
        options: { fwhm: 2 },
      }),
    ).toMatchObject({
      transform: 'smooth',
      options: { fwhm: 2 },
      volume: { index: 3, name: 'bold.nii.gz+smooth' },
    })
    expect(
      await transform_volume({ volume: 'mask', name: 'smooth', replace: true }),
    ).toMatchObject({
      volume: { index: 3, name: 'bold_mask.nii.gz+smooth' },
      volumes: [
        expect.objectContaining({ name: 'mni152.nii.gz' }),
        expect.objectContaining({ name: 'bold.nii.gz' }),
        expect.objectContaining({ name: 'bold.nii.gz+smooth' }),
        expect.objectContaining({ name: 'bold_mask.nii.gz+smooth' }),
      ],
    })
    expect(view.removeVolume).toHaveBeenCalledWith(2)
    await expect(transform_volume({ name: 'sharpen' })).rejects.toThrow(
      'Unknown transform "sharpen". One of: smooth.',
    )
    await expect(transform_volume({})).rejects.toThrow(
      'transform_volume needs a name. One of: smooth.',
    )
    await expect(
      coreHandlers(host(fakeView())).transform_volume({ name: 'smooth' }),
    ).rejects.toThrow("This page's NiiVue has no volume transforms.")
  })

  it('keeps the source when its replacement cannot be added', async () => {
    const view = stackView()
    view.addVolume = mock(async () => {
      await Promise.resolve()
      throw new Error('out of GPU memory')
    })
    const { transform_volume } = coreHandlers(host(view))
    await expect(
      transform_volume({ volume: 'mask', name: 'smooth', replace: true }),
    ).rejects.toThrow('out of GPU memory')
    expect(view.volumes.map((volume) => volume.name)).toEqual([
      'mni152.nii.gz',
      'bold.nii.gz',
      'bold_mask.nii.gz',
    ])
    expect(view.removeVolume).not.toHaveBeenCalled()
    await expect(
      coreHandlers(
        host(Object.assign(stackView(), { removeVolume: undefined })),
      ).transform_volume({ volume: 'mask', name: 'smooth', replace: true }),
    ).rejects.toThrow("This page's NiiVue cannot remove a volume.")
  })
})

describe('set_volume affine', () => {
  it('waits for NiiVue to place the volume before drawing and answering', async () => {
    const view = stackView()
    let drawn = 0
    let drawnWhenPlaced = -1
    view.drawScene = () => {
      drawn += 1
    }
    view.setVolumeAffine = mock(async () => {
      await Promise.resolve()
      drawnWhenPlaced = drawn
    })
    const affine = [
      [1, 0, 0, 5],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]
    const got = await coreHandlers(host(view)).set_volume({ volume: 1, affine })
    expect(view.setVolumeAffine).toHaveBeenCalledWith(1, affine)
    expect(drawnWhenPlaced).toBe(0)
    expect(drawn).toBe(1)
    expect(got).toMatchObject({ volume: { index: 1, name: 'bold.nii.gz' } })
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
  it('adds the overlay over whatever is shown, however it got there, and draws a label map with its table', async () => {
    const setColormapLabel = mock()
    // The page's own start-up volume, never seen by load_volume.
    const view = fakeView({ setColormapLabel })
    const handlers = coreHandlers(host(view))
    const result = (await handlers.add_overlay({
      url: 'http://h/labels/synthseg.nii.gz',
      labels: 'freesurfer',
    })) as { volumes: unknown[] }
    expect(view.loadVolumes).not.toHaveBeenCalled()
    expect(view.addVolume).toHaveBeenCalledWith({
      url: 'http://h/labels/synthseg.nii.gz',
      name: 'synthseg.nii.gz',
      colormap: 'gray',
      opacity: 0.5,
    })
    expect(setColormapLabel).toHaveBeenCalledWith(1, 'freesurfer')
    expect(result.volumes).toEqual([
      { index: 0, name: 'mni152.nii.gz' },
      {
        index: 1,
        name: 'synthseg.nii.gz',
        colormap: 'gray',
        opacity: 0.5,
        labels: 'freesurfer',
      },
    ])
    expect(view.drawScene).toHaveBeenCalled()
  })

  it('keeps the crosshair at the same millimetres when the overlay changes the scene', async () => {
    const view = fakeView()
    view.crosshairPos = new Float32Array([0.5, 0.5, 0.75])
    view.getCrosshairPos = () =>
      view.model.scene2mm(Array.from(view.crosshairPos))
    view.addVolume = mock(async (volume: VolumeToLoad) => {
      ;(view.volumes as ShownVolume[]).push(shown(volume))
      // A bigger box: the scene is 400 mm across now, so the fraction that
      // was 50 mm up would be 100 mm up.
      view.model = {
        mm2scene: (mm) => mm.map((v) => v / 400 + 0.5),
        scene2mm: (frac) => frac.map((f) => (f - 0.5) * 400),
      }
    })
    const result = (await coreHandlers(host(view)).add_overlay({
      url: 'http://h/zstat.nii.gz',
    })) as { crosshair: { mm: number[] } }
    expect(result.crosshair.mm).toEqual([0, 0, 50])
    expect(Array.from(view.crosshairPos)).toEqual([0.5, 0.5, 0.625])
  })

  it('uses a colormap for a non-label overlay and clamps the opacity', async () => {
    const view = fakeView()
    const handlers = coreHandlers(host(view))
    await handlers.load_volume({ url: 'http://h/t1.nii.gz' })
    const result = (await handlers.add_overlay({
      url: 'http://h/zstat.nii.gz',
      colormap: 'red',
      opacity: 3,
    })) as { volumes: Array<{ name: string }> }
    expect(view.addVolume).toHaveBeenCalledWith({
      url: 'http://h/zstat.nii.gz',
      name: 'zstat.nii.gz',
      colormap: 'red',
      opacity: 1,
    })
    expect(result.volumes.map((v) => v.name)).toEqual([
      't1.nii.gz',
      'zstat.nii.gz',
    ])
  })

  it('draws a label map with a table fetched from an address, filled in as NiiVue would', async () => {
    const setColormapLabel = mock()
    const view = fakeView({ setColormapLabel })
    const fetched = mock(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            R: [0, 255],
            G: [0, 0],
            B: [0, 0],
            labels: ['Air', 'Hippocampus_L'],
          }),
        ),
    )
    const realFetch = globalThis.fetch
    globalThis.fetch = fetched as unknown as typeof fetch
    try {
      const result = (await coreHandlers(host(view)).add_overlay({
        url: 'http://h/aal.nii.gz',
        labels: 'http://h/aal.json',
      })) as { volumes: Array<{ labels?: string }> }
      expect(fetched).toHaveBeenCalledWith('http://h/aal.json')
      expect(setColormapLabel).toHaveBeenCalledWith(1, {
        R: [0, 255],
        G: [0, 0],
        B: [0, 0],
        A: [0, 255],
        I: [0, 1],
        labels: ['Air', 'Hippocampus_L'],
      })
      expect(result.volumes[1].labels).toBe('http://h/aal.json')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('refuses a table it cannot fetch or read, leaving the scene as it was', async () => {
    const view = fakeView({ setColormapLabel: mock() })
    const handlers = coreHandlers(host(view))
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) =>
      url.endsWith('missing.json')
        ? new Response('gone', { status: 404 })
        : new Response(
            JSON.stringify({ R: [1], G: [1, 2], B: [1] }),
          )) as unknown as typeof fetch
    try {
      await expect(
        handlers.add_overlay({
          url: 'http://h/aal.nii.gz',
          labels: 'http://h/missing.json',
        }),
      ).rejects.toThrow(/could not be fetched: 404/)
      await expect(
        handlers.add_overlay({
          url: 'http://h/aal.nii.gz',
          labels: '/volumes/odd.json',
        }),
      ).rejects.toThrow(/not one NiiVue can read/)
      expect(view.addVolume).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('refuses with nothing shown, an unknown table, or a page that cannot draw labels', async () => {
    const empty = coreHandlers(host(fakeView({ volumes: [] })))
    await expect(
      empty.add_overlay({ url: 'http://h/x.nii.gz' }),
    ).rejects.toThrow(/load_volume/)
    const handlers = coreHandlers(host(fakeView()))
    await expect(
      handlers.add_overlay({ url: 'http://h/x.nii.gz', labels: 'aal' }),
    ).rejects.toThrow(/Unknown label table/)
    await expect(
      handlers.add_overlay({ url: 'http://h/x.nii.gz', labels: 'freesurfer' }),
    ).rejects.toThrow(/label maps/)
  })

  it('keeps what was shown when the overlay fails to load', async () => {
    const view = fakeView()
    const add = view.addVolume
    view.addVolume = mock(async (volume: VolumeToLoad) => {
      if (volume.url.includes('missing')) throw new Error('404')
      await add(volume)
    })
    const handlers = coreHandlers(host(view))
    await handlers.load_volume({ url: 'http://h/t1.nii.gz' })
    await expect(
      handlers.add_overlay({ url: 'http://h/missing.nii.gz' }),
    ).rejects.toThrow(/could not be loaded: 404/)
    expect(view.volumes.map((v) => v.name)).toEqual(['t1.nii.gz'])
    const result = (await handlers.add_overlay({
      url: 'http://h/ok.nii.gz',
    })) as { volumes: unknown[] }
    expect(result.volumes).toEqual([
      { index: 0, name: 't1.nii.gz', colormap: 'gray' },
      { index: 1, name: 'ok.nii.gz', colormap: 'warm', opacity: 0.7 },
    ])
  })

  it('forgets the label tables once a new base replaces the volumes', async () => {
    const view = fakeView({ setColormapLabel: mock() })
    const handlers = coreHandlers(host(view))
    await handlers.add_overlay({
      url: 'http://h/synthseg.nii.gz',
      labels: 'freesurfer',
    })
    await handlers.load_volume({ url: 'http://h/t1.nii.gz' })
    const result = (await handlers.add_overlay({
      url: 'http://h/zstat.nii.gz',
    })) as { volumes: Array<{ labels?: string }> }
    expect(result.volumes.map((v) => v.labels)).toEqual([undefined, undefined])
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
