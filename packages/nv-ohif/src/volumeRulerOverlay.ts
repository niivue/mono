import type {
  MeasurementScreenLine,
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from '@niivue/niivue'
import {
  buildRuler,
  type UIKitFont,
  UIKitLineOverlay,
  UIKitTextOverlay,
} from '@niivue/uikit'

// Match the whole-slide ruler.
const RULER_COLOR: readonly [number, number, number, number] = [1, 0.85, 0, 1]
const LABEL_CSS_PX = 22

/**
 * Draws the NiiVue volume measurements as @niivue/uikit rulers through the
 * controller's overlay hook, so the volume ruler looks identical to the
 * whole-slide ruler — an arrowed, graduated baseline with rotated tick numbers
 * (UIKit's text renderer supports glyph rotation; NiiVue's built-in one does
 * not). Reads the measurements' current screen projection from
 * `nv.measurementScreenLines` each frame, so the rulers track pan / zoom / slice
 * changes. The caller hides NiiVue's built-in measurement line by setting
 * `measureLineColor` / `measureTextColor` alpha to 0.
 */
export class VolumeRulerOverlay implements UIKitOverlayRenderer {
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  // Signature of the last-built rulers, so we rebuild the ruler geometry (and
  // re-lay-out its glyphs) only when the projection or dpr actually changes,
  // not on every animation frame while a measurement is on screen.
  private lastSig = ''

  constructor(
    font: UIKitFont,
    private readonly getLines: () => readonly MeasurementScreenLine[],
  ) {
    this.labels = new UIKitTextOverlay(font)
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    const dpr = frame.dpr
    const measurements = this.getLines()
    // Cheap signature of everything the ruler geometry depends on.
    let sig = `${dpr}`
    for (const m of measurements) {
      sig += `|${m.sx},${m.sy},${m.ex},${m.ey},${m.distance}`
    }
    if (sig !== this.lastSig) {
      this.lastSig = sig
      const geoLines = []
      const geoText = []
      // Endpoints from NiiVue are in canvas (device) pixels, the same space the
      // overlay draws in; size the label/line in CSS px scaled by dpr to match.
      for (const m of measurements) {
        const g = buildRuler({
          a: [m.sx, m.sy],
          b: [m.ex, m.ey],
          length: m.distance,
          units: 'mm',
          decimals: m.distance > 99 ? 0 : m.distance > 9 ? 1 : 2,
          sizePx: LABEL_CSS_PX * dpr,
          thickness: 2 * dpr,
          tickLength: 6 * dpr,
          showTicks: true,
          showTickNumbers: true,
          lineColor: RULER_COLOR,
          textColor: RULER_COLOR,
        })
        geoLines.push(...g.lines)
        geoText.push(...g.text)
      }
      this.lines.setLines(geoLines)
      this.labels.setItems(geoText)
    }
    this.lines.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  destroy(): void {
    this.lines.destroy()
    this.labels.destroy()
  }
}
