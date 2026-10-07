import { describe, expect, it, mock } from 'bun:test'
import { baseView, hostOf } from '../testing/fake-view'
import { coerceValue, controlHandlers, memoryControls } from './controls'
import { sceneState } from './scene'
import type { NiiVueHost } from './view'

function hostWithControls(): NiiVueHost & {
  onChange: ReturnType<typeof mock>
} {
  const onChange = mock(() => {})
  const host: NiiVueHost = hostOf(baseView())
  host.controls = memoryControls({ onChange })
  return Object.assign(host, { onChange })
}

describe('add_control', () => {
  it('makes a control with the value its kind starts with', () => {
    const host = hostWithControls()
    const { add_control } = controlHandlers(host)
    const got = add_control({
      id: 'gamma',
      kind: 'slider',
      x: 10,
      y: 20,
      min: 0.5,
      max: 2,
      step: 0.1,
      label: 'Gamma',
      bind: 'gamma',
    }) as { control: Record<string, unknown> }
    expect(got.control).toMatchObject({
      id: 'gamma',
      kind: 'slider',
      x: 10,
      y: 20,
      value: 0.5,
      enabled: true,
      bind: 'gamma',
    })
    expect(host.onChange).toHaveBeenCalledTimes(1)
    expect(host.view.drawScene).toHaveBeenCalled()
  })

  it('starts each kind with a value that fits it', () => {
    const { add_control } = controlHandlers(hostWithControls())
    const value = (params: Record<string, unknown>) =>
      (
        add_control({ x: 0, y: 0, ...params }) as {
          control: { value: unknown }
        }
      ).control.value
    expect(value({ id: 'a', kind: 'toggle' })).toBe(false)
    expect(value({ id: 'b', kind: 'number', min: 2 })).toBe(2)
    expect(value({ id: 'c', kind: 'text' })).toBe('')
    expect(value({ id: 'd', kind: 'select', options: ['x', 'y'] })).toBe('x')
    expect(value({ id: 'e', kind: 'color' })).toEqual([1, 1, 1])
    expect(value({ id: 'f', kind: 'color', alpha: true })).toEqual([1, 1, 1, 1])
    expect(value({ id: 'g', kind: 'button' })).toBeNull()
    expect(value({ id: 'h', kind: 'file' })).toBeNull()
  })

  it('takes options as ids or as objects', () => {
    const { add_control } = controlHandlers(hostWithControls())
    const got = add_control({
      id: 'view',
      kind: 'segmented',
      x: 0,
      y: 0,
      options: ['axial', { id: 'coronal', label: 'Cor' }, { id: 'sag' }],
      value: 'coronal',
    }) as { control: { options: unknown; value: unknown } }
    expect(got.control.options).toEqual([
      { id: 'axial', label: 'axial' },
      { id: 'coronal', label: 'Cor' },
      { id: 'sag', label: 'sag' },
    ])
    expect(got.control.value).toBe('coronal')
  })

  it('refuses what a kind cannot hold, and ids already taken', () => {
    const { add_control } = controlHandlers(hostWithControls())
    expect(() => add_control({ id: 'a', kind: 'dial', x: 0, y: 0 })).toThrow(
      /Unknown kind/,
    )
    expect(() => add_control({ id: 'a', kind: 'toggle' })).toThrow(/x and y/)
    expect(() =>
      add_control({ id: 'a', kind: 'toggle', x: 0, y: 0, value: 'yes' }),
    ).toThrow(/true or false/)
    expect(() =>
      add_control({
        id: 'a',
        kind: 'select',
        x: 0,
        y: 0,
        options: ['x'],
        value: 'z',
      }),
    ).toThrow(/one of its options: x/)
    add_control({ id: 'a', kind: 'toggle', x: 0, y: 0 })
    expect(() => add_control({ id: 'a', kind: 'button', x: 0, y: 0 })).toThrow(
      /already a control with the id "a"/,
    )
  })

  it('declines on a page without a control surface', () => {
    const { add_control, list_controls } = controlHandlers(hostOf(baseView()))
    expect(() => add_control({ id: 'a', kind: 'button', x: 0, y: 0 })).toThrow(
      /no control surface/,
    )
    expect(() => list_controls({})).toThrow(/no control surface/)
  })
})

describe('set_control', () => {
  it('changes only what is given and clamps a value to its range', () => {
    const host = hostWithControls()
    const { add_control, set_control } = controlHandlers(host)
    add_control({
      id: 'g',
      kind: 'slider',
      x: 0,
      y: 0,
      min: 0,
      max: 1,
      step: 0.1,
    })
    const got = set_control({ id: 'g', value: 1.44, label: 'Gamma' }) as {
      control: Record<string, unknown>
    }
    expect(got.control).toMatchObject({ value: 1, label: 'Gamma', min: 0 })
    expect(
      (set_control({ id: 'g', value: 0.26 }) as { control: { value: number } })
        .control.value,
    ).toBe(0.3)
    expect(
      (
        set_control({ id: 'g', enabled: false }) as {
          control: { enabled: boolean }
        }
      ).control.enabled,
    ).toBe(false)
  })

  it('keeps the value within a range that moves', () => {
    const { add_control, set_control } = controlHandlers(hostWithControls())
    add_control({ id: 'n', kind: 'number', x: 0, y: 0, value: 8 })
    const got = set_control({ id: 'n', max: 5 }) as {
      control: { value: number }
    }
    expect(got.control.value).toBe(5)
  })

  it('refuses an unknown control and an empty change', () => {
    const { set_control } = controlHandlers(hostWithControls())
    expect(() => set_control({ id: 'nope', value: 1 })).toThrow(
      /no control with the id "nope"/,
    )
    expect(() => set_control({ id: 'nope' })).toThrow(/nothing to change/)
  })
})

describe('list_controls and remove_control', () => {
  it('lists in the order added, removes one or all, and shows up in the state', () => {
    const host = hostWithControls()
    const { add_control, list_controls, remove_control } = controlHandlers(host)
    add_control({ id: 'a', kind: 'button', x: 0, y: 0 })
    add_control({ id: 'b', kind: 'toggle', x: 0, y: 30 })
    expect(
      (list_controls({}) as { controls: { id: string }[] }).controls.map(
        (c) => c.id,
      ),
    ).toEqual(['a', 'b'])
    expect(sceneState(host).controls).toEqual(['a', 'b'])
    expect(remove_control({ id: 'a' })).toMatchObject({ removed: 'a' })
    expect(sceneState(host).controls).toEqual(['b'])
    expect(() => remove_control({ id: 'a' })).toThrow(
      /no control with the id "a"/,
    )
    expect(() => remove_control({})).toThrow(/needs an id, or all/)
    expect(remove_control({ all: true })).toEqual({ all: true, controls: [] })
    expect(sceneState(host).controls).toEqual([])
  })

  it('leaves the state alone on a page without controls', () => {
    expect('controls' in sceneState(hostOf(baseView()))).toBe(false)
  })
})

describe('coerceValue', () => {
  it('keeps the decimals of the step', () => {
    expect(
      coerceValue({ kind: 'slider', min: 0, max: 1, step: 0.1 }, 0.30000001),
    ).toBe(0.3)
    expect(coerceValue({ kind: 'slider', min: 1, step: 2 }, 4)).toBe(5)
  })

  it('gives a color the channels the control has', () => {
    expect(coerceValue({ kind: 'color' }, [1, 0, 0, 0.5])).toEqual([1, 0, 0])
    expect(coerceValue({ kind: 'color', alpha: true }, [1, 0, 0])).toEqual([
      1, 0, 0, 1,
    ])
    expect(() => coerceValue({ kind: 'color' }, 'red')).toThrow(
      /three or four numbers/,
    )
  })

  it('refuses a value on a kind that holds none', () => {
    expect(() => coerceValue({ kind: 'button' }, 1)).toThrow(/holds no value/)
    expect(coerceValue({ kind: 'button' }, null)).toBeNull()
  })
})
