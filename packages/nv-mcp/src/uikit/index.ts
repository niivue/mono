/**
 * @niivue/nv-mcp/uikit: a control surface that draws an agent's controls
 * on the NiiVue canvas with the @niivue/uikit widgets.
 *
 * `uikitControls(nv, { font })` makes one widget overlay per kind under a
 * single UIKit control layer, registers the layer as NiiVue's overlay
 * renderer and attaches it to the canvas. Each control an agent adds is
 * drawn by the overlay for its kind; what the person does with it is told
 * to whoever `listen`s, after the control's value is kept current. Wrap
 * it in `bindControls` for the controls to drive what they are bound to.
 *
 * Positions and widths come in canvas pixels, as the control tools give
 * them, and are drawn at CSS-pixel sizes, so a control reads the same on
 * a high-density display as on any other.
 */

import type { UIKitOverlayRenderer } from '@niivue/niivue'
import {
  type ColorSwatch,
  DEFAULT_SEGMENTED_STYLE,
  type FilePickerBridge,
  measureWidth,
  type RGBA,
  UIKitButtonOverlay,
  UIKitColorControlOverlay,
  UIKitControls,
  UIKitDialogOverlay,
  UIKitFilePickerOverlay,
  type UIKitFont,
  type UIKitHost,
  UIKitMenuOverlay,
  UIKitNumberInputOverlay,
  UIKitSegmentedOverlay,
  UIKitSelectOverlay,
  UIKitSliderOverlay,
  UIKitTextAreaOverlay,
  UIKitTextInputOverlay,
  UIKitToggleOverlay,
} from '@niivue/uikit'
import {
  type ControlEvent,
  type ControlListener,
  type ControlSurface,
  memoryControls,
} from '../browser/controls'
import type { ControlOption, ControlState, ControlValue } from '../controls'

/** What the surface needs of NiiVue: a NiiVue instance is one as it is. */
export interface UIKitSurfaceHost extends UIKitHost {
  registerOverlayRenderer(renderer: UIKitOverlayRenderer): () => void
}

export interface UIKitSurfaceOptions {
  /** The font the widgets draw their text in: `loadDefaultFont()` gives one. */
  font: UIKitFont
  /** Hears every change to the controls, with the controls as they are. */
  onChange?(controls: ControlState[]): void
  /** How a file picker asks for files; the browser's own chooser when absent. */
  pickFiles?: FilePickerBridge
}

/** A control surface drawn with UIKit widgets. */
export interface UIKitSurface extends ControlSurface {
  listen(listener: ControlListener): () => void
  onFrame(callback: () => void): () => void
  /** The control layer holding the widgets, for a page that adds its own. */
  readonly layer: UIKitControls
  /** Takes the widgets off the canvas and releases them. */
  destroy(): void
}

/** The width of a slider the agent gave none, in CSS pixels. */
const SLIDER_WIDTH = 200

/**
 * Draws the controls an agent adds on `host`'s canvas with UIKit widgets.
 * See the module comment.
 */
export function uikitControls(
  host: UIKitSurfaceHost,
  options: UIKitSurfaceOptions,
): UIKitSurface {
  const { font } = options
  const memory = memoryControls(
    options.onChange ? { onChange: options.onChange } : {},
  )
  const units = { cssUnits: true }
  const buttons = new UIKitButtonOverlay(font, units)
  const toggles = new UIKitToggleOverlay(font, units)
  const sliders = new UIKitSliderOverlay(font, units)
  const numbers = new UIKitNumberInputOverlay(font, units)
  const texts = new UIKitTextInputOverlay(font, units)
  const areas = new UIKitTextAreaOverlay(font, units)
  const colors = new UIKitColorControlOverlay(font, units)
  const files = new UIKitFilePickerOverlay(font, {
    ...units,
    ...(options.pickFiles ? { pickFiles: options.pickFiles } : {}),
  })
  const segmented = new UIKitSegmentedOverlay(font, units)
  const menus = new UIKitMenuOverlay(font, units)
  const selects = new UIKitSelectOverlay(font, units)
  const dialogs = new UIKitDialogOverlay(font, units)
  // Popups (menus, selects) and dialogs go last, so they draw over the rest.
  const layer = new UIKitControls()
    .add(buttons)
    .add(toggles)
    .add(sliders)
    .add(numbers)
    .add(texts)
    .add(areas)
    .add(colors)
    .add(files)
    .add(segmented)
    .add(menus)
    .add(selects)
    .add(dialogs)

  // The bound values are read before each frame, then the widgets drawn.
  const renderer: UIKitOverlayRenderer = {
    drawOverlay(frame) {
      memory.frame()
      layer.drawOverlay(frame)
    },
  }
  const unregister = host.registerOverlayRenderer(renderer)
  const detach = layer.attach(host)

  /** Canvas pixels to CSS pixels, by how the canvas is sized now. */
  const css = (n: number) => {
    const canvas = host.canvas
    const ratio =
      canvas && canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
    return n / ratio
  }
  const find = (id: string) => memory.list().find((c) => c.id === id)

  /** What the person did, kept on the control and told to the listeners. */
  const person = (event: ControlEvent) => {
    if (!find(event.id)) return
    memory.simulate(event)
  }

  /** A menu item checked or unchecked, kept on the control's options. */
  const checked = (id: string, item: string, on: boolean) => {
    const control = find(id)
    if (!control?.options) return
    memory.update(id, {
      options: control.options.map((o) =>
        o.id === item ? { ...o, checked: on } : o,
      ),
    })
  }

  /** Makes the widget for `c`, or remakes the one there. */
  const draw = (c: ControlState) => {
    const { id, label, enabled } = c
    const x = css(c.x)
    const y = css(c.y)
    const width = c.width === undefined ? undefined : css(c.width)
    const sized = width === undefined ? {} : { width }
    switch (c.kind) {
      case 'button':
        buttons.addButton({
          id,
          label: label ?? id,
          x,
          y,
          ...sized,
          enabled,
          onClick: () => person({ id, type: 'press' }),
        })
        return
      case 'toggle':
        toggles.addToggle({
          id,
          label: label ?? id,
          x,
          y,
          checked: c.value === true,
          enabled,
          onChange: (on) => person({ id, type: 'change', value: on }),
        })
        return
      case 'slider': {
        const min = c.min ?? 0
        const max = c.max ?? Math.max(min + 1, 100)
        sliders.addSlider({
          id,
          label,
          x,
          y,
          width: width ?? SLIDER_WIDTH,
          min,
          max,
          step: c.step,
          value: Number(c.value),
          showValue: true,
          enabled,
          onInput: (v) => person({ id, type: 'input', value: v }),
          onChange: (v) => person({ id, type: 'change', value: v }),
        })
        return
      }
      case 'number':
        numbers.addNumberInput({
          id,
          label,
          x,
          y,
          ...sized,
          min: c.min,
          max: c.max,
          step: c.step,
          value: Number(c.value),
          enabled,
          onInput: (v) => person({ id, type: 'input', value: v }),
          onChange: (v) => person({ id, type: 'change', value: v }),
        })
        return
      case 'text':
      case 'textarea': {
        const spec = {
          id,
          label,
          x,
          y,
          ...sized,
          value: typeof c.value === 'string' ? c.value : '',
          placeholder: c.placeholder,
          maxLength: c.maxLength,
          enabled,
          onInput: (t: string) => person({ id, type: 'input', value: t }),
          onChange: (t: string) => person({ id, type: 'change', value: t }),
        }
        if (c.kind === 'text') texts.addTextInput(spec)
        else areas.addTextArea({ ...spec, rows: c.rows })
        return
      }
      case 'select':
        selects.addSelect({
          id,
          x,
          y,
          ...sized,
          options: (c.options ?? []).map(choice),
          value: chosen(c.value),
          placeholder: c.placeholder,
          enabled,
          onChange: (v) => person({ id, type: 'change', value: v }),
        })
        return
      case 'segmented': {
        const segments = (c.options ?? []).map(choice)
        segmented.addSegmented({
          id,
          x,
          y,
          segments,
          value: chosen(c.value),
          ...(width === undefined || segments.length === 0
            ? {}
            : {
                segmentWidth: Math.max(
                  width / segments.length,
                  fitted(segments),
                ),
              }),
          enabled,
          onChange: (v) => person({ id, type: 'change', value: v }),
        })
        return
      }
      case 'menu':
        menus.addMenu({
          id,
          label: label ?? id,
          x,
          y,
          ...sized,
          items: (c.options ?? []).map((o) => ({
            id: o.id,
            label: o.label,
            kind: o.group
              ? 'radio'
              : o.checked === undefined
                ? 'action'
                : 'check',
            ...(o.checked === undefined ? {} : { checked: o.checked }),
            ...(o.group ? { group: o.group } : {}),
            ...(o.enabled === undefined ? {} : { enabled: o.enabled }),
          })),
          enabled,
          onChange: (item, on) => checked(id, item, on),
          onSelect: (item) => person({ id, type: 'press', item }),
        })
        return
      case 'color':
        colors.addColorControl({
          id,
          label,
          x,
          y,
          ...sized,
          value: rgba(c.value),
          alpha: c.alpha ?? false,
          ...(c.palette ? { palette: swatches(c.palette) } : {}),
          enabled,
          onInput: (v) => person({ id, type: 'input', value: [...v] }),
          onChange: (v) => person({ id, type: 'change', value: [...v] }),
        })
        return
      case 'file':
        files.addFilePicker({
          id,
          label,
          x,
          y,
          ...sized,
          placeholder: c.placeholder,
          accept: c.accept,
          multiple: c.multiple,
          enabled,
          onPick: (picked) => person({ id, type: 'press', files: picked }),
        })
        return
      case 'dialog': {
        const given: ControlOption[] = c.options?.length
          ? c.options
          : [{ id: 'ok', label: 'OK' }]
        dialogs.addDialog({
          id,
          title: label,
          message: c.message,
          x,
          y,
          ...sized,
          buttons: given.map((o) => ({
            id: o.id,
            label: o.label,
            ...(o.enabled === undefined ? {} : { enabled: o.enabled }),
          })),
          onClose: (result) => person({ id, type: 'press', item: result }),
        })
        // A dialog shows when it is added, and again whenever it is changed.
        dialogs.open(id)
        return
      }
    }
  }

  /** The width a segment needs for the widest label, as UIKit sizes one. */
  const fitted = (segments: readonly { label: string }[]) => {
    const style = DEFAULT_SEGMENTED_STYLE
    let widest = 0
    for (const s of segments) {
      widest = Math.max(
        widest,
        measureWidth(font.metrics, s.label, style.textSizePx),
      )
    }
    return Math.ceil(widest + 2 * style.paddingX)
  }

  /** Shows a new value on the widget there, keeping its focus and caret. */
  const show = (c: ControlState) => {
    switch (c.kind) {
      case 'toggle':
        toggles.setChecked(c.id, c.value === true)
        return
      case 'slider':
        sliders.setValue(c.id, Number(c.value))
        return
      case 'number':
        numbers.setValue(c.id, Number(c.value))
        return
      case 'text':
        texts.setValue(c.id, typeof c.value === 'string' ? c.value : '')
        return
      case 'textarea':
        areas.setValue(c.id, typeof c.value === 'string' ? c.value : '')
        return
      case 'select':
        selects.setValue(c.id, chosen(c.value))
        return
      case 'segmented':
        segmented.setValue(c.id, chosen(c.value))
        return
      case 'color':
        colors.setValue(c.id, rgba(c.value))
        return
      default:
        draw(c)
    }
  }

  /** Takes the widget for `c` away. */
  const erase = (c: ControlState) => {
    const removers: Record<ControlState['kind'], (id: string) => void> = {
      button: (id) => buttons.removeButton(id),
      toggle: (id) => toggles.removeToggle(id),
      slider: (id) => sliders.removeSlider(id),
      number: (id) => numbers.removeNumberInput(id),
      text: (id) => texts.removeTextInput(id),
      textarea: (id) => areas.removeTextArea(id),
      select: (id) => selects.removeSelect(id),
      segmented: (id) => segmented.removeSegmented(id),
      menu: (id) => menus.removeMenu(id),
      color: (id) => colors.removeColorControl(id),
      file: (id) => files.removeFilePicker(id),
      dialog: (id) => dialogs.removeDialog(id),
    }
    removers[c.kind](c.id)
  }

  const redraw = () => host.drawScene()

  return {
    layer,
    add(spec) {
      const control = memory.add(spec)
      try {
        draw(control)
      } catch (error) {
        memory.remove(control.id)
        throw error
      }
      redraw()
      return control
    },
    update(id, patch) {
      const was = find(id)
      const control = memory.update(id, patch)
      const onlyValue = Object.keys(patch).every((key) => key === 'value')
      // A move or a change of kind-specific fields remakes the widget; a
      // new value alone is set on the one there.
      if (onlyValue) show(control)
      else {
        if (was && was.kind !== control.kind) erase(was)
        draw(control)
      }
      redraw()
      return control
    },
    remove(id) {
      const control = find(id)
      memory.remove(id)
      if (control) {
        erase(control)
        redraw()
      }
    },
    clear() {
      for (const control of memory.list()) erase(control)
      memory.clear()
      redraw()
    },
    list: () => memory.list(),
    listen: (listener) => memory.listen(listener),
    onFrame: (callback) => memory.onFrame(callback),
    destroy() {
      detach()
      unregister()
      layer.destroy()
    },
  }
}

/** A select or segmented entry from a control option. */
function choice(o: ControlOption): {
  value: string
  label: string
  enabled?: boolean
} {
  return {
    value: o.id,
    label: o.label,
    ...(o.enabled === undefined ? {} : { enabled: o.enabled }),
  }
}

/** A select's or segmented row's value, null for none chosen. */
function chosen(value: ControlValue): string | null {
  return typeof value === 'string' && value ? value : null
}

/** A control's colour as the four channels UIKit draws. */
function rgba(value: ControlValue): RGBA {
  const v = Array.isArray(value) ? value : [1, 1, 1]
  return [v[0] ?? 1, v[1] ?? 1, v[2] ?? 1, v[3] ?? 1]
}

/** Palette swatches from CSS colours; one the browser cannot read is left out. */
function swatches(palette: readonly string[]): ColorSwatch[] {
  const out: ColorSwatch[] = []
  for (const name of palette) {
    const color = cssColor(name)
    if (color) out.push({ name, color })
  }
  return out
}

let probe: CanvasRenderingContext2D | null | undefined

/** A CSS colour as four channels 0 to 1, by painting a pixel with it. */
export function cssColor(text: string): RGBA | undefined {
  if (probe === undefined) {
    probe =
      typeof document === 'undefined'
        ? null
        : document
            .createElement('canvas')
            .getContext('2d', { willReadFrequently: true })
  }
  if (!probe) return undefined
  // A colour the browser cannot read leaves fillStyle as it was, so it
  // is tried over two starting colours: a real one gives the same either way.
  probe.fillStyle = '#000000'
  probe.fillStyle = text
  const overBlack = probe.fillStyle
  probe.fillStyle = '#ffffff'
  probe.fillStyle = text
  if (probe.fillStyle !== overBlack) return undefined
  probe.clearRect(0, 0, 1, 1)
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
  return [r / 255, g / 255, b / 255, a / 255]
}
