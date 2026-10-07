import { describe, expect, it } from 'bun:test'
import { DEFAULT_MENU_BUTTON_STYLE, DEFAULT_MENU_STYLE } from './menu'
import {
  endSelectValue,
  SELECT_GROUP,
  type SelectOption,
  type SelectSpec,
  selectIndex,
  selectItems,
  selectLabel,
  selectMenuSpec,
  selectOption,
  selectWidth,
  stepSelectValue,
} from './select'
import type { UIKitFontMetrics } from './text/font'

// Stub font: 'H' and 'i' advance half an em.
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([
    ['H', { plane: [0.05, 0, 0.4, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
    ['i', { plane: [0.05, 0, 0.1, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
  ]),
}
const OPTIONS: SelectOption[] = [
  { value: 'a', label: 'Hi' },
  { value: 'b', label: 'HiHi' },
  { value: 'c', label: 'Hi', enabled: false },
  { value: 'd', label: 'Hi' },
]
const SPEC: SelectSpec = {
  id: 's',
  x: 100,
  y: 50,
  options: OPTIONS,
  value: 'b',
}

describe('select model', () => {
  it('finds options by value and shows the chosen label or the placeholder', () => {
    expect(selectOption(OPTIONS, 'c')?.enabled).toBe(false)
    expect(selectOption(OPTIONS, 'zz')).toBeNull()
    expect(selectOption(OPTIONS, null)).toBeNull()
    expect(selectIndex(OPTIONS, 'd')).toBe(3)
    expect(selectIndex(OPTIONS, null)).toBe(-1)
    expect(selectLabel(SPEC)).toBe('HiHi')
    expect(selectLabel({ ...SPEC, value: null })).toBe('')
    expect(selectLabel({ ...SPEC, value: null, placeholder: 'Pick' })).toBe(
      'Pick',
    )
    expect(selectLabel({ ...SPEC, value: 'zz', placeholder: 'Pick' })).toBe(
      'Pick',
    )
  })

  it('sizes the button to the widest label so it keeps its width as the value changes', () => {
    // Widest label 'HiHi' is 32px at 16px: 32 + 2*14 padding + 6 gap + 10 chevron.
    const w = selectWidth(
      SPEC,
      DEFAULT_MENU_BUTTON_STYLE,
      DEFAULT_MENU_STYLE,
      METRICS,
    )
    expect(w).toBe(76)
    expect(
      selectWidth(
        { ...SPEC, value: 'a' },
        DEFAULT_MENU_BUTTON_STYLE,
        DEFAULT_MENU_STYLE,
        METRICS,
      ),
    ).toBe(76)
    // A wider placeholder wins.
    const wide = { ...SPEC, placeholder: 'HiHiHi' }
    expect(
      selectWidth(wide, DEFAULT_MENU_BUTTON_STYLE, DEFAULT_MENU_STYLE, METRICS),
    ).toBe(92)
  })

  it('maps the options onto one radio group with the chosen option checked', () => {
    const items = selectItems(SPEC)
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(
      items.every((i) => i.kind === 'radio' && i.group === SELECT_GROUP),
    ).toBe(true)
    expect(items.map((i) => i.checked)).toEqual([false, true, false, false])
    expect(items[2].enabled).toBe(false)
    const menu = selectMenuSpec(
      SPEC,
      DEFAULT_MENU_BUTTON_STYLE,
      DEFAULT_MENU_STYLE,
      METRICS,
    )
    expect(menu).toMatchObject({
      id: 's',
      label: 'HiHi',
      x: 100,
      y: 50,
      width: 76,
    })
    expect(menu.items).toHaveLength(4)
    expect(menu.onSelect).toBeUndefined()
    expect(menu.onChange).toBeUndefined()
    // A fixed width is kept as given.
    expect(
      selectMenuSpec(
        { ...SPEC, width: 200 },
        DEFAULT_MENU_BUTTON_STYLE,
        DEFAULT_MENU_STYLE,
        METRICS,
      ).width,
    ).toBe(200)
  })

  it('steps the value over enabled options without wrapping', () => {
    expect(stepSelectValue(OPTIONS, 'a', 1)).toBe('b')
    expect(stepSelectValue(OPTIONS, 'b', 1)).toBe('d') // skips disabled 'c'
    expect(stepSelectValue(OPTIONS, 'd', 1)).toBe('d') // the end stops
    expect(stepSelectValue(OPTIONS, 'd', -1)).toBe('b')
    expect(stepSelectValue(OPTIONS, 'a', -1)).toBe('a')
    // Bigger steps clamp.
    expect(stepSelectValue(OPTIONS, 'a', 1, 10)).toBe('d')
    expect(stepSelectValue(OPTIONS, 'd', -1, 2)).toBe('a')
    // From nothing, the first step lands on an end.
    expect(stepSelectValue(OPTIONS, null, 1)).toBe('a')
    expect(stepSelectValue(OPTIONS, null, -1)).toBe('d')
    // A value no option holds behaves like none.
    expect(stepSelectValue(OPTIONS, 'zz', 1)).toBe('a')
    // Nothing enabled: the value stays.
    const none = OPTIONS.map((o) => ({ ...o, enabled: false }))
    expect(stepSelectValue(none, 'b', 1)).toBe('b')
    expect(stepSelectValue([], null, 1)).toBeNull()
  })

  it('jumps to the first or last enabled option', () => {
    expect(endSelectValue(OPTIONS, 'b', 'first')).toBe('a')
    expect(endSelectValue(OPTIONS, 'b', 'last')).toBe('d')
    expect(
      endSelectValue(
        [{ value: 'x', label: 'Hi', enabled: false }],
        'x',
        'first',
      ),
    ).toBe('x')
  })
})
