import { describe, expect, it, mock } from 'bun:test'

import { baseView, hostOf } from '../testing/fake-view'
import { settingHandlers } from './settings'
import type { View } from './view'

/** A view with a few settings on it, as NiiVue keeps them: plain properties. */
function settingsView(overrides: Partial<View> = {}) {
  const view = baseView(overrides) as View & Record<string, unknown>
  view.crosshairWidth = 1
  view.backgroundColor = new Float32Array([0, 0, 0, 1])
  view.primaryDragMode = 1
  view.annotationIsEnabled = false
  view.wheelZoomAnchor = 'crosshair'
  return view
}

describe('get_options and set_options', () => {
  it('reads every setting the page has, described, when no names are given', () => {
    const view = settingsView()
    const host = hostOf(view)
    const { get_options } = settingHandlers(host)
    const { options } = get_options({}) as {
      options: Record<string, Record<string, unknown>>
    }
    expect(host.prepared).toBe(1)
    expect(Object.keys(options).length).toBeGreaterThan(5)
    expect(options.crosshairWidth).toEqual({
      value: 1,
      kind: 'number',
      min: 0,
      description: expect.stringContaining('crosshair'),
    })
    expect(options.primaryDragMode.value).toBe('contrast')
    expect(options.primaryDragMode.choices).toContain('pan')
    expect(options.backgroundColor.value).toEqual([0, 0, 0, 1])
    // A setting the page lacks is described without a value.
    expect(options.gamma.value).toBeUndefined()
    expect(options.gamma.kind).toBe('number')
  })

  it('reads named settings as plain values, described when asked', () => {
    const { get_options } = settingHandlers(hostOf(settingsView()))
    expect(
      get_options({ names: ['crosshairWidth', 'primaryDragMode'] }),
    ).toEqual({ options: { crosshairWidth: 1, primaryDragMode: 'contrast' } })
    const described = get_options({
      names: ['wheelZoomAnchor'],
      describe: true,
    }) as { options: Record<string, Record<string, unknown>> }
    expect(described.options.wheelZoomAnchor).toEqual({
      value: 'crosshair',
      kind: 'choice',
      choices: ['crosshair', 'pointer'],
      description: expect.any(String),
    })
    expect(() => get_options({ names: ['fog'] })).toThrow(
      'There is no setting called "fog". get_options lists them',
    )
    expect(() => get_options({ names: ['gamma'], describe: true })).toThrow(
      "This page's NiiVue has no gamma setting.",
    )
    expect(() => get_options({ names: 'crosshairWidth' })).toThrow(
      'names must be a list of strings.',
    )
  })

  it('sets several settings at once, coerced, and reports them back', () => {
    const view = settingsView()
    const { set_options } = settingHandlers(hostOf(view))
    expect(
      set_options({
        options: {
          crosshairWidth: '3',
          primaryDragMode: 'pan',
          backgroundColor: [1, 1, 1],
          annotationIsEnabled: 'true',
        },
      }),
    ).toEqual({
      options: {
        crosshairWidth: 3,
        primaryDragMode: 'pan',
        backgroundColor: [1, 1, 1, 1],
        annotationIsEnabled: true,
      },
    })
    expect(view.crosshairWidth).toBe(3)
    expect(view.primaryDragMode).toBe(3)
    expect(view.drawScene).toHaveBeenCalledTimes(1)
  })

  it('changes nothing when any value is bad', () => {
    const view = settingsView()
    const { set_options } = settingHandlers(hostOf(view))
    expect(() =>
      set_options({ options: { crosshairWidth: 5, primaryDragMode: 'fly' } }),
    ).toThrow('primaryDragMode must be one of')
    expect(view.crosshairWidth).toBe(1)
    expect(() => set_options({ options: { fog: 1 } })).toThrow(
      'There is no setting called "fog"',
    )
    expect(() => set_options({ options: { gamma: 1 } })).toThrow(
      "This page's NiiVue has no gamma setting.",
    )
    expect(() => set_options({})).toThrow('set_options needs options')
    expect(() => set_options({ options: {} })).toThrow(
      'set_options needs options',
    )
    expect(view.drawScene).not.toHaveBeenCalled()
  })
})

describe('capabilities', () => {
  it('says which optional members, settings, colormaps and transforms the page has', () => {
    const view = settingsView({
      backend: 'webgpu',
      setVolume: mock(),
      meshes: [],
      addMesh: mock(async () => {}),
      colormaps: ['gray', 'hot'],
      drawingColormaps: ['$slicer3d'],
      meshShaders: ['Phong', 'Matte'],
      volumeTransforms: ['smooth', 'flip'],
      getVolumeTransformInfo: (name) =>
        name === 'smooth'
          ? {
              name,
              description: 'Blurs the volume.',
              options: [
                {
                  name: 'sigma',
                  label: 'Sigma',
                  type: 'select',
                  default: 1,
                  options: [1, 2],
                },
              ],
            }
          : undefined,
      volumeExtensions: ['.nii', '.nii.gz'],
      meshWriteExtensions: ['.mz3'],
    })
    const { capabilities } = settingHandlers(hostOf(view))
    const got = capabilities({}) as Record<string, unknown>
    expect(got.backend).toBe('webgpu')
    const features = got.features as Record<string, string[]>
    expect(features.volumes).toEqual(['setVolume'])
    expect(features.meshes).toEqual(['meshes', 'addMesh'])
    expect(features.colormaps).toEqual(['colormaps'])
    expect(got.settings).toEqual([
      'backgroundColor',
      'crosshairWidth',
      'wheelZoomAnchor',
      'primaryDragMode',
      'annotationIsEnabled',
    ])
    expect(got.colormaps).toEqual(['gray', 'hot'])
    expect(got.drawingColormaps).toEqual(['$slicer3d'])
    expect(got.meshShaders).toEqual(['Phong', 'Matte'])
    expect(got.volumeTransforms).toEqual([
      {
        name: 'smooth',
        description: 'Blurs the volume.',
        options: [
          {
            name: 'sigma',
            label: 'Sigma',
            type: 'select',
            default: 1,
            options: [1, 2],
          },
        ],
      },
      { name: 'flip' },
    ])
    expect(got.volumeExtensions).toEqual(['.nii', '.nii.gz'])
    expect(got.meshWriteExtensions).toEqual(['.mz3'])
    expect(got.meshExtensions).toBeUndefined()
  })

  it('reports a bare page as having little', () => {
    const { capabilities } = settingHandlers(hostOf(baseView()))
    const got = capabilities({}) as Record<string, unknown>
    expect(got.backend).toBeUndefined()
    expect(got.settings).toEqual([])
    expect(got.colormaps).toBeUndefined()
    expect(got.volumeTransforms).toBeUndefined()
    for (const members of Object.values(
      got.features as Record<string, string[]>,
    ))
      expect(members).toEqual([])
  })
})

describe('add_colormap', () => {
  it('adds a colormap from its stops and reports the names known', () => {
    const known = ['gray']
    const view = baseView({
      colormaps: known,
      addColormap: mock((name: string) => {
        known.push(name)
        return name
      }),
    })
    const { add_colormap } = settingHandlers(hostOf(view))
    expect(
      add_colormap({
        name: 'fire',
        R: [0, 255],
        G: [0, 128],
        B: [0, 0],
        A: [0, 255],
        I: [0, 255],
        labels: ['cold', 'hot'],
      }),
    ).resolves.toEqual({ name: 'fire', colormaps: ['gray', 'fire'] })
    expect(view.addColormap).toHaveBeenCalledWith('fire', {
      R: [0, 255],
      G: [0, 128],
      B: [0, 0],
      A: [0, 255],
      I: [0, 255],
      labels: ['cold', 'hot'],
    })
  })

  it('refuses stops of different lengths and a missing name', async () => {
    const view = baseView({ addColormap: mock(() => 'x') })
    const { add_colormap } = settingHandlers(hostOf(view))
    await expect(
      add_colormap({ name: 'x', R: [0, 1], G: [0], B: [0, 1] }),
    ).rejects.toThrow('add_colormap needs R, G and B: lists of the same length')
    await expect(
      add_colormap({ name: 'x', R: [0, 1], G: [0, 1], B: [0, 1], A: [1] }),
    ).rejects.toThrow('A must be as long as R, G and B (2).')
    await expect(add_colormap({ R: [0], G: [0], B: [0] })).rejects.toThrow(
      'add_colormap needs a name, and R, G and B or a url.',
    )
    await expect(
      settingHandlers(hostOf(baseView())).add_colormap({
        name: 'x',
        R: [0],
        G: [0],
        B: [0],
      }),
    ).rejects.toThrow("This page's NiiVue cannot add a colormap.")
  })

  it('fetches a colormap from a url, saying why when it cannot', async () => {
    const view = baseView({
      addColormapFromUrl: mock(async (url: string) => {
        if (url.endsWith('bad.json')) throw new Error('404')
      }),
    })
    const { add_colormap } = settingHandlers(hostOf(view))
    expect(
      await add_colormap({ url: 'https://x/maps/fire.json', name: 'fire' }),
    ).toEqual({ name: 'fire' })
    expect(view.addColormapFromUrl).toHaveBeenCalledWith(
      'https://x/maps/fire.json',
      'fire',
    )
    await expect(add_colormap({ url: 'https://x/bad.json' })).rejects.toThrow(
      'The colormap at https://x/bad.json could not be loaded: 404',
    )
    await expect(
      settingHandlers(hostOf(baseView())).add_colormap({ url: 'https://x/a' }),
    ).rejects.toThrow("This page's NiiVue cannot fetch a colormap.")
  })
})

describe('set_font', () => {
  it('loads the font from its atlas and metrics', async () => {
    const view = baseView({
      setFontFromUrl: mock(async ({ atlas }: { atlas: string }) =>
        atlas.includes('good'),
      ),
    })
    const { set_font } = settingHandlers(hostOf(view))
    expect(
      await set_font({
        atlas: 'https://x/good.png',
        metrics: 'https://x/m.json',
      }),
    ).toEqual({ atlas: 'https://x/good.png', metrics: 'https://x/m.json' })
    expect(view.drawScene).toHaveBeenCalledTimes(1)
    await expect(
      set_font({ atlas: 'https://x/bad.png', metrics: 'https://x/m.json' }),
    ).rejects.toThrow('The font at https://x/bad.png could not be loaded.')
    await expect(set_font({ atlas: 'https://x/good.png' })).rejects.toThrow(
      'set_font needs atlas and metrics',
    )
    await expect(
      settingHandlers(hostOf(baseView())).set_font({
        atlas: 'a',
        metrics: 'b',
      }),
    ).rejects.toThrow("This page's NiiVue cannot change its font.")
  })
})

describe('set_custom_layout', () => {
  it('places tiles by slice name and fractions, and clears them', () => {
    const view = baseView({ customLayout: null, clearCustomLayout: mock() })
    const { set_custom_layout } = settingHandlers(hostOf(view))
    expect(
      set_custom_layout({
        tiles: [
          { slice: 'Axial', position: [0, 0, 0.5, 1], mm: 10, fill: true },
          { slice: 'render', position: [0.5, 0, 0.5, 1] },
        ],
      }),
    ).toEqual({
      layout: [
        { sliceType: 0, position: [0, 0, 0.5, 1], sliceMM: 10, fill: true },
        { sliceType: 4, position: [0.5, 0, 0.5, 1] },
      ],
    })
    expect(view.customLayout).toHaveLength(2)
    expect(set_custom_layout({ clear: true })).toEqual({ layout: null })
    expect(view.clearCustomLayout).toHaveBeenCalledTimes(1)
    expect(view.drawScene).toHaveBeenCalledTimes(2)
  })

  it('clears by assignment when the page has no clearing method', () => {
    const view = baseView({ customLayout: [] })
    const { set_custom_layout } = settingHandlers(hostOf(view))
    set_custom_layout({ clear: true })
    expect(view.customLayout).toBeNull()
  })

  it('refuses bad tiles and a page without the layout', () => {
    const view = baseView({ customLayout: null })
    const { set_custom_layout } = settingHandlers(hostOf(view))
    expect(() => set_custom_layout({})).toThrow(
      'set_custom_layout needs tiles, or clear: true.',
    )
    expect(() =>
      set_custom_layout({
        tiles: [{ slice: 'oblique', position: [0, 0, 1, 1] }],
      }),
    ).toThrow('Tile 0 needs a slice: one of axial, coronal, sagittal')
    expect(() =>
      set_custom_layout({
        tiles: [{ slice: 'axial', position: [0, 0, 2, 1] }],
      }),
    ).toThrow('Tile 0 needs a position: [left, top, width, height]')
    expect(() =>
      set_custom_layout({
        tiles: [{ slice: 'axial', position: [0, 0, 1, 1], mm: 'far' }],
      }),
    ).toThrow('Tile 0: mm must be a number.')
    expect(view.customLayout).toBeNull()
    expect(() =>
      settingHandlers(hostOf(baseView())).set_custom_layout({ clear: true }),
    ).toThrow("This page's NiiVue has no custom layout.")
  })
})
