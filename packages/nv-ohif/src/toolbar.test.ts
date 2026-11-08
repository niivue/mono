import { afterEach, describe, expect, it } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { SLICE_TYPE } from '@niivue/niivue'
import {
  getNiivueEntryForViewport,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import {
  NIIVUE_UNSUPPORTED_EVALUATOR,
  withNiivueSupport,
} from './niivueSupport'
import type { OhifToolbarButton } from './ohif-types'
import { ohifToolToAnnotationTool } from './toolBridge'
import {
  getNiivueToolbarModule,
  NIIVUE_CLIP_SECTION,
  NIIVUE_COLORMAP_SECTION,
  NIIVUE_TOOLBAR_BUTTONS,
  NIIVUE_TOOLBAR_SECTIONS,
  NIIVUE_VIEWS_SECTION,
  NIIVUE_WL_SECTION,
  niivueToolbarCustomization,
} from './toolbar'
import type { WsiSlideView } from './wsiSlideView'

afterEach(() => unregisterNiivue('vp-1'))

function evaluator(name: string) {
  const entry = getNiivueToolbarModule().find((e) => e.name === name)
  if (!entry?.evaluate) throw new Error(`missing evaluator ${name}`)
  return entry.evaluate
}

describe('toolbar definitions', () => {
  it('every section member is a defined button', () => {
    const ids = new Set(NIIVUE_TOOLBAR_BUTTONS.map((b) => b.id))
    for (const section of [
      NIIVUE_VIEWS_SECTION,
      NIIVUE_CLIP_SECTION,
      NIIVUE_WL_SECTION,
      NIIVUE_COLORMAP_SECTION,
    ]) {
      const members = NIIVUE_TOOLBAR_SECTIONS[section] ?? []
      expect(members.length).toBeGreaterThan(0)
      for (const member of members) {
        expect(ids.has(member)).toBe(true)
      }
    }
  })

  it('every button references a niivue command and a niivue evaluator', () => {
    for (const button of NIIVUE_TOOLBAR_BUTTONS) {
      if (button.props.buttonSection) continue
      const { commands, evaluate } = button.props
      const commandName =
        typeof commands === 'string'
          ? commands
          : !Array.isArray(commands)
            ? commands?.commandName
            : undefined
      expect(commandName).toStartWith('niivue')
      expect(String(evaluate)).toStartWith('evaluate.niivue')
    }
  })

  it('exposes the customization pack under niivue.* keys', () => {
    expect(niivueToolbarCustomization['niivue.toolbarButtons']).toBe(
      NIIVUE_TOOLBAR_BUTTONS,
    )
    expect(niivueToolbarCustomization['niivue.toolbarSections']).toBe(
      NIIVUE_TOOLBAR_SECTIONS,
    )
  })
})

describe('toolbar evaluators', () => {
  const volumeEvaluators = [
    'evaluate.niivue.sliceType',
    'evaluate.niivue.clipPlane',
    'evaluate.niivue.overlay',
    'evaluate.niivue.windowLevelPreset',
    'evaluate.niivue.colormap',
    'evaluate.niivue.colorbar',
    'evaluate.niivue.interpolation',
    'evaluate.niivue.crosshair',
    'evaluate.niivue.measurement',
  ]

  it('volume evaluators: missing viewport, no volume, ordinary volume', () => {
    for (const name of volumeEvaluators) {
      const evaluate = evaluator(name)
      expect(evaluate({ viewportId: 'vp-1' })).toEqual({
        disabled: true,
        disabledText: 'Available on NiiVue viewports',
      })
      registerNiivue('vp-1', { volumes: [] } as unknown as NiiVue)
      expect(evaluate({ viewportId: 'vp-1' })).toEqual({
        disabled: true,
        disabledText: 'Available for NiiVue volume viewports',
      })
      registerNiivue('vp-1', { volumes: [{}] } as unknown as NiiVue)
      expect(evaluate({ viewportId: 'vp-1' })?.disabled).toBe(false)
      unregisterNiivue('vp-1')
    }
  })

  it('W/L preset: modality message on a volume, volume message otherwise', () => {
    const evaluate = evaluator('evaluate.niivue.windowLevelPreset')
    const ptButton = NIIVUE_TOOLBAR_BUTTONS.find(
      (b) => b.id === 'NiivueWLPtSuv5',
    )
    registerNiivue('vp-1', { volumes: [] } as unknown as NiiVue)
    updateNiivueViewport('vp-1', {
      displaySets: [{ displaySetInstanceUID: 'ds-1', Modality: 'CT' }],
    })
    expect(evaluate({ viewportId: 'vp-1', button: ptButton })).toEqual({
      disabled: true,
      disabledText: 'Available for NiiVue volume viewports',
    })
    registerNiivue('vp-1', { volumes: [{}] } as unknown as NiiVue)
    updateNiivueViewport('vp-1', {
      displaySets: [{ displaySetInstanceUID: 'ds-1', Modality: 'CT' }],
    })
    expect(evaluate({ viewportId: 'vp-1', button: ptButton })).toEqual({
      disabled: true,
      disabledText: 'Applies to PT series',
    })
  })

  it('disable when the viewport has no NiiVue instance', () => {
    expect(evaluator('evaluate.niivue')({ viewportId: 'vp-1' })?.disabled).toBe(
      true,
    )
    expect(
      evaluator('evaluate.niivue.sliceType')({ viewportId: 'vp-1' })?.disabled,
    ).toBe(true)
  })

  it('mark the button matching the current slice type active', () => {
    const nv = { sliceType: SLICE_TYPE.RENDER as number, volumes: [{}] }
    registerNiivue('vp-1', nv as unknown as NiiVue)
    const evaluate = evaluator('evaluate.niivue.sliceType')
    const renderButton = NIIVUE_TOOLBAR_BUTTONS.find(
      (b) => b.id === 'NiivueRender',
    )
    const axialButton = NIIVUE_TOOLBAR_BUTTONS.find(
      (b) => b.id === 'NiivueAxial',
    )
    expect(
      evaluate({ viewportId: 'vp-1', button: renderButton })?.isActive,
    ).toBe(true)
    expect(
      evaluate({ viewportId: 'vp-1', button: axialButton })?.isActive,
    ).toBe(false)
  })

  it('mark the ruler active only while the Length annotation tool is on', () => {
    // Activate the tool the way the integration does: OHIF's 'Length' maps to
    // the 'measureLine' annotation tool (toolBridge), not a drag mode.
    const nv = {
      annotationIsEnabled: true,
      annotationTool: ohifToolToAnnotationTool('Length'),
      volumes: [{}],
    }
    registerNiivue('vp-1', nv as unknown as NiiVue)
    const evaluate = evaluator('evaluate.niivue.measurement')
    expect(evaluate({ viewportId: 'vp-1' })?.isActive).toBe(true)
    nv.annotationTool = ohifToolToAnnotationTool('EllipticalROI')
    expect(evaluate({ viewportId: 'vp-1' })?.isActive).toBe(false)
    nv.annotationTool = ohifToolToAnnotationTool('Length')
    nv.annotationIsEnabled = false
    expect(evaluate({ viewportId: 'vp-1' })?.isActive).toBe(false)
  })

  it('enable the reset button on a NiiVue viewport', () => {
    registerNiivue('vp-1', { volumes: [{}] } as unknown as NiiVue)
    expect(evaluator('evaluate.niivue')({ viewportId: 'vp-1' })?.disabled).toBe(
      false,
    )
  })

  it('mark the clip preset matching the entry state active (never "none")', () => {
    registerNiivue('vp-1', { volumes: [{}] } as unknown as NiiVue)
    const entry = getNiivueEntryForViewport('vp-1')
    if (!entry) throw new Error('entry missing')
    const evaluate = evaluator('evaluate.niivue.clipPlane')
    const rightButton = NIIVUE_TOOLBAR_BUTTONS.find(
      (b) => b.id === 'NiivueClipRight',
    )
    const noneButton = NIIVUE_TOOLBAR_BUTTONS.find(
      (b) => b.id === 'NiivueClipNone',
    )
    expect(evaluate({ viewportId: 'vp-1', button: noneButton })?.isActive).toBe(
      false,
    )
    entry.clipPlane = 'right'
    expect(
      evaluate({ viewportId: 'vp-1', button: rightButton })?.isActive,
    ).toBe(true)
    expect(evaluate({ viewportId: 'vp-1', button: noneButton })?.isActive).toBe(
      false,
    )
  })

  it('mark the overlay button active while overlays are loaded', () => {
    registerNiivue('vp-1', { volumes: [{}] } as unknown as NiiVue)
    const entry = getNiivueEntryForViewport('vp-1')
    if (!entry) throw new Error('entry missing')
    const evaluate = evaluator('evaluate.niivue.overlay')
    expect(evaluate({ viewportId: 'vp-1' })?.isActive).toBe(false)
    entry.overlayUIDs = ['ds-2']
    expect(evaluate({ viewportId: 'vp-1' })?.isActive).toBe(true)
    // A non-NiiVue viewport never inherits the NiiVue one's state.
    expect(evaluate({ viewportId: 'vp-none' })).toEqual({
      disabled: true,
      disabledText: 'Available on NiiVue viewports',
    })
  })

  it('gate W/L presets by the base series modality', () => {
    registerNiivue('vp-1', { volumes: [{}] } as unknown as NiiVue)
    updateNiivueViewport('vp-1', {
      displaySets: [{ displaySetInstanceUID: 'ds-1', Modality: 'CT' }],
    })
    const evaluate = evaluator('evaluate.niivue.windowLevelPreset')
    const ctButton = NIIVUE_TOOLBAR_BUTTONS.find(
      (b) => b.id === 'NiivueWLCtBrain',
    )
    const ptButton = NIIVUE_TOOLBAR_BUTTONS.find(
      (b) => b.id === 'NiivueWLPtSuv5',
    )
    expect(evaluate({ viewportId: 'vp-1', button: ctButton })?.disabled).toBe(
      false,
    )
    expect(evaluate({ viewportId: 'vp-1', button: ptButton })?.disabled).toBe(
      true,
    )
  })

  it("mark the colormap matching the base volume's colormap active", () => {
    const nv = { volumes: [{ colormap: 'Viridis' }] }
    registerNiivue('vp-1', nv as unknown as NiiVue)
    const evaluate = evaluator('evaluate.niivue.colormap')
    const viridis = NIIVUE_TOOLBAR_BUTTONS.find(
      (b) => b.id === 'NiivueCmapViridis',
    )
    const hot = NIIVUE_TOOLBAR_BUTTONS.find((b) => b.id === 'NiivueCmapHot')
    // Case-insensitive: the volume stores 'Viridis', the button carries 'viridis'.
    expect(evaluate({ viewportId: 'vp-1', button: viridis })?.isActive).toBe(
      true,
    )
    expect(evaluate({ viewportId: 'vp-1', button: hot })?.isActive).toBe(false)
  })

  it('mark the colorbar toggle active when the colorbar is visible', () => {
    const nv = { volumes: [{}], isColorbarVisible: false }
    registerNiivue('vp-1', nv as unknown as NiiVue)
    const evaluate = evaluator('evaluate.niivue.colorbar')
    expect(evaluate({ viewportId: 'vp-1' })?.isActive).toBe(false)
    nv.isColorbarVisible = true
    expect(evaluate({ viewportId: 'vp-1' })?.isActive).toBe(true)
  })

  it('mark the interpolation toggle active in nearest-neighbor mode', () => {
    const nv = { volumes: [{}], volumeIsNearestInterpolation: false }
    registerNiivue('vp-1', nv as unknown as NiiVue)
    const evaluate = evaluator('evaluate.niivue.interpolation')
    expect(evaluate({ viewportId: 'vp-1' })?.isActive).toBe(false)
    nv.volumeIsNearestInterpolation = true
    expect(evaluate({ viewportId: 'vp-1' })?.isActive).toBe(true)
  })

  it('disables volume-only controls for an NVSlide viewport', () => {
    registerNiivue('vp-1', { volumes: [] } as unknown as NiiVue)
    const views = evaluator('evaluate.niivue.sliceType')({
      viewportId: 'vp-1',
    })
    const colormap = evaluator('evaluate.niivue.colormap')({
      viewportId: 'vp-1',
    })
    expect(views?.disabled).toBe(true)
    expect(colormap?.disabled).toBe(true)
    expect(evaluator('evaluate.niivue')({ viewportId: 'vp-1' })?.disabled).toBe(
      false,
    )
  })
})

describe('evaluate.niivue.unsupported', () => {
  const button = (
    id: string,
    commands: OhifToolbarButton['props']['commands'],
  ): OhifToolbarButton => ({
    id,
    uiType: 'ohif.toolButton',
    props: { commands },
  })
  const evaluate = getNiivueToolbarModule({
    servicesManager: {
      services: {
        toolGroupService: {
          getActivePrimaryMouseButtonTool: (group: string) =>
            group === 'mpr' ? 'Pan' : undefined,
        },
      },
    },
  }).find((e) => e.name === NIIVUE_UNSUPPORTED_EVALUATOR)?.evaluate
  if (!evaluate) throw new Error('missing evaluator')
  const disabled = {
    disabled: true,
    disabledText: 'Not available on NiiVue viewports',
  }

  it('leaves non-NiiVue viewports to the other evaluators', () => {
    registerNiivue('vp-1', { volumes: [{}] } as unknown as NiiVue)
    expect(
      evaluate({
        viewportId: 'cs-1',
        button: button('Rotate', 'rotateViewportCW'),
      }),
    ).toBeUndefined()
  })

  it('disables what NiiVue cannot do; keeps commands and tools it can', () => {
    registerNiivue('vp-1', { volumes: [{}] } as unknown as NiiVue)
    updateNiivueViewport('vp-1', { toolGroupId: 'mpr' })
    const cases: Array<[OhifToolbarButton, unknown]> = [
      [button('Rotate', 'rotateViewportCW'), disabled],
      [button('Invert', [{ commandName: 'invertViewport' }]), disabled],
      [button('Reset', 'resetViewport'), undefined],
      [button('Fit', ['fitViewportToWindow', 'niivueResetView']), undefined],
      [button('Mixed', ['resetViewport', 'rotateViewportCW']), disabled],
      // Section lists, menus and the layout selector carry no commands.
      [button('Empty', undefined), undefined],
      [button('TagBrowser', 'openDICOMTagViewer'), undefined],
      [button('Tags', ['openDICOMTagViewer', 'rotateViewportCW']), disabled],
      [
        button('Pan', 'setToolActiveToolbar'),
        { disabled: false, isActive: true },
      ],
      [
        button('Length', 'setToolActiveToolbar'),
        { disabled: false, isActive: false },
      ],
      [
        button('X', [
          {
            commandName: 'setToolActive',
            commandOptions: { toolName: 'Crosshairs' },
          },
        ]),
        disabled,
      ],
      // Without a toolGroupId OHIF targets the active viewport's Cornerstone
      // tool group, which a NiiVue viewport lacks.
      [
        button('Y', [
          {
            commandName: 'setToolActive',
            commandOptions: { toolName: 'EllipticalROI' },
          },
        ]),
        disabled,
      ],
      [
        button('Z', [
          {
            commandName: 'setToolActive',
            commandOptions: { toolName: 'EllipticalROI', toolGroupId: 'mpr' },
          },
        ]),
        { disabled: false, isActive: false },
      ],
    ]
    for (const [b, expected] of cases)
      expect(evaluate({ viewportId: 'vp-1', button: b })).toEqual(
        expected as ReturnType<typeof evaluate>,
      )
  })

  it('disables volume-only standard commands on a slide viewport', () => {
    registerNiivue('vp-1', { volumes: [] } as unknown as NiiVue)
    updateNiivueViewport('vp-1', {
      slideView: {} as WsiSlideView,
    })
    for (const name of ['setViewportOrientation', 'setWindowLevelPreset'])
      expect(
        evaluate({ viewportId: 'vp-1', button: button(name, name) }),
      ).toEqual(disabled)
    expect(
      evaluate({
        viewportId: 'vp-1',
        button: button('Reset', 'resetViewport'),
      }),
    ).toBeUndefined()
  })

  it('enables only Length, Pan and Zoom on a slide viewport', () => {
    registerNiivue('vp-1', { volumes: [] } as unknown as NiiVue)
    updateNiivueViewport('vp-1', { slideView: {} as WsiSlideView })
    const tool = (toolName: string) =>
      evaluate({
        viewportId: 'vp-1',
        button: button(toolName, [
          { commandName: 'setToolActiveToolbar', commandOptions: { toolName } },
        ]),
      })
    for (const name of ['RectangleROI', 'Angle', 'CobbAngle', 'WindowLevel'])
      expect(tool(name)).toEqual(disabled)
    for (const name of ['Length', 'Pan', 'Zoom'])
      expect(tool(name)).toMatchObject({ disabled: false })
  })

  it('withNiivueSupport prepends the evaluator and hoists hideWhenDisabled', () => {
    const base = button('Rotate', 'rotateViewportCW')
    expect(withNiivueSupport(base).props.evaluate).toEqual([
      NIIVUE_UNSUPPORTED_EVALUATOR,
    ])
    const named = {
      ...base,
      props: { ...base.props, evaluate: 'evaluate.action' },
    }
    expect(withNiivueSupport(named).props.evaluate).toEqual([
      NIIVUE_UNSUPPORTED_EVALUATOR,
      'evaluate.action',
    ])
    const hidden = {
      ...base,
      props: {
        ...base.props,
        evaluate: { name: 'evaluate.cornerstoneTool', hideWhenDisabled: true },
      },
    }
    const wrapped = withNiivueSupport(hidden)
    expect(wrapped.props.hideWhenDisabled).toBe(true)
    expect(wrapped.props.evaluate).toEqual([
      NIIVUE_UNSUPPORTED_EVALUATOR,
      { name: 'evaluate.cornerstoneTool', hideWhenDisabled: true },
    ])
    const list = { ...base, props: { ...base.props, evaluate: ['a', 'b'] } }
    expect(withNiivueSupport(list).props.evaluate).toEqual([
      NIIVUE_UNSUPPORTED_EVALUATOR,
      'a',
      'b',
    ])
  })
})
