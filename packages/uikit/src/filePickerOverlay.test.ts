import { describe, expect, it } from 'bun:test'
import { UIKitFilePickerOverlay } from './filePickerOverlay'
import type { FilePickerOptions } from './host'
import type { UIKitFont, UIKitFontMetrics } from './text/font'

// Pointer tracking and the bridge round trip never touch the GPU, so the
// overlay is exercised headlessly with a stub font and a stub chooser.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map(CHARS.map((ch) => [ch, GLYPH])),
}
const FONT: UIKitFont = { metrics: METRICS, image: {} as ImageBitmap }

// Picker 'f' at (10,20): button 140 x 28, so its centre is (80, 34).
const BUTTON = { x: 80, y: 34 }

function make(result: () => Promise<File[]>) {
  const log: string[] = []
  const asked: FilePickerOptions[] = []
  let redraws = 0
  const overlay = new UIKitFilePickerOverlay(FONT, {
    requestRedraw: () => redraws++,
    pickFiles: (options) => {
      asked.push(options)
      return result()
    },
  })
  overlay.addFilePicker({
    id: 'f',
    x: 10,
    y: 20,
    accept: '.nii',
    multiple: true,
    onPick: (files, id) => log.push(`${id}:pick:${files.map((f) => f.name)}`),
    onCancel: (id) => log.push(`${id}:cancel`),
  })
  const press = (x: number, y: number) => {
    overlay.pointerDown(x, y)
    overlay.pointerUp(x, y)
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return {
    overlay,
    log,
    asked,
    press,
    settle,
    redraws: () => redraws,
  }
}

describe('UIKitFilePickerOverlay', () => {
  it('lays out the button and hits only it', () => {
    const { overlay } = make(() => Promise.resolve([]))
    expect(overlay.getLayout('f')?.button).toEqual({
      x: 10,
      y: 20,
      width: 140,
      height: 28,
    })
    expect(overlay.hitTest(BUTTON.x, BUTTON.y)).toBe(true)
    expect(overlay.hitTest(200, BUTTON.y)).toBe(false)
    expect(overlay.getFiles('f')).toEqual([])
  })

  it('asks the bridge with the spec options on a click and reports the pick', async () => {
    const files = [new File(['a'], 'a.nii'), new File(['b'], 'b.nii')]
    const { overlay, log, asked, press, settle } = make(() =>
      Promise.resolve(files),
    )
    press(BUTTON.x, BUTTON.y)
    expect(asked).toEqual([
      { accept: '.nii', multiple: true, directory: undefined },
    ])
    expect(overlay.isPending('f')).toBe(true)
    await settle()
    expect(overlay.isPending('f')).toBe(false)
    expect(log).toEqual(['f:pick:a.nii,b.nii'])
    expect(overlay.getFiles('f')).toEqual(['a.nii', 'b.nii'])
  })

  it('reports a cancel and keeps the previous choice', async () => {
    const { overlay, log, press, settle } = make(() => Promise.resolve([]))
    overlay.setFiles('f', ['old.nii'])
    press(BUTTON.x, BUTTON.y)
    await settle()
    expect(log).toEqual(['f:cancel'])
    expect(overlay.getFiles('f')).toEqual(['old.nii'])
  })

  it('treats a rejected bridge as a cancel and opens once while pending', async () => {
    let calls = 0
    const { overlay, log, asked, press, settle } = make(() => {
      calls++
      return Promise.reject(new Error('no chooser'))
    })
    press(BUTTON.x, BUTTON.y)
    press(BUTTON.x, BUTTON.y)
    expect(asked).toHaveLength(1)
    await settle()
    expect(calls).toBe(1)
    expect(log).toEqual(['f:cancel'])
    expect(overlay.isPending('f')).toBe(false)
  })

  it('opens from the keyboard after a press and from open(), not when disabled', async () => {
    const { overlay, asked, press, settle } = make(() => Promise.resolve([]))
    press(BUTTON.x, BUTTON.y)
    await settle()
    overlay.keyDown({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    })
    await settle()
    overlay.open('f')
    await settle()
    expect(asked).toHaveLength(3)
    overlay.setEnabled('f', false)
    overlay.open('f')
    press(BUTTON.x, BUTTON.y)
    expect(asked).toHaveLength(3)
    expect(overlay.hitTest(BUTTON.x, BUTTON.y)).toBe(false)
  })

  it('drops a pick that lands after the picker was removed', async () => {
    let resolve: (files: File[]) => void = () => {}
    const { overlay, log, press } = make(
      () => new Promise<File[]>((r) => (resolve = r)),
    )
    press(BUTTON.x, BUTTON.y)
    overlay.removeFilePicker('f')
    resolve([new File(['a'], 'a.nii')])
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toEqual([])
    expect(overlay.ids).toEqual([])
  })
})
