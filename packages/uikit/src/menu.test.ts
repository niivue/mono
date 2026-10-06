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
  menuRevealRow,
  menuRowAt,
  menuScrollStripAt,
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

describe('layoutMenuPopup scrolling', () => {
  const LONG: MenuItemSpec[] = Array.from({ length: 10 }, (_, i) => ({
    id: `i${i}`,
    label: 'Hi',
  }))
  const button = layoutMenuButton(SPEC, BSTYLE, STYLE, METRICS)
  const bounds = { x: 0, y: 0, width: 400, height: 200 }

  it('scrolls on the roomier side when the items fit neither below nor above', () => {
    const l = layoutMenuPopup(LONG, STYLE, METRICS, button, bounds)
    expect(l.scrollable).toBe(true)
    expect(l.above).toBe(false)
    expect(l.y).toBe(82)
    expect(l.height).toBe(118) // all that is left below the button
    // 118 - 8 padding - 28 strips = 82: two 28 px rows fit, three do not.
    expect(l.firstRow).toBe(0)
    expect(l.endRow).toBe(2)
    expect(l.rows).toEqual([
      { index: 0, x: 104, y: 100, width: 112, height: 28 },
      { index: 1, x: 104, y: 128, width: 112, height: 28 },
    ])
    expect(l.scrollUp).toEqual({ x: 104, y: 86, width: 112, height: 14 })
    expect(l.scrollDown).toEqual({ x: 104, y: 182, width: 112, height: 14 })
    // Above is roomier for a low button: 12 items (344 px) do not fit the 296 above.
    const twelve = [
      ...LONG,
      { id: 'i10', label: 'Hi' },
      { id: 'i11', label: 'Hi' },
    ]
    const up = layoutMenuPopup(
      twelve,
      STYLE,
      METRICS,
      { ...button, y: 300 },
      {
        ...bounds,
        height: 400,
      },
    )
    expect(up).toMatchObject({
      above: true,
      scrollable: true,
      y: 0,
      height: 296,
    })
    expect(up.endRow).toBe(9) // (296 - 36) / 28
  })

  it('clamps the first row, and fills the bounds when neither side can show a row', () => {
    const l = layoutMenuPopup(LONG, STYLE, METRICS, button, bounds, 20)
    expect(l.firstRow).toBe(8)
    expect(l.endRow).toBe(10)
    expect(l.rows.map((r) => r.index)).toEqual([8, 9])
    expect(l.rows[0].y).toBe(100) // the first visible row keeps its slot
    const tight = layoutMenuPopup(LONG, STYLE, METRICS, button, {
      ...bounds,
      height: 100,
    })
    expect(tight).toMatchObject({
      y: 0,
      height: 100,
      scrollable: true,
      endRow: 2,
    })
  })

  it('never scrolls without bounds or when the items fit', () => {
    const free = layoutMenuPopup(LONG, STYLE, METRICS, button)
    expect(free.scrollable).toBe(false)
    expect(free.rows).toHaveLength(10)
    expect(free.scrollUp).toBeNull()
    expect(free.scrollDown).toBeNull()
    const fits = layoutMenuPopup(ITEMS, STYLE, METRICS, button, bounds)
    expect(fits.scrollable).toBe(true) // 157 px into 118: the old stay-below case
    expect(
      layoutMenuPopup(ITEMS, STYLE, METRICS, button, { ...bounds, height: 400 })
        .scrollable,
    ).toBe(false)
  })

  it('reveals a row with the least scroll, and finds the strips', () => {
    const l = layoutMenuPopup(LONG, STYLE, METRICS, button, bounds)
    expect(menuRevealRow(LONG, STYLE, l, 1)).toBe(0)
    expect(menuRevealRow(LONG, STYLE, l, 5)).toBe(4)
    expect(menuRevealRow(LONG, STYLE, l, -1)).toBe(0)
    const tail = layoutMenuPopup(LONG, STYLE, METRICS, button, bounds, 8)
    expect(menuRevealRow(LONG, STYLE, tail, 3)).toBe(3)
    const free = layoutMenuPopup(LONG, STYLE, METRICS, button)
    expect(menuRevealRow(LONG, STYLE, free, 9)).toBe(0)
    expect(menuScrollStripAt(l, 110, 90)).toBe(-1)
    expect(menuScrollStripAt(l, 110, 190)).toBe(1)
    expect(menuScrollStripAt(l, 110, 110)).toBe(0)
    expect(menuScrollStripAt(free, 110, 90)).toBe(0)
  })

  it('draws an arrow only on a strip with rows beyond it, and no hidden highlight', () => {
    const top = layoutMenuPopup(LONG, STYLE, METRICS, button, bounds)
    const geo = buildMenuPopup(LONG, STYLE, METRICS, top, 5)
    expect(geo.rects).toHaveLength(1) // panel only: row 5 is not visible
    expect(geo.lines).toHaveLength(2) // the down chevron
    expect(geo.lines[0].data[1]).toBe(186.5) // centred on the bottom strip (182..196)
    expect(geo.text).toHaveLength(2)
    const mid = layoutMenuPopup(LONG, STYLE, METRICS, button, bounds, 4)
    expect(buildMenuPopup(LONG, STYLE, METRICS, mid, 4).lines).toHaveLength(4)
    expect(buildMenuPopup(LONG, STYLE, METRICS, mid, 4).rects).toHaveLength(2)
    const end = layoutMenuPopup(LONG, STYLE, METRICS, button, bounds, 8)
    const up = buildMenuPopup(LONG, STYLE, METRICS, end, -1).lines
    expect(up).toHaveLength(2)
    expect(up[0].data[1]).toBe(95.5) // the up chevron sits in the top strip (86..100)
  })
})
