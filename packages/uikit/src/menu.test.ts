import { describe, expect, it } from 'bun:test'
import {
  activateMenuItem,
  buildMenuButton,
  buildMenuPopup,
  DEFAULT_MENU_BUTTON_STYLE,
  DEFAULT_MENU_STYLE,
  isMenuItemSelectable,
  layoutMenuButton,
  layoutMenuPopup,
  type MenuButtonSpec,
  type MenuItemSpec,
  menuRowAt,
  nextSelectableIndex,
  popupContains,
  scaleMenu,
} from './menu'
import type { UIKitFontMetrics } from './text/font'

// Stub font: 'H' and 'i' advance half an em; cap height is 0.7 em.
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([
    ['H', { plane: [0.05, 0, 0.4, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
    ['i', { plane: [0.05, 0, 0.1, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
  ]),
}
const BSTYLE = DEFAULT_MENU_BUTTON_STYLE
const STYLE = DEFAULT_MENU_STYLE
const ITEMS: MenuItemSpec[] = [
  { id: 'a', label: 'Hi' },
  { id: 'b', label: 'Hi', kind: 'check', shortcut: 'H' },
  { id: 'sep', kind: 'separator' },
  { id: 'r1', label: 'Hi', kind: 'radio', checked: true },
  { id: 'r2', label: 'Hi', kind: 'radio' },
  { id: 'd', label: 'Hi', enabled: false },
]
const SPEC: MenuButtonSpec = {
  id: 'm',
  label: 'Hi',
  x: 100,
  y: 50,
  items: ITEMS,
}

describe('layoutMenuButton', () => {
  it('fits the label plus padding and the chevron', () => {
    // 16 label + 28 padding + 6 gap + 10 chevron; 11.2 cap height + 16 padding.
    expect(layoutMenuButton(SPEC, BSTYLE, STYLE, METRICS)).toEqual({
      x: 100,
      y: 50,
      width: 60,
      height: 28,
    })
  })

  it('honours a fixed size', () => {
    const l = layoutMenuButton(
      { ...SPEC, width: 90, height: 40 },
      BSTYLE,
      STYLE,
      METRICS,
    )
    expect(l.width).toBe(90)
    expect(l.height).toBe(40)
  })
})

describe('layoutMenuPopup', () => {
  const button = layoutMenuButton(SPEC, BSTYLE, STYLE, METRICS)

  it('sits under the button, at least minWidth wide, with one row per item', () => {
    const l = layoutMenuPopup(ITEMS, STYLE, METRICS, button)
    expect(l.x).toBe(100)
    expect(l.y).toBe(82)
    expect(l.width).toBe(120)
    expect(l.height).toBe(157)
    expect(l.above).toBe(false)
    expect(l.rows.map((r) => [r.index, r.y, r.height])).toEqual([
      [0, 86, 28],
      [1, 114, 28],
      [2, 142, 9],
      [3, 151, 28],
      [4, 179, 28],
      [5, 207, 28],
    ])
    expect(l.rows[0].x).toBe(104)
    expect(l.rows[0].width).toBe(112)
  })

  it('grows to fit long labels and shortcuts', () => {
    const items: MenuItemSpec[] = [
      { id: 'x', label: 'HHHHHHHHHH', shortcut: 'HHHH' },
    ]
    const l = layoutMenuPopup(items, STYLE, METRICS, button)
    // 20 padding + 14 mark + 8 gap + 75 label + 24 gap + 30 shortcut + 8 panel.
    expect(l.width).toBe(179)
  })

  it('flips above the button when it would overflow the bounds below', () => {
    const low = { ...button, y: 300 }
    const l = layoutMenuPopup(ITEMS, STYLE, METRICS, low, {
      x: 0,
      y: 0,
      width: 400,
      height: 400,
    })
    expect(l.above).toBe(true)
    expect(l.y).toBe(300 - 4 - 157)
    // No room above either: stay below.
    const l2 = layoutMenuPopup(ITEMS, STYLE, METRICS, button, {
      x: 0,
      y: 0,
      width: 400,
      height: 200,
    })
    expect(l2.above).toBe(false)
    expect(l2.y).toBe(82)
  })

  it('clamps horizontally into the bounds', () => {
    const right = { ...button, x: 350 }
    const l = layoutMenuPopup(ITEMS, STYLE, METRICS, right, {
      x: 0,
      y: 0,
      width: 400,
      height: 400,
    })
    expect(l.x).toBe(280)
    expect(l.rows[0].x).toBe(284)
  })

  it('hit-tests the panel and its rows', () => {
    const l = layoutMenuPopup(ITEMS, STYLE, METRICS, button)
    expect(popupContains(l, 100, 82)).toBe(true)
    expect(popupContains(l, 219, 238)).toBe(true)
    expect(popupContains(l, 220, 100)).toBe(false)
    expect(menuRowAt(l, 110, 100)).toBe(0)
    expect(menuRowAt(l, 110, 145)).toBe(2)
    expect(menuRowAt(l, 110, 220)).toBe(5)
    expect(menuRowAt(l, 110, 84)).toBe(-1)
    expect(menuRowAt(l, 102, 100)).toBe(-1)
  })
})

describe('item navigation and activation', () => {
  it('selects only enabled non-separator items', () => {
    expect(ITEMS.map(isMenuItemSelectable)).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
    ])
  })

  it('steps to the next selectable index, wrapping and skipping', () => {
    expect(nextSelectableIndex(ITEMS, -1, 1)).toBe(0)
    expect(nextSelectableIndex(ITEMS, 0, 1)).toBe(1)
    expect(nextSelectableIndex(ITEMS, 1, 1)).toBe(3)
    expect(nextSelectableIndex(ITEMS, 4, 1)).toBe(0)
    expect(nextSelectableIndex(ITEMS, -1, -1)).toBe(4)
    expect(nextSelectableIndex(ITEMS, 3, -1)).toBe(1)
    expect(nextSelectableIndex(ITEMS, 0, -1)).toBe(4)
    expect(nextSelectableIndex([], -1, 1)).toBe(-1)
    expect(nextSelectableIndex([{ id: 's', kind: 'separator' }], -1, 1)).toBe(
      -1,
    )
  })

  it('flips a check item', () => {
    const r = activateMenuItem(ITEMS, 1)
    expect(r.items[1].checked).toBe(true)
    expect(r.changed).toEqual([{ id: 'b', checked: true }])
    const again = activateMenuItem(r.items, 1)
    expect(again.items[1].checked).toBe(false)
    expect(again.changed).toEqual([{ id: 'b', checked: false }])
    expect(ITEMS[1].checked).toBeUndefined()
  })

  it('makes a radio item the only checked one in its group', () => {
    const r = activateMenuItem(ITEMS, 4)
    expect(r.items[3].checked).toBe(false)
    expect(r.items[4].checked).toBe(true)
    expect(r.changed).toEqual([
      { id: 'r2', checked: true },
      { id: 'r1', checked: false },
    ])
    expect(activateMenuItem(ITEMS, 3).changed).toEqual([])
  })

  it('keeps radio groups independent', () => {
    const items: MenuItemSpec[] = [
      { id: 'a1', kind: 'radio', group: 'a', checked: true },
      { id: 'a2', kind: 'radio', group: 'a' },
      { id: 'b1', kind: 'radio', group: 'b', checked: true },
    ]
    const r = activateMenuItem(items, 1)
    expect(r.items.map((i) => i.checked ?? false)).toEqual([false, true, true])
  })

  it('changes nothing for actions, separators, disabled or missing items', () => {
    expect(activateMenuItem(ITEMS, 0).changed).toEqual([])
    expect(activateMenuItem(ITEMS, 2).changed).toEqual([])
    expect(activateMenuItem(ITEMS, 5).changed).toEqual([])
    expect(activateMenuItem(ITEMS, 9).changed).toEqual([])
  })
})

describe('scaleMenu', () => {
  it('scales the button and popup lengths, leaving colors and items alone', () => {
    const r = scaleMenu(SPEC, BSTYLE, STYLE, 2)
    expect(r.spec.x).toBe(200)
    expect(r.spec.items).toBe(ITEMS)
    expect(r.buttonStyle.paddingX).toBe(28)
    expect(r.style.itemHeight).toBe(56)
    expect(r.style.minWidth).toBe(240)
    expect(r.style.panelFill).toBe(STYLE.panelFill)
    expect(scaleMenu(SPEC, BSTYLE, STYLE, 1).spec).toBe(SPEC)
  })
})

describe('buildMenuButton', () => {
  const layout = layoutMenuButton(SPEC, BSTYLE, STYLE, METRICS)
  const idle = { hover: false, press: 0, enabled: true, open: false }

  it('shifts the label left of centre and draws a down chevron', () => {
    const geo = buildMenuButton(SPEC, BSTYLE, STYLE, METRICS, layout, idle)
    expect(geo.text.x).toBe(130 - 8)
    expect(geo.lines.length).toBe(2)
    // Chevron centred 5px in from the right padding, pointing down.
    const [l0, l1] = geo.lines
    expect(l0.data[0]).toBe(136)
    expect(l0.data[2]).toBe(141)
    expect(l1.data[2]).toBe(146)
    expect(l0.data[3]).toBeGreaterThan(l0.data[1])
  })

  it('points the chevron up and uses the pressed face while open', () => {
    const geo = buildMenuButton(SPEC, BSTYLE, STYLE, METRICS, layout, {
      ...idle,
      open: true,
    })
    expect(geo.lines[0].data[3]).toBeLessThan(geo.lines[0].data[1])
    const fill = geo.rect.data.slice(8, 12)
    for (let i = 0; i < 4; i++)
      expect(fill[i]).toBeCloseTo(BSTYLE.pressedFill[i], 5)
    expect(geo.rect.data[2]).toBe(60) // no shrink
  })
})

describe('buildMenuPopup', () => {
  const button = layoutMenuButton(SPEC, BSTYLE, STYLE, METRICS)
  const layout = layoutMenuPopup(ITEMS, STYLE, METRICS, button)

  it('draws the panel, the highlight, marks, labels, shortcuts and separators', () => {
    const geo = buildMenuPopup(ITEMS, STYLE, METRICS, layout, 1)
    // Panel, highlight under row 1, radio dot for r1.
    expect(geo.rects.length).toBe(3)
    expect(geo.rects[1].data[1]).toBe(114)
    expect(geo.rects[1].data[3]).toBe(28)
    // One separator rule; the check item is unchecked.
    expect(geo.lines.length).toBe(1)
    expect(geo.lines[0].data[1]).toBeCloseTo(146.5)
    // Five labels and one shortcut (right-aligned).
    expect(geo.text.length).toBe(6)
    expect(geo.text[0]).toMatchObject({
      str: 'Hi',
      x: 104 + 10 + 14 + 8,
      align: 0,
    })
    expect(geo.text[2]).toMatchObject({ str: 'H', x: 216 - 10, align: 1 })
  })

  it('draws a check mark for a checked check item and no highlight on a disabled row', () => {
    const items = activateMenuItem(ITEMS, 1).items
    const geo = buildMenuPopup(items, STYLE, METRICS, layout, 5)
    expect(geo.rects.length).toBe(2)
    expect(geo.lines.length).toBe(3)
    const dim = geo.text[5].color ?? []
    expect(dim[3]).toBeCloseTo(STYLE.disabledTextColor[3])
  })
})
