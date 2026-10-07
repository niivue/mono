import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { UIKitOverlayRenderer } from '@niivue/niivue'
import {
  UIKitButtonOverlay,
  UIKitDialogOverlay,
  type UIKitFont,
  UIKitMenuOverlay,
  UIKitSegmentedOverlay,
  UIKitSliderOverlay,
  UIKitToggleOverlay,
} from '@niivue/uikit'
import type { ControlEvent } from '../browser/controls'
import { uikitControls } from './index'

// The widgets track values and take presses without the GPU, so the surface
// is exercised headlessly: a stub font (the atlas image is never read), a
// fake canvas and window, and no frame ever drawn.
const FONT: UIKitFont = {
  metrics: {
    distanceRange: 2,
    size: 50,
    textureSize: [64, 64],
    glyphs: new Map([
      ['H', { plane: [0.05, 0, 0.4, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
    ]),
  },
  image: {} as ImageBitmap,
}

function fakeCanvas() {
  const canvas = new EventTarget() as EventTarget & {
    style: { cursor: string }
    width: number
    clientWidth: number
    setPointerCapture(id: number): void
  }
  canvas.style = { cursor: '' }
  // Twice as many canvas pixels as CSS pixels: a DPR-2 display.
  canvas.width = 200
  canvas.clientWidth = 100
  canvas.setPointerCapture = () => {}
  return canvas
}

function setup() {
  const unregister = mock(() => {})
  const renderers: UIKitOverlayRenderer[] = []
  let scenes = 0
  const host = {
    canvas: fakeCanvas() as unknown as HTMLCanvasElement,
    clientToCanvas: (x: number, y: number): [number, number] => [x * 2, y * 2],
    drawScene: () => {
      scenes++
    },
    registerOverlayRenderer: (r: UIKitOverlayRenderer) => {
      renderers.push(r)
      return unregister
    },
  }
  const changes: number[] = []
  const surface = uikitControls(host, {
    font: FONT,
    onChange: (controls) => changes.push(controls.length),
  })
  const events: ControlEvent[] = []
  surface.listen((e) => events.push(e))
  const overlay = <T>(type: new (...args: never[]) => T): T => {
    const found = surface.layer.widgets.find((w) => w instanceof type)
    if (!found) throw new Error(`no ${type.name} in the layer`)
    return found as T
  }
  return {
    surface,
    renderers,
    unregister,
    events,
    changes,
    scenes: () => scenes,
    overlay,
  }
}

describe('uikitControls', () => {
  const g = globalThis as { window?: EventTarget }
  let savedWindow: EventTarget | undefined
  beforeEach(() => {
    savedWindow = g.window
    g.window = new EventTarget()
  })
  afterEach(() => {
    g.window = savedWindow
  })

  it('registers one renderer and places controls in CSS pixels', () => {
    const { surface, renderers, overlay, scenes } = setup()
    expect(renderers).toHaveLength(1)
    surface.add({
      id: 's',
      kind: 'slider',
      x: 100,
      y: 60,
      min: 0,
      max: 10,
      value: 4,
    })
    const layout = overlay(UIKitSliderOverlay).getLayout('s')
    expect(layout?.x).toBe(50)
    expect(layout?.y).toBe(30)
    expect(layout?.width).toBe(200)
    expect(scenes()).toBeGreaterThan(0)
  })

  it('tells listeners what the person did and keeps the value', () => {
    const { surface, overlay, events, changes } = setup()
    surface.add({ id: 't', kind: 'toggle', x: 0, y: 0, value: false })
    surface.add({ id: 'b', kind: 'button', x: 0, y: 40 })
    overlay(UIKitToggleOverlay).toggle('t')
    overlay(UIKitButtonOverlay).click('b')
    expect(events).toEqual([
      { id: 't', type: 'change', value: true },
      { id: 'b', type: 'press' },
    ])
    expect(surface.list().find((c) => c.id === 't')?.value).toBe(true)
    expect(changes.length).toBeGreaterThan(2)
  })

  it('sets a new value on the widget there, and remakes it for anything else', () => {
    const { surface, overlay } = setup()
    surface.add({
      id: 's',
      kind: 'slider',
      x: 0,
      y: 0,
      min: 0,
      max: 10,
      value: 1,
    })
    const sliders = overlay(UIKitSliderOverlay)
    surface.update('s', { value: 7 })
    expect(sliders.getValue('s')).toBe(7)
    surface.update('s', { x: 40 })
    expect(sliders.getLayout('s')?.x).toBe(20)
    expect(sliders.getValue('s')).toBe(7)
  })

  it('maps menu options to items and keeps checks on the control', () => {
    const { surface, overlay, events } = setup()
    surface.add({
      id: 'm',
      kind: 'menu',
      x: 0,
      y: 0,
      options: [
        { id: 'reset', label: 'Reset' },
        { id: 'cross', label: 'Crosshair', checked: true },
        { id: 'ax', label: 'Axial', group: 'view', checked: false },
      ],
    })
    const menus = overlay(UIKitMenuOverlay)
    expect(menus.getItems('m').map((i) => i.kind)).toEqual([
      'action',
      'check',
      'radio',
    ])
    expect(menus.getItems('m')[1]?.checked).toBe(true)
    // Choosing the check item from the keyboard unchecks it on the control
    // and reaches the listeners as a press naming the item.
    menus.open('m', 1)
    menus.keyDown({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    })
    const options = surface.list().find((c) => c.id === 'm')?.options
    expect(options?.[1]?.checked).toBe(false)
    expect(events).toEqual([{ id: 'm', type: 'press', item: 'cross' }])
  })

  it('opens a dialog when added and reports the button that closed it', () => {
    const { surface, overlay, events } = setup()
    surface.add({ id: 'd', kind: 'dialog', label: 'Done', x: 0, y: 0 })
    const dialogs = overlay(UIKitDialogOverlay)
    expect(dialogs.isOpen('d')).toBe(true)
    dialogs.close('ok')
    expect(events).toEqual([{ id: 'd', type: 'press', item: 'ok' }])
    expect(surface.list()[0].open).toBe(false)
    // A change leaves a closed dialog closed; open: true shows it again.
    surface.update('d', { message: 'Again' })
    expect(dialogs.isOpen('d')).toBe(false)
    surface.update('d', { open: true })
    expect(dialogs.isOpen('d')).toBe(true)
  })

  it('adds a dialog hidden, and hides or removes one without a press', () => {
    const { surface, overlay, events } = setup()
    surface.add({ id: 'd', kind: 'dialog', x: 0, y: 0, open: false })
    const dialogs = overlay(UIKitDialogOverlay)
    expect(dialogs.ids).toEqual(['d'])
    expect(dialogs.isOpen('d')).toBe(false)
    surface.update('d', { open: true })
    expect(dialogs.isOpen('d')).toBe(true)
    surface.update('d', { open: false })
    expect(dialogs.isOpen('d')).toBe(false)
    surface.update('d', { open: true })
    surface.clear()
    expect(events).toEqual([])
  })

  it('remakes a control under a new kind and takes it away on remove', () => {
    const { surface, overlay } = setup()
    surface.add({ id: 'c', kind: 'toggle', x: 0, y: 0 })
    surface.remove('c')
    expect(overlay(UIKitToggleOverlay).ids).toEqual([])
    surface.add({ id: 'c', kind: 'slider', x: 0, y: 0 })
    surface.add({ id: 'e', kind: 'button', x: 0, y: 30 })
    surface.clear()
    expect(overlay(UIKitSliderOverlay).getLayout('c')).toBeNull()
    expect(overlay(UIKitButtonOverlay).ids).toEqual([])
    expect(surface.list()).toEqual([])
  })

  it('ignores a widget event for a control already gone', () => {
    const { surface, overlay, events } = setup()
    surface.add({ id: 'b', kind: 'button', x: 0, y: 0 })
    const buttons = overlay(UIKitButtonOverlay)
    surface.remove('b')
    buttons.click('b')
    expect(events).toEqual([])
  })

  it('never makes a segment narrower than its widest label', () => {
    const { surface, overlay } = setup()
    surface.add({
      id: 'v',
      kind: 'segmented',
      x: 0,
      y: 0,
      width: 4,
      options: [
        { id: 'a', label: 'HHHH' },
        { id: 'b', label: 'Hi' },
      ],
    })
    const layout = overlay(UIKitSegmentedOverlay).getLayout('v')
    expect(layout?.width).toBeGreaterThan(2 * 2 * 12)
  })

  it('lays the grid out by the widgets in it, and reports boxes in canvas pixels', () => {
    const { surface, overlay } = setup()
    surface.add({ id: 's', kind: 'slider', row: 0, col: 0, value: 1 })
    surface.add({ id: 'b', kind: 'button', label: 'Go', row: 1, col: 0 })
    surface.add({ id: 't', kind: 'toggle', label: 'On', row: 0, col: 1 })
    const sliders = overlay(UIKitSliderOverlay)
    const slider = sliders.getLayout('s')
    const button = overlay(UIKitButtonOverlay).getLayout('b')
    const toggle = overlay(UIKitToggleOverlay).getLayout('t')
    if (!slider || !button || !toggle) throw new Error('not drawn')
    expect(slider).toMatchObject({ x: 12, y: 12 })
    expect(button.x).toBe(12)
    expect(button.y).toBeGreaterThanOrEqual(slider.y + slider.height)
    expect(toggle.y).toBe(12)
    expect(toggle.x).toBeGreaterThanOrEqual(slider.x + slider.width)
    // The box is in canvas pixels: twice the CSS layout on this display.
    const listed = surface.list().find((c) => c.id === 'b')
    expect(listed?.box).toEqual({
      x: button.x * 2,
      y: Math.round(button.y * 2),
      width: Math.round(button.width * 2),
      height: Math.round(button.height * 2),
    })
    // Taking the slider away moves the button up, and widens nothing.
    surface.remove('s')
    expect(overlay(UIKitButtonOverlay).getLayout('b')?.y).toBe(
      slider.y + toggle.height + 8,
    )
    // A wider slider in the first column moves the second column out.
    surface.add({ id: 'w', kind: 'slider', row: 2, col: 0, width: 600 })
    expect(overlay(UIKitToggleOverlay).getLayout('t')?.x).toBe(12 + 300 + 8)
  })

  it('keeps a control placed at a point out of the grid', () => {
    const { surface, overlay } = setup()
    surface.add({ id: 'p', kind: 'button', x: 100, y: 100 })
    surface.add({ id: 'g', kind: 'button', row: 0, col: 0, width: 400 })
    expect(overlay(UIKitButtonOverlay).getLayout('p')).toMatchObject({
      x: 50,
      y: 50,
    })
    surface.update('p', { row: 0, col: 1 })
    expect(overlay(UIKitButtonOverlay).getLayout('p')).toMatchObject({
      x: 12 + 200 + 8,
      y: 12,
    })
  })

  it('unregisters its renderer when destroyed', () => {
    const { surface, unregister } = setup()
    surface.destroy()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
