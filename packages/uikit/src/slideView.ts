// Extras for a core `createSlideView`: the minimap (an on-canvas UIKit
// widget), and two DOM panels, the HUD and the channel panel. The panels are
// native form controls, so Tab reaches every one, focus shows, and screen
// readers name them; canvas widgets take focus only by pointer.

import type {
  NVSlide,
  NVSlidePlaneAxes,
  NVSlidePlaneIndex,
  NVSlideScreen,
  SlideView,
  UIKitOverlayFrame,
} from '@niivue/niivue'
import {
  addChannelColormap,
  lookupColorMap,
  slideStatsSummary,
  toStored,
  toValue,
} from '@niivue/niivue'
import { UIKitControls } from './controls'
import {
  type UIKitSlideMinimapOptions,
  UIKitSlideMinimapOverlay,
} from './slideMinimapOverlay'

/**
 * A whole-slide minimap on the view's canvas, following the view's slide.
 * Presses on it never reach the view's gestures. Returns the detach function.
 */
export function attachSlideMinimap(
  view: SlideView,
  options: UIKitSlideMinimapOptions = {},
): () => void {
  const canvas = view.canvas
  let shown: NVSlide | null = null
  let minimap: UIKitSlideMinimapOverlay | null = null
  let lastFrame: UIKitOverlayFrame | null = null
  const controls = new UIKitControls()
  const sync = (): void => {
    const slide = view.slide
    if (slide === shown) return
    if (minimap) {
      controls.remove(minimap)
      minimap.destroy()
    }
    minimap = slide ? new UIKitSlideMinimapOverlay(slide, options) : null
    if (minimap) controls.add(minimap)
    // A minimap hit-tests against its last drawn layout; seed it from the last
    // frame so a press before the next draw still lands on it.
    if (minimap && lastFrame) {
      const { bounds, dpr } = lastFrame
      minimap.layoutFor(bounds.width, bounds.height, dpr)
    }
    shown = slide
  }
  // Before the control layer's listener, so a press between a slide swap and
  // the next frame reaches the new slide's minimap, not the disposed one's.
  canvas.addEventListener('pointerdown', sync, { capture: true })
  const unwire = controls.attach({
    canvas,
    clientToCanvas: (clientX, clientY) => {
      const r = canvas.getBoundingClientRect()
      const x = ((clientX - r.left) * canvas.width) / r.width
      const y = ((clientY - r.top) * canvas.height) / r.height
      return x >= 0 && y >= 0 && x < canvas.width && y < canvas.height
        ? [x, y]
        : null
    },
    drawScene: view.requestRender,
  })
  const removeOverlay = view.addOverlay({
    drawOverlay: (frame) => {
      lastFrame = frame
      sync()
      controls.drawOverlay(frame)
    },
  })
  return () => {
    removeOverlay()
    unwire()
    canvas.removeEventListener('pointerdown', sync, { capture: true })
    // Destroys its widgets, the minimap included.
    controls.destroy()
  }
}

export type SlideHudRows = (
  slide: NVSlide,
  screen: NVSlideScreen,
) => Array<[string, string]>

/**
 * Write the slide's state into `element` (pre-formatted text, one row per
 * line) after every frame while it is not hidden. `rows` defaults to
 * `slideStatsSummary`. Returns the detach function.
 */
export function attachSlideHud(
  view: SlideView,
  element: HTMLElement,
  rows: SlideHudRows = slideStatsSummary,
): () => void {
  return view.addRenderListener((screen) => {
    const slide = view.slide
    if (element.hidden || !slide) return
    element.textContent = rows(slide, screen)
      .map(([key, text]) => `${key.padEnd(10)}${text}`)
      .join('\n')
  })
}

const FOCUS_STYLE = `.nv-slide-channels :focus-visible{outline:2px solid #74d4cf;outline-offset:1px}
.nv-slide-channels .row{display:flex;gap:.4rem;align-items:center}
.nv-slide-channels input[type=number]{width:5.5rem}`

const hexOf = (colormap: string): string => {
  const c = lookupColorMap(colormap)
  const last = (c?.R.length ?? 1) - 1
  const rgb = c ? [c.R[last], c.G[last], c.B[last]] : [255, 255, 255]
  return `#${rgb.map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`
}

// RGB samples have no channels to set (core's isRgbSlide).
const isRgb = (slide: NVSlide): boolean =>
  !slide.manifest.channelInfo &&
  !slide.manifest.levels.some(
    (l) =>
      l.codec === 'raw-gray' ||
      (l.photometric?.startsWith('MONOCHROME') ?? false),
  )

/**
 * Per-channel controls in `container` for the view's slide: visibility,
 * exact colour, window (in data units, through `storedToValue`), which channel
 * a windowing drag sets, and the blend. Native controls: keyboard operable
 * with visible focus. The container is hidden for an RGB slide or none.
 * Returns the detach function.
 */
export function attachSlideChannelPanel(
  view: SlideView,
  container: HTMLElement,
): () => void {
  const style = document.createElement('style')
  style.textContent = FOCUS_STYLE
  const fieldset = document.createElement('fieldset')
  fieldset.className = 'nv-slide-channels'
  container.append(style, fieldset)
  let built: NVSlide | null | undefined
  let sync: (() => void) | null = null

  const build = (slide: NVSlide | null): void => {
    built = slide
    fieldset.replaceChildren()
    sync = null
    container.hidden = !slide || isRgb(slide)
    if (!slide || container.hidden) return
    const legend = document.createElement('legend')
    legend.textContent = 'Channels'
    fieldset.append(legend)
    const group = `nv-wl-${Math.random().toString(36).slice(2)}`
    // A windowing target left from a slide with more channels.
    if (
      view.controller &&
      view.controller.windowChannel >= slide.channels.length
    )
      view.controller.windowChannel = 0
    const syncs: Array<() => void> = []
    slide.channels.forEach((channel, c) => {
      const info = slide.manifest.channelInfo?.[c]
      const map = info?.storedToValue
      const row = document.createElement('div')
      row.className = 'row'
      row.setAttribute('role', 'group')
      row.setAttribute('aria-label', channel.name)
      const visible = Object.assign(document.createElement('input'), {
        type: 'checkbox',
        checked: channel.visible,
      })
      visible.addEventListener('change', () =>
        slide.setChannel(c, { visible: visible.checked }),
      )
      const name = document.createElement('label')
      name.append(visible, ` ${channel.name}`)
      const colour = Object.assign(document.createElement('input'), {
        type: 'color',
        value: hexOf(channel.colormap),
      })
      colour.setAttribute('aria-label', `${channel.name} colour`)
      // On change, not input: each colour registers a colormap.
      colour.addEventListener('change', () => {
        const rgb = [1, 3, 5].map((i) =>
          Number.parseInt(colour.value.slice(i, i + 2), 16),
        ) as [number, number, number]
        slide.setChannel(c, { colormap: addChannelColormap(rgb) })
      })
      const bound = (label: string): HTMLInputElement => {
        const input = Object.assign(document.createElement('input'), {
          type: 'number',
          step: 'any',
        })
        input.setAttribute('aria-label', `${channel.name} ${label}`)
        input.addEventListener('change', () => {
          const lo = Number(min.value)
          const hi = Number(max.value)
          if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi)
            slide.setChannel(c, {
              calMin: toStored(lo, map),
              calMax: toStored(hi, map),
            })
        })
        return input
      }
      const min = bound('window minimum')
      const max = bound('window maximum')
      const target = Object.assign(document.createElement('input'), {
        type: 'radio',
        name: group,
        checked: view.controller?.windowChannel === c,
      })
      target.setAttribute('aria-label', `${channel.name}: windowing drag sets`)
      target.addEventListener('change', () => {
        if (view.controller) view.controller.windowChannel = c
      })
      // Label IDs are never windowed.
      const isLabel = info?.kind === 'label'
      if (isLabel) row.append(name, colour)
      else row.append(name, colour, min, max, target)
      fieldset.append(row)
      // Values follow the slide (a drag, a source window) unless being edited.
      const set = (input: HTMLInputElement, v: string): void => {
        if (document.activeElement !== input && input.value !== v)
          input.value = v
      }
      syncs.push(() => {
        const ch = slide.channels[c]
        if (!ch) return
        visible.checked = ch.visible
        set(colour, hexOf(ch.colormap))
        const fmt = (s: number): string =>
          Number.isFinite(s)
            ? String(Number(toValue(s, map).toPrecision(6)))
            : ''
        if (isLabel) return
        set(min, fmt(ch.calMin))
        set(max, fmt(ch.calMax))
      })
    })
    if (slide.channels.length > 1) {
      const blend = document.createElement('select')
      blend.setAttribute('aria-label', 'Channel blend')
      blend.append(new Option('max', 'max'), new Option('additive', 'additive'))
      blend.value = slide.channelBlend
      blend.addEventListener('change', () =>
        slide.setChannelBlend(blend.value as 'max' | 'additive'),
      )
      // Follows a blend set elsewhere (MCP, a script).
      syncs.push(() => {
        blend.value = slide.channelBlend
      })
      const label = document.createElement('label')
      label.append('Blend ', blend)
      fieldset.append(label)
    }
    sync = () => {
      for (const s of syncs) s()
    }
    sync()
  }

  const remove = view.addRenderListener(() => {
    if (view.slide !== built) build(view.slide)
    else sync?.()
  })
  build(view.slide)
  return () => {
    remove()
    style.remove()
    fieldset.remove()
  }
}

// NVSlide's plane surface per the frozen plane contract (C implements it):
// `planes` absent means a fixed source, one plane.
type PlaneSlide = {
  readonly planes?: NVSlidePlaneAxes
  readonly planeIndex: NVSlidePlaneIndex
  setPlaneIndex(p: NVSlidePlaneIndex): unknown
}

/**
 * Focal-plane (z) and time (t) sliders in `container` for the view's slide,
 * per axis with more than one plane; hidden for a fixed source. A move calls
 * `setPlaneIndex` (async: the old plane shows until the new one is ready; a
 * superseded call changes nothing); a rejection puts the slider back and says
 * why. Native range inputs: arrow keys, visible focus. Returns the detach function.
 */
export function attachSlidePlaneControl(
  view: SlideView,
  container: HTMLElement,
): () => void {
  let builtFor: PlaneSlide | null = null
  let builtKey = ''
  let calls = 0
  // The plane asked for and not yet committed: requests and the sliders build
  // on it, so a t move during a pending z switch keeps the z.
  let wanted: NVSlidePlaneIndex | null = null
  const sliders: Array<{
    axis: 'z' | 't'
    input: HTMLInputElement
    text: () => void
  }> = []
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  const sync = (slide: PlaneSlide): void => {
    const shown = wanted ?? slide.planeIndex
    for (const { axis, input, text } of sliders) {
      input.value = String(shown[axis])
      text()
    }
  }
  const build = (): void => {
    // ponytail: cast until lane C's NVSlide declares `planes`.
    const slide = view.slide as unknown as PlaneSlide | null
    const axes = slide?.planes
    const key =
      slide && axes && (axes.z > 1 || axes.t > 1) ? `${axes.z}x${axes.t}` : ''
    if (slide === builtFor && key === builtKey) {
      if (slide && key) sync(slide)
      return
    }
    builtFor = slide
    builtKey = key
    // A late answer from the slide before is not this one's.
    calls++
    wanted = null
    status.textContent = ''
    sliders.length = 0
    container.replaceChildren()
    container.hidden = !key
    if (!slide || !axes || !key) return
    for (const axis of ['z', 't'] as const) {
      const n = axes[axis]
      if (n <= 1) continue
      const input = Object.assign(document.createElement('input'), {
        type: 'range',
        min: '0',
        max: String(n - 1),
        step: '1',
        value: String(slide.planeIndex[axis]),
      })
      const out = document.createElement('output')
      const text = (): void => {
        const i = Number(input.value)
        const at = axis === 'z' ? axes.zPositionsUm?.[i] : axes.tSeconds?.[i]
        const unit = axis === 'z' ? 'um' : 's'
        out.value = `${i + 1}/${n}${at === undefined ? '' : ` (${at} ${unit})`}`
        input.setAttribute('aria-valuetext', out.value)
      }
      input.addEventListener('input', () => {
        const id = ++calls
        status.textContent = ''
        text()
        const p = {
          ...(wanted ?? slide.planeIndex),
          [axis]: Number(input.value),
        }
        wanted = p
        Promise.resolve()
          .then(() => slide.setPlaneIndex(p))
          .then(
            () => {
              if (id !== calls) return
              wanted = null
              sync(slide)
            },
            (err: unknown) => {
              if (id !== calls) return
              wanted = null
              sync(slide)
              status.textContent = `Plane not shown: ${err instanceof Error ? err.message : String(err)}`
            },
          )
      })
      text()
      const label = document.createElement('label')
      label.append(axis === 'z' ? 'Focal plane ' : 'Time ', input, out)
      container.append(label)
      sliders.push({ axis, input, text })
    }
    container.append(status)
  }
  const remove = view.addRenderListener(build)
  build()
  return () => {
    remove()
    container.replaceChildren()
  }
}
