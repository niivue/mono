import { afterEach, describe, expect, it } from 'bun:test'
import type NiiVueGPU from '@niivue/niivue'
import { SLICE_TYPE } from '@niivue/niivue'
import { registerNiivue, unregisterNiivue } from './niivueRegistry'
import {
  getNiivueToolbarModule,
  NIIVUE_TOOLBAR_BUTTONS,
  NIIVUE_TOOLBAR_SECTIONS,
  NIIVUE_VIEWS_SECTION,
  niivueToolbarCustomization,
} from './toolbar'

afterEach(() => unregisterNiivue('vp-1'))

function evaluator(name: string) {
  const entry = getNiivueToolbarModule().find((e) => e.name === name)
  if (!entry?.evaluate) throw new Error(`missing evaluator ${name}`)
  return entry.evaluate
}

describe('toolbar definitions', () => {
  it('the views section lists exactly the slice-type buttons defined', () => {
    const ids = new Set(NIIVUE_TOOLBAR_BUTTONS.map((b) => b.id))
    const members = NIIVUE_TOOLBAR_SECTIONS[NIIVUE_VIEWS_SECTION] ?? []
    expect(members.length).toBeGreaterThan(0)
    for (const member of members) {
      expect(ids.has(member)).toBe(true)
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
    const nv = { sliceType: SLICE_TYPE.RENDER as number }
    registerNiivue('vp-1', nv as unknown as NiiVueGPU)
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
    registerNiivue('vp-1', {} as unknown as NiiVueGPU)
    expect(evaluator('evaluate.niivue')({ viewportId: 'vp-1' })?.disabled).toBe(
      false,
    )
  })
})
