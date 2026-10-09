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
      colormaps: ['gray', 'hot'],
      drawingColormaps: ['$slicer3d'],
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
