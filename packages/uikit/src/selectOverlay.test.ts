import { describe, expect, it } from 'bun:test'
import type { SelectOption } from './select'
import { UIKitSelectOverlay } from './selectOverlay'
import type { UIKitFont, UIKitFontMetrics } from './text/font'

// Open/close state, choosing and keyboard stepping never touch the GPU, so the
// overlay is exercised headlessly with a stub font.
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([
    ['H', { plane: [0.05, 0, 0.4, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
    ['i', { plane: [0.05, 0, 0.1, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
  ]),
}
const FONT: UIKitFont = { metrics: METRICS, image: {} as ImageBitmap }

const OPTIONS: SelectOption[] = [
  { value: 'a', label: 'Hi' },
  { value: 'b', label: 'Hi' },
  { value: 'c', label: 'Hi', enabled: false },
  { value: 'd', label: 'Hi' },
]

function make() {
  const changes: string[] = []
  let redraws = 0
  const overlay = new UIKitSelectOverlay(FONT, {
    requestRedraw: () => redraws++,
  })
  overlay.addSelect({
    id: 's',
    x: 100,
    y: 50,
    options: OPTIONS,
    value: 'b',
    onChange: (value, id) => changes.push(`${id}:${value}`),
  })
  overlay.addSelect({
    id: 't',
    x: 300,
    y: 50,
    options: OPTIONS,
    value: null,
    placeholder: 'HiHi',
    onChange: (value, id) => changes.push(`${id}:${value}`),
  })
  /** Centre of popup row `i` of the open select. */
  const row = (i: number): [number, number] => {
    const popup = overlay.getPopupLayout()
    if (!popup) throw new Error('no popup')
    const r = popup.rows[i]
    return [r.x + r.width / 2, r.y + r.height / 2]
  }
  const click = (x: number, y: number) => {
    overlay.pointerDown(x, y)
    overlay.pointerUp(x, y)
  }
  return { overlay, changes, row, click, redraws: () => redraws }
}

function key(
  k: string,
  mods: Partial<{ shiftKey: boolean; altKey: boolean }> = {},
) {
  return {
    key: k,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  }
}

describe('UIKitSelectOverlay', () => {
  it('lays out buttons sized to the widest label and hit-tests them', () => {
    const { overlay } = make()
    expect(overlay.getLayout('s')).toEqual({
      x: 100,
      y: 50,
      width: 60,
      height: 28,
    })
    // The placeholder 'HiHi' is the widest text on 't'.
    expect(overlay.getLayout('t')).toEqual({
      x: 300,
      y: 50,
      width: 76,
      height: 28,
    })
    expect(overlay.hitTest(110, 60)).toBe(true)
    expect(overlay.hitTest(90, 60)).toBe(false)
    expect(overlay.hitTest(370, 70)).toBe(true)
    expect(overlay.getValue('s')).toBe('b')
    expect(overlay.getValue('t')).toBeNull()
    expect(overlay.ids).toEqual(['s', 't'])
  })

  it('opens on press with the current option highlighted and chooses on release', () => {
    const { overlay, changes, row, click, redraws } = make()
    const before = redraws()
    expect(overlay.pointerDown(110, 60)).toBe(true)
    expect(overlay.isOpen('s')).toBe(true)
    expect(overlay.isModal()).toBe(true)
    expect(overlay.highlightedIndex).toBe(1)
    expect(overlay.focusedSelect).toBe('s')
    expect(redraws()).toBeGreaterThan(before)
    overlay.pointerUp(110, 60)
    expect(overlay.isOpen('s')).toBe(true) // a click opens and leaves it open
    const popup = overlay.getPopupLayout()
    expect(popup?.rows).toHaveLength(4)
    click(...row(3))
    expect(changes).toEqual(['s:d'])
    expect(overlay.getValue('s')).toBe('d')
    expect(overlay.isOpen('s')).toBe(false)
    expect(overlay.isModal()).toBe(false)
    // Re-opening highlights the new value.
    overlay.pointerDown(110, 60)
    expect(overlay.highlightedIndex).toBe(3)
    // Choosing the current option again is silent.
    overlay.pointerUp(110, 60)
    click(...row(3))
    expect(changes).toEqual(['s:d'])
    expect(overlay.isOpen('s')).toBe(false)
  })

  it('ignores disabled options and disabled selects', () => {
    const { overlay, changes, row, click } = make()
    click(110, 60)
    click(...row(2))
    expect(changes).toEqual([])
    expect(overlay.isOpen('s')).toBe(true) // a dead row does not dismiss
    overlay.close()
    overlay.setEnabled('s', false)
    expect(overlay.hitTest(110, 60)).toBe(false)
    expect(overlay.pointerDown(110, 60)).toBe(false)
    overlay.open('s')
    expect(overlay.isOpen('s')).toBe(false)
    overlay.focus('s')
    expect(overlay.focusedSelect).toBeNull()
  })

  it('chooses with the keyboard while open and steps the value while closed', () => {
    const { overlay, changes } = make()
    overlay.focus('s')
    expect(overlay.keyDown(key('Enter'))).toBe(true)
    expect(overlay.isOpen('s')).toBe(true)
    expect(overlay.highlightedIndex).toBe(1)
    overlay.keyDown(key('ArrowDown')) // skips disabled 'c'
    expect(overlay.highlightedIndex).toBe(3)
    overlay.keyDown(key('Enter'))
    expect(changes).toEqual(['s:d'])
    expect(overlay.isOpen('s')).toBe(false)
    expect(overlay.focusedSelect).toBe('s')
    // Closed: arrows change the value directly, without wrapping.
    expect(overlay.keyDown(key('ArrowUp'))).toBe(true)
    expect(overlay.getValue('s')).toBe('b')
    overlay.keyDown(key('ArrowUp'))
    overlay.keyDown(key('ArrowUp'))
    expect(overlay.getValue('s')).toBe('a')
    expect(changes).toEqual(['s:d', 's:b', 's:a'])
    overlay.keyDown(key('End'))
    expect(overlay.getValue('s')).toBe('d')
    overlay.keyDown(key('Home'))
    expect(overlay.getValue('s')).toBe('a')
    overlay.keyDown(key('ArrowDown', { shiftKey: true }))
    expect(overlay.getValue('s')).toBe('d')
    overlay.keyDown(key('PageUp'))
    expect(overlay.getValue('s')).toBe('a')
    // Alt+ArrowDown opens instead of stepping; Escape closes and keeps the value.
    expect(overlay.keyDown(key('ArrowDown', { altKey: true }))).toBe(true)
    expect(overlay.isOpen('s')).toBe(true)
    overlay.keyDown(key('Escape'))
    expect(overlay.isOpen('s')).toBe(false)
    expect(overlay.getValue('s')).toBe('a')
    // Unrelated keys pass through; nothing focused handles nothing.
    expect(overlay.keyDown(key('x'))).toBe(false)
    overlay.blur()
    expect(overlay.keyDown(key('ArrowDown'))).toBe(false)
  })

  it('steps from no value onto the first option', () => {
    const { overlay, changes } = make()
    overlay.focus('t')
    overlay.keyDown(key('ArrowDown'))
    expect(overlay.getValue('t')).toBe('a')
    expect(changes).toEqual(['t:a'])
  })

  it('sets values silently and drops a value the options no longer offer', () => {
    const { overlay, changes } = make()
    overlay.setValue('s', 'a')
    expect(overlay.getValue('s')).toBe('a')
    overlay.setValue('s', 'zz')
    expect(overlay.getValue('s')).toBeNull()
    overlay.setValue('s', 'd')
    overlay.setOptions('s', [{ value: 'x', label: 'Hi' }])
    expect(overlay.getValue('s')).toBeNull()
    expect(overlay.getOptions('s')).toHaveLength(1)
    overlay.updateSelect('s', { x: 10 })
    expect(overlay.getLayout('s')?.x).toBe(10)
    overlay.updateSelect('s', { value: 'x' })
    expect(overlay.getValue('s')).toBe('x')
    expect(changes).toEqual([])
    overlay.removeSelect('t')
    expect(overlay.ids).toEqual(['s'])
    expect(overlay.getLayout('t')).toBeNull()
    overlay.setSelects([])
    expect(overlay.ids).toEqual([])
  })

  it('closes on an outside press, consuming it, and when dismissed by the layer', () => {
    const { overlay, changes, click } = make()
    click(110, 60)
    expect(overlay.pointerDown(5, 400)).toBe(true)
    expect(overlay.isOpen('s')).toBe(false)
    expect(changes).toEqual([])
    // Pressing the other select while one is open opens that one on its value.
    overlay.setValue('t', 'd')
    click(110, 60)
    overlay.pointerDown(310, 60)
    expect(overlay.openSelect).toBe('t')
    expect(overlay.highlightedIndex).toBe(3)
    overlay.pointerUp(310, 60)
    overlay.dismiss()
    expect(overlay.isModal()).toBe(false)
    expect(overlay.openSelect).toBeNull()
  })

  it('opens a long list scrolled to its value and scrolls while open', () => {
    const { overlay, changes } = make()
    overlay.addSelect({
      id: 'long',
      x: 100,
      y: 150,
      options: Array.from({ length: 10 }, (_, i) => ({
        value: `v${i}`,
        label: 'Hi',
      })),
      value: 'v7',
      onChange: (value, id) => changes.push(`${id}:${value}`),
    })
    overlay.setBounds({ x: 0, y: 0, width: 400, height: 300 })
    overlay.open('long')
    // 288 px of options fit neither below (118) nor above (146): scroll above.
    const popup = overlay.getPopupLayout()
    expect(popup).toMatchObject({
      above: true,
      scrollable: true,
      y: 0,
      height: 146,
    })
    expect(popup?.rows.map((r) => r.index)).toEqual([5, 6, 7])
    expect(overlay.highlightedIndex).toBe(7)
    expect(overlay.wheel(110, 5, 0, 56)).toBe(true) // over the top strip: no row
    expect(overlay.getPopupLayout()?.rows.map((r) => r.index)).toEqual([
      7, 8, 9,
    ])
    expect(overlay.highlightedIndex).toBe(7)
    overlay.keyDown(key('ArrowDown'))
    overlay.keyDown(key('Enter'))
    expect(changes).toEqual(['long:v8'])
    expect(overlay.getValue('long')).toBe('v8')
    expect(overlay.wheel(110, 5, 0, 56)).toBe(false) // closed again
  })

  it('claims the layer keyboard as the select, not its inner menu', () => {
    const { overlay } = make()
    const claimed: unknown[] = []
    overlay.bindLayer({
      requestRedraw: () => {},
      focus: (child) => claimed.push(child),
    })
    overlay.open('s')
    expect(claimed).toEqual([overlay])
  })
})
