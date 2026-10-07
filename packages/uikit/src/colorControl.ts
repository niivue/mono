// Pure color control model for UIKit: style resolution, the layout of a
// preview swatch beside a stack of channel sliders (R, G, B and optionally A)
// over a row of named palette swatches, and the geometry for everything but
// the sliders themselves. No GPU and no DOM here; UIKitColorControlOverlay
// composes a slider overlay for the channels and wires the pointer and the
// keyboard. There is no browser color picker: the legacy demos edit colors
// through channel sliders and palette choices, and so does this.

import { buildRect, type RectData } from './rect'
import type { UIKitBox } from './scroll'
import type { SliderStyle } from './slider'
import type { UIKitFontMetrics } from './text/font'
import { capHeight, measureWidth, type RGBA } from './text/layout'
import type { UIKitTextItem } from './textOverlay'
import { buildFocusRing } from './toggle'

/** Every visual knob on a color control. All lengths are in canvas pixels. */
export interface ColorControlStyle {
  textColor: RGBA
  disabledTextColor: RGBA
  /** Label and channel letter em size. */
  textSizePx: number
  /** Halo outline width around the label and letters (they sit on the scene); 0 draws none. */
  textOutlineWidth: number
  /** Halo color; null picks black or white against `textColor`. */
  textOutlineColor: RGBA | null
  /** Space between the label row and the block below it. */
  labelGap: number
  /** Side of the square preview swatch. */
  previewSize: number
  previewRadius: number
  previewBorder: RGBA
  previewBorderWidth: number
  /** Drawn under the preview so a translucent color shows its alpha. */
  previewBackdrop: RGBA
  /** Space between the preview and the sliders, and between the letters and tracks. */
  gap: number
  /** Vertical space between channel sliders. */
  channelGap: number
  /** Style overrides for the channel sliders. */
  slider: Partial<SliderStyle>
  /** Side of each palette swatch. */
  swatchSize: number
  swatchGap: number
  swatchRadius: number
  swatchBorder: RGBA
  swatchBorderWidth: number
  /** Ring around the swatch matching the current color. */
  selectedRing: RGBA
  selectedRingWidth: number
  /** Ring around the hovered swatch. */
  hoverRing: RGBA
  /** Space between the sliders block and the palette row. */
  paletteGap: number
}

export const DEFAULT_COLOR_CONTROL_STYLE: ColorControlStyle = {
  textColor: [1, 1, 1, 1],
  disabledTextColor: [1, 1, 1, 0.45],
  textSizePx: 14,
  textOutlineWidth: 1,
  textOutlineColor: null,
  labelGap: 6,
  previewSize: 48,
  previewRadius: 6,
  previewBorder: [0.6, 0.66, 0.78, 1],
  previewBorderWidth: 1,
  previewBackdrop: [0.5, 0.5, 0.5, 1],
  gap: 10,
  channelGap: 2,
  slider: { thumbSize: 12, trackHeight: 5, trackRadius: 2.5 },
  swatchSize: 18,
  swatchGap: 4,
  swatchRadius: 3,
  swatchBorder: [0.6, 0.66, 0.78, 1],
  swatchBorderWidth: 1,
  selectedRing: [1, 1, 1, 1],
  selectedRingWidth: 2,
  hoverRing: [1, 1, 1, 0.5],
  paletteGap: 8,
}

/** A named palette choice. */
export interface ColorSwatch {
  name: string
  color: RGBA
}

export interface ColorControlSpec {
  /** Stable key: the handle for updates, pointer tracking and the callbacks. */
  id: string
  /** Optional label, drawn above the control at the left. */
  label?: string
  /** Top-left corner of the whole control, in canvas pixels. */
  x: number
  y: number
  /** Width of the whole control. Default 220. */
  width?: number
  /** Initial color, channels 0 to 1. */
  value: RGBA
  /** Show an alpha slider. Default false (alpha stays as given). */
  alpha?: boolean
  /** Named colors drawn as a row of swatches under the sliders. */
  palette?: readonly ColorSwatch[]
  /** A disabled control draws dimmed and ignores input. Default true. */
  enabled?: boolean
  /** Per-control overrides of the overlay's default style. */
  style?: Partial<ColorControlStyle>
  /** Fired for every change: each slider move or key press, each swatch press. */
  onInput?: (color: RGBA, id: string) => void
  /** Fired once per committed change: slider release, key press, swatch press. */
  onChange?: (color: RGBA, id: string) => void
}

export type ColorChannel = 'r' | 'g' | 'b' | 'a'

export const COLOR_CHANNELS: readonly ColorChannel[] = ['r', 'g', 'b', 'a']

/** The control's boxes in canvas pixels. */
export interface ColorControlLayout {
  x: number
  y: number
  width: number
  height: number
  /** Baseline of the label, or null without one. */
  labelBaseline: number | null
  preview: UIKitBox
  /** One row per channel: the letter's position and the slider's box. */
  channels: {
    channel: ColorChannel
    letterX: number
    baseline: number
    slider: UIKitBox
  }[]
  /** Palette swatches in spec order. */
  swatches: UIKitBox[]
}

/** The transient state that changes how a color control looks. */
export interface ColorControlVisual {
  value: RGBA
  /** Index of the hovered swatch, or -1. */
  hoverSwatch: number
  enabled: boolean
}

export function resolveColorControlStyle(
  base: ColorControlStyle,
  override?: Partial<ColorControlStyle>,
): ColorControlStyle {
  return override ? { ...base, ...override } : base
}

/** True when two colors agree in every channel within a rounding tolerance. */
export function colorsEqual(a: RGBA, b: RGBA, tolerance = 1e-6): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance &&
    Math.abs(a[3] - b[3]) <= tolerance
  )
}

/** A copy of `color` with one channel replaced (clamped to 0..1). */
export function withChannel(
  color: RGBA,
  channel: ColorChannel,
  v: number,
): RGBA {
  const out = [color[0], color[1], color[2], color[3]]
  out[COLOR_CHANNELS.indexOf(channel)] = Math.min(1, Math.max(0, v))
  return [out[0], out[1], out[2], out[3]]
}

/** The palette index whose color equals `color`, or -1. */
export function selectedSwatch(
  palette: readonly ColorSwatch[] | undefined,
  color: RGBA,
): number {
  if (!palette) return -1
  return palette.findIndex((s) => colorsEqual(s.color, color))
}

/** Height of one channel row: the slider's thumb or track, whichever is taller. */
function channelRowHeight(style: ColorControlStyle): number {
  const thumb = style.slider.thumbSize ?? 18
  const track = style.slider.trackHeight ?? 6
  return Math.max(thumb, track)
}

export function layoutColorControl(
  spec: ColorControlSpec,
  style: ColorControlStyle,
  metrics: UIKitFontMetrics,
): ColorControlLayout {
  const width = spec.width ?? 220
  const cap = capHeight(metrics) * style.textSizePx
  const labelBaseline = spec.label ? spec.y + cap : null
  const blockTop = spec.label ? spec.y + cap + style.labelGap : spec.y
  const channels: ColorChannel[] = spec.alpha
    ? ['r', 'g', 'b', 'a']
    : ['r', 'g', 'b']
  const rowH = channelRowHeight(style)
  const letterW = measureWidth(metrics, 'W', style.textSizePx)
  const slidersX = spec.x + style.previewSize + style.gap + letterW + style.gap
  const sliderW = Math.max(0, spec.x + width - slidersX)
  const rows = channels.map((channel, i) => {
    const top = blockTop + i * (rowH + style.channelGap)
    return {
      channel,
      letterX: spec.x + style.previewSize + style.gap,
      baseline: top + rowH / 2 + cap / 2,
      slider: { x: slidersX, y: top, width: sliderW, height: rowH },
    }
  })
  const blockH = Math.max(
    style.previewSize,
    channels.length * rowH + (channels.length - 1) * style.channelGap,
  )
  const preview = {
    x: spec.x,
    y: blockTop,
    width: style.previewSize,
    height: style.previewSize,
  }
  const swatches: UIKitBox[] = []
  let bottom = blockTop + blockH
  if (spec.palette && spec.palette.length > 0) {
    let sx = spec.x
    let sy = blockTop + blockH + style.paletteGap
    for (let i = 0; i < spec.palette.length; i++) {
      if (i > 0 && sx + style.swatchSize > spec.x + width) {
        sx = spec.x
        sy += style.swatchSize + style.swatchGap
      }
      swatches.push({
        x: sx,
        y: sy,
        width: style.swatchSize,
        height: style.swatchSize,
      })
      sx += style.swatchSize + style.swatchGap
    }
    bottom = sy + style.swatchSize
  }
  return {
    x: spec.x,
    y: spec.y,
    width,
    height: Math.ceil(bottom - spec.y),
    labelBaseline,
    preview,
    channels: rows,
    swatches,
  }
}

/** Scale every length in a spec and style by `k` (CSS pixels to canvas pixels). */
export function scaleColorControl(
  spec: ColorControlSpec,
  style: ColorControlStyle,
  k: number,
): { spec: ColorControlSpec; style: ColorControlStyle } {
  if (k === 1) return { spec, style }
  const slider = { ...style.slider }
  for (const key of [
    'thumbSize',
    'trackHeight',
    'trackRadius',
    'thumbBorderWidth',
  ] as const) {
    const v = slider[key]
    if (v !== undefined) slider[key] = v * k
  }
  return {
    spec: {
      ...spec,
      x: spec.x * k,
      y: spec.y * k,
      width: spec.width === undefined ? undefined : spec.width * k,
    },
    style: {
      ...style,
      textSizePx: style.textSizePx * k,
      textOutlineWidth: style.textOutlineWidth * k,
      labelGap: style.labelGap * k,
      previewSize: style.previewSize * k,
      previewRadius: style.previewRadius * k,
      previewBorderWidth: style.previewBorderWidth * k,
      gap: style.gap * k,
      channelGap: style.channelGap * k,
      slider,
      swatchSize: style.swatchSize * k,
      swatchGap: style.swatchGap * k,
      swatchRadius: style.swatchRadius * k,
      swatchBorderWidth: style.swatchBorderWidth * k,
      selectedRingWidth: style.selectedRingWidth * k,
      paletteGap: style.paletteGap * k,
    },
  }
}

function inBox(b: UIKitBox, px: number, py: number): boolean {
  return px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height
}

/** The index of the swatch under canvas point (px, py), or -1. */
export function colorSwatchAt(
  layout: ColorControlLayout,
  px: number,
  py: number,
): number {
  return layout.swatches.findIndex((b) => inBox(b, px, py))
}

/** True when canvas point (px, py) lies inside the whole control. */
export function colorControlContains(
  layout: ColorControlLayout,
  px: number,
  py: number,
): boolean {
  return inBox(layout, px, py)
}

/** Black or white, whichever contrasts more with `color`. */
function contrastOutline(color: RGBA): RGBA {
  const lum = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]
  return lum > 0.5 ? [0, 0, 0, 0.9] : [1, 1, 1, 0.9]
}

/**
 * The draw data for a color control: the label, the preview over its
 * backdrop, the channel letters and the palette swatches with the selected
 * and hovered rings. The sliders are a slider overlay's.
 */
export function buildColorControl(
  spec: ColorControlSpec,
  style: ColorControlStyle,
  layout: ColorControlLayout,
  visual: ColorControlVisual,
): { rects: RectData[]; text: UIKitTextItem[] } {
  const rects: RectData[] = []
  const text: UIKitTextItem[] = []
  const textColor = visual.enabled ? style.textColor : style.disabledTextColor
  const outline =
    style.textOutlineWidth > 0
      ? {
          outlineWidthPx: style.textOutlineWidth,
          outlineColor: style.textOutlineColor ?? contrastOutline(textColor),
        }
      : {}
  if (spec.label && layout.labelBaseline !== null) {
    text.push({
      str: spec.label,
      x: layout.x,
      y: layout.labelBaseline,
      sizePx: style.textSizePx,
      align: 0,
      color: textColor,
      ...outline,
    })
  }
  const dim = visual.enabled ? 1 : 0.5
  const shown: RGBA = [
    visual.value[0],
    visual.value[1],
    visual.value[2],
    visual.value[3] * dim,
  ]
  rects.push(
    buildRect({
      ...layout.preview,
      radius: style.previewRadius,
      fill: style.previewBackdrop,
    }),
    buildRect({
      ...layout.preview,
      radius: style.previewRadius,
      borderWidth: style.previewBorderWidth,
      fill: shown,
      border: style.previewBorder,
    }),
  )
  for (const row of layout.channels) {
    text.push({
      str: row.channel.toUpperCase(),
      x: row.letterX,
      y: row.baseline,
      sizePx: style.textSizePx,
      align: 0,
      color: textColor,
      ...outline,
    })
  }
  const selected = selectedSwatch(spec.palette, visual.value)
  layout.swatches.forEach((box, i) => {
    const color = spec.palette?.[i].color ?? [0, 0, 0, 0]
    if (i === selected || (i === visual.hoverSwatch && visual.enabled)) {
      rects.push(
        buildFocusRing(
          box,
          style.swatchRadius,
          i === selected ? style.selectedRing : style.hoverRing,
          style.selectedRingWidth,
          2,
        ),
      )
    }
    rects.push(
      buildRect({
        ...box,
        radius: style.swatchRadius,
        borderWidth: style.swatchBorderWidth,
        fill: [color[0], color[1], color[2], color[3] * dim],
        border: style.swatchBorder,
      }),
    )
  })
  return { rects, text }
}
