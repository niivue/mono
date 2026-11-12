// Slide minimap geometry: where the whole-slide thumbnail sits in a canvas
// corner, and the box on it marking the part of the slide the viewport shows.
// Pure: the overlay (slideMinimapOverlay.ts) draws it and routes the pointer.

import type { UIKitBox } from './rect'

export type MinimapCorner =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

/** The NVSlide viewport: slide-px center, CSS px per slide px. */
export interface MinimapViewport {
  centerX: number
  centerY: number
  scale: number
}

export interface SlideMinimapSpec {
  /** Canvas size in backing pixels. */
  width: number
  height: number
  dpr: number
  /** Base (level 0) slide size in slide pixels. */
  slideWidth: number
  slideHeight: number
  viewport: MinimapViewport
  /** Slide y grows upward on screen (NVSlide `displayYAxis: 'up'`). */
  yAxisUp: boolean
  corner: MinimapCorner
  /** Longest side of the thumbnail, CSS px. */
  sizeCss: number
  /** Gap from the canvas edges, CSS px. */
  marginCss: number
  /** Panel border around the thumbnail, CSS px. */
  paddingCss: number
}

export interface SlideMinimapLayout {
  /** Background panel (the thumbnail plus padding), canvas px. */
  panel: UIKitBox
  /** The thumbnail, canvas px. */
  image: UIKitBox
  /** The viewport's footprint on the thumbnail, clipped to it; null when off-slide. */
  view: UIKitBox | null
}

export function layoutSlideMinimap(spec: SlideMinimapSpec): SlideMinimapLayout {
  const { dpr, slideWidth, slideHeight, viewport } = spec
  const fit = (spec.sizeCss * dpr) / Math.max(slideWidth, slideHeight)
  const imgW = slideWidth * fit
  const imgH = slideHeight * fit
  const pad = spec.paddingCss * dpr
  const margin = spec.marginCss * dpr
  const panelW = imgW + 2 * pad
  const panelH = imgH + 2 * pad
  const right = spec.corner.endsWith('right')
  const bottom = spec.corner.startsWith('bottom')
  const panel = {
    x: right ? spec.width - margin - panelW : margin,
    y: bottom ? spec.height - margin - panelH : margin,
    width: panelW,
    height: panelH,
  }
  const image = {
    x: panel.x + pad,
    y: panel.y + pad,
    width: imgW,
    height: imgH,
  }

  const halfW = spec.width / dpr / (2 * viewport.scale)
  const halfH = spec.height / dpr / (2 * viewport.scale)
  // Display rows run down the thumbnail; with y up the slide's top row is at the bottom.
  const topSlideY = spec.yAxisUp
    ? slideHeight - (viewport.centerY + halfH)
    : viewport.centerY - halfH
  const x0 = Math.max(0, viewport.centerX - halfW)
  const x1 = Math.min(slideWidth, viewport.centerX + halfW)
  const y0 = Math.max(0, topSlideY)
  const y1 = Math.min(slideHeight, topSlideY + 2 * halfH)
  const view =
    x1 > x0 && y1 > y0
      ? {
          x: image.x + x0 * fit,
          y: image.y + y0 * fit,
          width: (x1 - x0) * fit,
          height: (y1 - y0) * fit,
        }
      : null
  return { panel, image, view }
}

/** The slide point under canvas point (x, y), clamped onto the slide. */
export function minimapToSlide(
  layout: SlideMinimapLayout,
  spec: Pick<SlideMinimapSpec, 'slideWidth' | 'slideHeight' | 'yAxisUp'>,
  x: number,
  y: number,
): { x: number; y: number } {
  const { image } = layout
  const u = Math.min(1, Math.max(0, (x - image.x) / image.width))
  const v = Math.min(1, Math.max(0, (y - image.y) / image.height))
  return {
    x: u * spec.slideWidth,
    y: (spec.yAxisUp ? 1 - v : v) * spec.slideHeight,
  }
}
