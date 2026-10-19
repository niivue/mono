// Pure menu model for UIKit: a menu button (a push button with a chevron) that
// opens a popup of items. Items are plain actions, checkable items that keep a
// boolean, radio items that are exclusive within a group, or separators. This
// file holds style resolution, layout (button box; popup placed below the
// button, flipped above it when it would overflow, and scrolled by whole rows
// when it fits neither way), item-state transitions and keyboard navigation,
// and the geometry for one visual state. No GPU and no DOM here;
// UIKitMenuOverlay wires it to the pointer, the wheel, the keyboard and the
// overlay draw hook.

import {
  type ButtonLayout,
  type ButtonSpec,
  type ButtonStyle,
  type ButtonVisual,
  buildButton,
  DEFAULT_BUTTON_STYLE,
  scaleButton,
} from './button'
import { buildLine, type LineData } from './line'
import { buildRect, type RectData, rectContains } from './rect'
import {
  buildScrollArrow,
  canScrollDown,
  canScrollUp,
  revealRow,
  scrollWindow,
  type UIKitBox,
} from './scroll'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { UIKitTextItem } from './textOverlay'
import { buildCheckMark } from './toggle'

export type MenuItemKind = 'action' | 'check' | 'radio' | 'separator'

export interface MenuItemSpec {
  /** Stable key within the menu: the handle for state and the callbacks. */
  id: string
  /** Shown text. Ignored for a separator. */
  label?: string
  /**
   * 'action' (default) fires and closes; 'check' keeps a boolean the user
   * flips; 'radio' is one of an exclusive group; 'separator' is a rule.
   */
  kind?: MenuItemKind
  /** Current state of a check or radio item. Default false. */
  checked?: boolean
  /** Radio group key. Radios without one share the menu's default group. */
  group?: string
  /** A disabled item draws dimmed and cannot be highlighted or activated. */
  enabled?: boolean
  /** A hint drawn right-aligned (a key combination, say). Not bound to any key. */
  shortcut?: string
  /** Fired when this item is activated (after any state change is applied). */
  onSelect?: (id: string) => void
}

/** Every visual knob on a menu popup. All lengths are in canvas pixels. */
export interface MenuStyle {
  panelFill: RGBA
  panelBorder: RGBA
  panelBorderWidth: number
  panelRadius: number
  /** Space between the panel edge and the rows. */
  panelPadding: number
  /** Height of an action, check or radio row. */
  itemHeight: number
  /** Space between the row edge and its contents. */
  itemPaddingX: number
  /** Row color under the highlighted item. */
  highlightFill: RGBA
  textColor: RGBA
  disabledTextColor: RGBA
  shortcutColor: RGBA
  /** Item em size. */
  textSizePx: number
  /** Check-mark and radio-dot color. */
  checkColor: RGBA
  /** Side of the square the check mark or radio dot is drawn in. */
  markSize: number
  /** Check-mark stroke width. */
  markWidth: number
  /** Space between the mark slot and the label. */
  markGap: number
  /** Least space between the longest label and the shortcut column. */
  shortcutGap: number
  separatorColor: RGBA
  /** Height of a separator row (the rule is centred in it). */
  separatorHeight: number
  /** Space between the button and the popup. */
  gapToButton: number
  /** Width of the chevron on the button, and its stroke width. */
  chevronSize: number
  chevronWidth: number
  /** Space between the label and the chevron. */
  chevronGap: number
  /** Least popup width. */
  minWidth: number
  /** Height of the strips at each end of a scrolled popup (they hold the arrows). */
  scrollStripHeight: number
  /** Width of the scroll arrows, and their stroke width. */
  scrollArrowSize: number
  scrollArrowWidth: number
  scrollArrowColor: RGBA
}

export const DEFAULT_MENU_STYLE: MenuStyle = {
  panelFill: [0.12, 0.13, 0.17, 0.98],
  panelBorder: [0.6, 0.66, 0.78, 1],
  panelBorderWidth: 1,
  panelRadius: 6,
  panelPadding: 4,
  itemHeight: 28,
  itemPaddingX: 10,
  highlightFill: [0.25, 0.47, 0.85, 1],
  textColor: [1, 1, 1, 1],
  disabledTextColor: [1, 1, 1, 0.45],
  shortcutColor: [1, 1, 1, 0.6],
  textSizePx: 15,
  checkColor: [1, 1, 1, 1],
  markSize: 14,
  markWidth: 2,
  markGap: 8,
  shortcutGap: 24,
  separatorColor: [0.6, 0.66, 0.78, 0.5],
  separatorHeight: 9,
  gapToButton: 4,
  chevronSize: 10,
  chevronWidth: 2,
  chevronGap: 6,
  minWidth: 120,
  scrollStripHeight: 14,
  scrollArrowSize: 10,
  scrollArrowWidth: 1.5,
  scrollArrowColor: [1, 1, 1, 0.8],
}

/** The button style menus start from: a push button that does not shrink. */
export const DEFAULT_MENU_BUTTON_STYLE: ButtonStyle = {
  ...DEFAULT_BUTTON_STYLE,
  pressScale: 1,
}

export interface MenuButtonSpec {
  /** Stable key: the handle for updates, open state and the callbacks. */
  id: string
  label: string
  /** Top-left corner of the button, in canvas pixels. */
  x: number
  y: number
  /** Fixed button size. Omit either to size that axis to the label and chevron. */
  width?: number
  height?: number
  items: readonly MenuItemSpec[]
  /** A disabled menu button draws dimmed and cannot open. Default true. */
  enabled?: boolean
  /** Per-menu overrides of the overlay's default button style. */
  buttonStyle?: Partial<ButtonStyle>
  /** Per-menu overrides of the overlay's default popup style. */
  style?: Partial<MenuStyle>
  /** Fired when any enabled item is activated, after its own `onSelect`. */
  onSelect?: (itemId: string, menuId: string) => void
  /**
   * Fired for each check or radio item whose state changed: once for a check
   * item, and for a radio once for the newly checked item plus once for each
   * item it unchecked.
   */
  onChange?: (itemId: string, checked: boolean, menuId: string) => void
}

/** One row of an open popup, in canvas pixels. */
export interface MenuRowLayout {
  /** Index into the menu's items. */
  index: number
  x: number
  y: number
  width: number
  height: number
}

/** The popup panel and its rows, in canvas pixels. */
export interface MenuPopupLayout {
  x: number
  y: number
  width: number
  height: number
  /**
   * The visible rows only. When the popup scrolls these are the run from
   * `firstRow` that fits between the strips.
   */
  rows: MenuRowLayout[]
  /** Whether the panel sits above the button (it would overflow below). */
  above: boolean
  /** True when the items do not all fit and the popup scrolls by rows. */
  scrollable: boolean
  /** Index of the first visible item (0 when not scrollable). */
  firstRow: number
  /** Index after the last visible item (the item count when not scrollable). */
  endRow: number
  /** The strips at the top and bottom of a scrollable popup, else null. */
  scrollUp: UIKitBox | null
  scrollDown: UIKitBox | null
}

/** A rectangle popups must stay within (the overlay frame's bounds). */
export interface MenuBounds {
  x: number
  y: number
  width: number
  height: number
}

export function resolveMenuStyle(
  base: MenuStyle,
  override?: Partial<MenuStyle>,
): MenuStyle {
  return override ? { ...base, ...override } : base
}

/** True for an item the user can highlight and activate. */
export function isMenuItemSelectable(item: MenuItemSpec): boolean {
  return item.kind !== 'separator' && item.enabled !== false
}

/** The `ButtonSpec` a menu button draws as (label plus room for the chevron). */
export function menuButtonSpec(
  spec: MenuButtonSpec,
  buttonStyle: ButtonStyle,
  style: MenuStyle,
  metrics: UIKitFontMetrics,
): ButtonSpec {
  const labelW = measureWidth(metrics, spec.label, buttonStyle.textSizePx)
  const width =
    spec.width ??
    Math.ceil(
      labelW + 2 * buttonStyle.paddingX + style.chevronGap + style.chevronSize,
    )
  return {
    id: spec.id,
    label: spec.label,
    x: spec.x,
    y: spec.y,
    width,
    height: spec.height,
    enabled: spec.enabled,
  }
}

/** The button's box: fitted to the label plus the chevron unless fixed. */
export function layoutMenuButton(
  spec: MenuButtonSpec,
  buttonStyle: ButtonStyle,
  style: MenuStyle,
  metrics: UIKitFontMetrics,
): ButtonLayout {
  const b = menuButtonSpec(spec, buttonStyle, style, metrics)
  const labelH = capHeight(metrics) * buttonStyle.textSizePx
  return {
    x: b.x,
    y: b.y,
    width: b.width ?? 0,
    height: b.height ?? Math.ceil(labelH + 2 * buttonStyle.paddingY),
  }
}

/** The height of one row: a separator's or an item's. */
export function menuRowHeight(item: MenuItemSpec, style: MenuStyle): number {
  return item.kind === 'separator' ? style.separatorHeight : style.itemHeight
}

/** The height of the row area of a scrollable popup (between its strips). */
function menuViewportHeight(height: number, style: MenuStyle): number {
  return height - 2 * style.panelPadding - 2 * style.scrollStripHeight
}

/**
 * Place the popup under the button (above it when it would overflow the
 * bounds below), clamped into the bounds horizontally, and lay out its rows.
 * When the items fit neither below nor above, the popup takes the roomier
 * side and scrolls: it keeps a strip at each end and shows the whole rows
 * from `firstRow` (clamped so the list never scrolls past its end) that fit
 * between them. Without bounds a popup never scrolls.
 */
export function layoutMenuPopup(
  items: readonly MenuItemSpec[],
  style: MenuStyle,
  metrics: UIKitFontMetrics,
  button: ButtonLayout,
  bounds: MenuBounds | null = null,
  firstRow = 0,
): MenuPopupLayout {
  const size = style.textSizePx
  const heights = items.map((item) => menuRowHeight(item, style))
  let labelW = 0
  let shortcutW = 0
  let rowsH = 0
  items.forEach((item, i) => {
    rowsH += heights[i]
    if (item.kind === 'separator') return
    labelW = Math.max(labelW, measureWidth(metrics, item.label ?? '', size))
    if (item.shortcut) {
      shortcutW = Math.max(
        shortcutW,
        measureWidth(metrics, item.shortcut, size),
      )
    }
  })
  const inner =
    2 * style.itemPaddingX +
    style.markSize +
    style.markGap +
    labelW +
    (shortcutW > 0 ? style.shortcutGap + shortcutW : 0)
  const width = Math.ceil(
    Math.max(style.minWidth, inner + 2 * style.panelPadding),
  )
  const contentHeight = Math.ceil(rowsH + 2 * style.panelPadding)

  let x = button.x
  let y = button.y + button.height + style.gapToButton
  let height = contentHeight
  let above = false
  if (bounds) {
    const below = bounds.y + bounds.height - y
    const over = button.y - style.gapToButton - bounds.y
    if (height > below) {
      if (height <= over) {
        above = true
      } else {
        // Fits neither way: scroll on the roomier side, or fill the bounds
        // when even that side cannot show one row between the strips.
        const usable = Math.floor(Math.max(below, over))
        const least =
          2 * style.panelPadding +
          2 * style.scrollStripHeight +
          style.itemHeight
        if (usable >= least) {
          height = Math.min(contentHeight, usable)
          above = over > below
        } else {
          height = Math.min(contentHeight, Math.floor(bounds.height))
          y = bounds.y
        }
      }
      if (above) y = button.y - style.gapToButton - height
    }
    x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - width))
  }

  const scrollable = height < contentHeight
  let first = 0
  let end = items.length
  let cursor = y + style.panelPadding
  if (scrollable) {
    const w = scrollWindow(heights, menuViewportHeight(height, style), firstRow)
    first = w.first
    end = w.end
    cursor += style.scrollStripHeight
  }
  const rows: MenuRowLayout[] = []
  for (let index = first; index < end; index++) {
    rows.push({
      index,
      x: x + style.panelPadding,
      y: cursor,
      width: width - 2 * style.panelPadding,
      height: heights[index],
    })
    cursor += heights[index]
  }
  const strip = (top: number): UIKitBox => ({
    x: x + style.panelPadding,
    y: top,
    width: width - 2 * style.panelPadding,
    height: style.scrollStripHeight,
  })
  return {
    x,
    y,
    width,
    height,
    rows,
    above,
    scrollable,
    firstRow: first,
    endRow: end,
    scrollUp: scrollable ? strip(y + style.panelPadding) : null,
    scrollDown: scrollable
      ? strip(y + height - style.panelPadding - style.scrollStripHeight)
      : null,
  }
}

/**
 * The `firstRow` that brings item `index` into view in a scrollable popup,
 * moving as little as possible (see `revealRow`). The current `firstRow` when
 * the popup does not scroll or the item is already visible.
 */
export function menuRevealRow(
  items: readonly MenuItemSpec[],
  style: MenuStyle,
  layout: MenuPopupLayout,
  index: number,
): number {
  if (!layout.scrollable) return layout.firstRow
  const heights = items.map((item) => menuRowHeight(item, style))
  return revealRow(
    heights,
    menuViewportHeight(layout.height, style),
    { first: layout.firstRow, end: layout.endRow },
    index,
  )
}

/**
 * The scroll strip under a canvas point of a scrollable popup: -1 for the top
 * strip, 1 for the bottom one, 0 for neither.
 */
export function menuScrollStripAt(
  layout: MenuPopupLayout,
  px: number,
  py: number,
): -1 | 0 | 1 {
  if (layout.scrollUp && rectContains(layout.scrollUp, px, py)) return -1
  if (layout.scrollDown && rectContains(layout.scrollDown, px, py)) return 1
  return 0
}

/** Scale every length in a menu spec and its styles by `k`. */
export function scaleMenu(
  spec: MenuButtonSpec,
  buttonStyle: ButtonStyle,
  style: MenuStyle,
  k: number,
): { spec: MenuButtonSpec; buttonStyle: ButtonStyle; style: MenuStyle } {
  if (k === 1) return { spec, buttonStyle, style }
  const b = scaleButton(
    {
      id: spec.id,
      label: spec.label,
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
    },
    buttonStyle,
    k,
  )
  return {
    spec: {
      ...spec,
      x: b.spec.x,
      y: b.spec.y,
      width: b.spec.width,
      height: b.spec.height,
    },
    buttonStyle: b.style,
    style: {
      ...style,
      panelBorderWidth: style.panelBorderWidth * k,
      panelRadius: style.panelRadius * k,
      panelPadding: style.panelPadding * k,
      itemHeight: style.itemHeight * k,
      itemPaddingX: style.itemPaddingX * k,
      textSizePx: style.textSizePx * k,
      markSize: style.markSize * k,
      markWidth: style.markWidth * k,
      markGap: style.markGap * k,
      shortcutGap: style.shortcutGap * k,
      separatorHeight: style.separatorHeight * k,
      gapToButton: style.gapToButton * k,
      chevronSize: style.chevronSize * k,
      chevronWidth: style.chevronWidth * k,
      chevronGap: style.chevronGap * k,
      minWidth: style.minWidth * k,
      scrollStripHeight: style.scrollStripHeight * k,
      scrollArrowSize: style.scrollArrowSize * k,
      scrollArrowWidth: style.scrollArrowWidth * k,
    },
  }
}

/** True when canvas point (px, py) lies inside the popup panel. */
export function popupContains(
  layout: MenuPopupLayout,
  px: number,
  py: number,
): boolean {
  return rectContains(layout, px, py)
}

/** The index of the row under a canvas point, or -1 (separators count as rows). */
export function menuRowAt(
  layout: MenuPopupLayout,
  px: number,
  py: number,
): number {
  for (const row of layout.rows) {
    if (
      px >= row.x &&
      px < row.x + row.width &&
      py >= row.y &&
      py < row.y + row.height
    ) {
      return row.index
    }
  }
  return -1
}

/**
 * The next selectable index from `from` in `direction`, wrapping around and
 * skipping separators and disabled items. Pass -1 to start from the end the
 * search enters at. Returns -1 when nothing is selectable.
 */
export function nextSelectableIndex(
  items: readonly MenuItemSpec[],
  from: number,
  direction: 1 | -1,
): number {
  const n = items.length
  if (n === 0) return -1
  let i = from < 0 || from >= n ? (direction > 0 ? -1 : n) : from
  for (let step = 0; step < n; step++) {
    i = (i + direction + n) % n
    if (isMenuItemSelectable(items[i])) return i
  }
  return -1
}

/**
 * The item states after activating `items[index]`: a check item flips, a
 * radio item becomes the checked one in its group, anything else is unchanged.
 * `changed` lists every item whose `checked` differs, the activated one first.
 */
export function activateMenuItem(
  items: readonly MenuItemSpec[],
  index: number,
): { items: MenuItemSpec[]; changed: { id: string; checked: boolean }[] } {
  const target = items[index]
  const next = [...items]
  const changed: { id: string; checked: boolean }[] = []
  if (!target || !isMenuItemSelectable(target)) return { items: next, changed }
  if (target.kind === 'check') {
    const checked = !(target.checked ?? false)
    next[index] = { ...target, checked }
    changed.push({ id: target.id, checked })
  } else if (target.kind === 'radio') {
    if (!target.checked) {
      next[index] = { ...target, checked: true }
      changed.push({ id: target.id, checked: true })
    }
    const group = target.group ?? ''
    items.forEach((item, i) => {
      if (i === index || item.kind !== 'radio' || (item.group ?? '') !== group)
        return
      if (item.checked) {
        next[i] = { ...item, checked: false }
        changed.push({ id: item.id, checked: false })
      }
    })
  }
  return { items: next, changed }
}

/** Visual state of a menu button: a push button that also shows whether it is open. */
export interface MenuButtonVisual extends ButtonVisual {
  open: boolean
}

/**
 * The draw data for a menu button: the face and label (shifted left to leave
 * room for the chevron) and a chevron pointing down, or up while open.
 */
export function buildMenuButton(
  spec: MenuButtonSpec,
  buttonStyle: ButtonStyle,
  style: MenuStyle,
  metrics: UIKitFontMetrics,
  layout: ButtonLayout,
  visual: MenuButtonVisual,
): { rect: RectData; text: UIKitTextItem; lines: LineData[] } {
  const b = menuButtonSpec(spec, buttonStyle, style, metrics)
  const { rect, text } = buildButton(b, buttonStyle, metrics, layout, {
    hover: visual.hover,
    press: visual.open ? 1 : visual.press,
    enabled: visual.enabled,
  })
  const chevronW = style.chevronSize + style.chevronGap
  text.x -= chevronW / 2
  const cx =
    layout.x + layout.width - buttonStyle.paddingX - style.chevronSize / 2
  const cy = layout.y + layout.height / 2
  const half = style.chevronSize / 2
  const rise = style.chevronSize / 4
  const dir = visual.open ? -1 : 1
  const color = visual.enabled
    ? buttonStyle.textColor
    : buttonStyle.disabledTextColor
  const lines = [
    buildLine(
      cx - half,
      cy - rise * dir,
      cx,
      cy + rise * dir,
      style.chevronWidth,
      color,
    ),
    buildLine(
      cx,
      cy + rise * dir,
      cx + half,
      cy - rise * dir,
      style.chevronWidth,
      color,
    ),
  ]
  return { rect, text, lines }
}

/**
 * The draw data for an open popup: the panel, the highlight under
 * `highlightIndex` (when that item is selectable), then per visible row the
 * mark (check mark or radio dot when checked), the label, the shortcut and
 * the separator rules, and on a scrollable popup an arrow on each strip that
 * has rows beyond it.
 */
export function buildMenuPopup(
  items: readonly MenuItemSpec[],
  style: MenuStyle,
  metrics: UIKitFontMetrics,
  layout: MenuPopupLayout,
  highlightIndex: number,
): { rects: RectData[]; lines: LineData[]; text: UIKitTextItem[] } {
  const rects: RectData[] = [
    buildRect({
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
      radius: style.panelRadius,
      borderWidth: style.panelBorderWidth,
      fill: style.panelFill,
      border: style.panelBorder,
    }),
  ]
  const lines: LineData[] = []
  const text: UIKitTextItem[] = []
  const size = style.textSizePx
  const baselineDrop = (capHeight(metrics) * size) / 2
  const strips = {
    height: style.scrollStripHeight,
    arrowSize: style.scrollArrowSize,
    arrowWidth: style.scrollArrowWidth,
    arrowColor: style.scrollArrowColor,
  }
  const shown = { first: layout.firstRow, end: layout.endRow }
  if (layout.scrollUp && canScrollUp(shown)) {
    lines.push(...buildScrollArrow(layout.scrollUp, -1, strips))
  }
  if (layout.scrollDown && canScrollDown(shown, items.length)) {
    lines.push(...buildScrollArrow(layout.scrollDown, 1, strips))
  }
  for (const row of layout.rows) {
    const item = items[row.index]
    if (!item) continue
    const cy = row.y + row.height / 2
    if (item.kind === 'separator') {
      lines.push(
        buildLine(
          row.x + style.itemPaddingX,
          cy,
          row.x + row.width - style.itemPaddingX,
          cy,
          1,
          style.separatorColor,
        ),
      )
      continue
    }
    const selectable = isMenuItemSelectable(item)
    if (row.index === highlightIndex && selectable) {
      rects.push(
        buildRect({
          x: row.x,
          y: row.y,
          width: row.width,
          height: row.height,
          radius: Math.max(0, style.panelRadius - style.panelPadding),
          fill: style.highlightFill,
        }),
      )
    }
    const color = selectable ? style.textColor : style.disabledTextColor
    const markX = row.x + style.itemPaddingX
    if (item.checked) {
      if (item.kind === 'check') {
        lines.push(
          ...buildCheckMark(
            markX,
            cy - style.markSize / 2,
            style.markSize,
            style.markWidth,
            selectable ? style.checkColor : style.disabledTextColor,
          ),
        )
      } else if (item.kind === 'radio') {
        const d = style.markSize / 2
        rects.push(
          buildRect({
            x: markX + (style.markSize - d) / 2,
            y: cy - d / 2,
            width: d,
            height: d,
            radius: d / 2,
            fill: selectable ? style.checkColor : style.disabledTextColor,
          }),
        )
      }
    }
    text.push({
      str: item.label ?? '',
      x: markX + style.markSize + style.markGap,
      y: cy + baselineDrop,
      sizePx: size,
      align: 0,
      color,
    })
    if (item.shortcut) {
      text.push({
        str: item.shortcut,
        x: row.x + row.width - style.itemPaddingX,
        y: cy + baselineDrop,
        sizePx: size,
        align: 1,
        color: selectable ? style.shortcutColor : style.disabledTextColor,
      })
    }
  }
  return { rects, lines, text }
}
