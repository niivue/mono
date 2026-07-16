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
  getNiivueToolbarModule,
  NIIVUE_CLIP_SECTION,
  NIIVUE_COLORMAP_SECTION,
  NIIVUE_TOOLBAR_BUTTONS,
  NIIVUE_TOOLBAR_SECTIONS,
  NIIVUE_VIEWS_SECTION,
  NIIVUE_WL_SECTION,
  niivueToolbarCustomization,
} from './toolbar'

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
    expect(evaluate({ viewportId: 'vp-none' })?.isActive).toBe(true) // sole fallback
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
