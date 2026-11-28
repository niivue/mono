import { afterEach, expect, test } from 'bun:test'
import type { SlideView } from '@/index'
import { attachSlideChannelPanel } from './slideView'

// No DOM under bun: just enough element surface for the channel panel.
type El = {
  tag: string
  value: string
  children: El[]
  [k: string]: unknown
}
function el(tag: string): El {
  const e: El = {
    tag,
    value: '',
    children: [],
    hidden: false,
    style: {},
    append: (...c: unknown[]) => {
      for (const x of c) if (typeof x === 'object') e.children.push(x as El)
    },
    replaceChildren: () => {
      e.children.length = 0
    },
    remove: () => {},
    setAttribute: () => {},
    addEventListener: () => {},
  }
  return e
}
const saved = { document: globalThis.document, Option: globalThis.Option }
afterEach(() => Object.assign(globalThis, saved))

const find = (e: El, tag: string): El | undefined =>
  e.tag === tag ? e : e.children.map((c) => find(c, tag)).find(Boolean)

test('the blend select follows a blend set elsewhere', () => {
  Object.assign(globalThis, {
    document: { createElement: el, activeElement: null },
    Option: class {
      constructor(
        public text: string,
        public value: string,
      ) {}
    },
  })
  const channel = {
    name: 'c',
    visible: true,
    colormap: 'gray',
    calMin: 0,
    calMax: 1,
  }
  const slide = {
    manifest: { levels: [], channelInfo: [{}, {}] },
    channels: [channel, { ...channel }],
    channelBlend: 'max',
  }
  let onRender = (): void => {}
  const view = {
    slide,
    controller: null,
    addRenderListener: (fn: () => void) => {
      onRender = fn
      return () => {}
    },
  }
  const container = el('div')
  attachSlideChannelPanel(
    view as unknown as SlideView,
    container as unknown as HTMLElement,
  )
  const blend = find(container, 'select')
  expect(blend?.value).toBe('max')
  slide.channelBlend = 'additive'
  onRender()
  expect(blend?.value).toBe('additive')
})

// An RGB slide's windows are drawn now (NVSlide.rgbWindow), so the panel
// lists red, green and blue, and the drag's default target is all three.
test('an RGB slide shows its three windows and an "all" target', () => {
  Object.assign(globalThis, {
    document: { createElement: el, activeElement: null },
    Option: class {},
  })
  const channel = (name: string) => ({
    name,
    visible: true,
    colormap: 'gray',
    calMin: 0,
    calMax: 255,
  })
  const view = {
    slide: {
      manifest: { levels: [{ codec: 'raw-rgba' }] },
      channels: ['red', 'green', 'blue', 'alpha'].map(channel),
      channelBlend: 'additive',
    },
    controller: { windowChannel: -1 },
    addRenderListener: () => () => {},
  }
  const container = el('div')
  attachSlideChannelPanel(
    view as unknown as SlideView,
    container as unknown as HTMLElement,
  )
  const all = (e: El): El[] => [e, ...e.children.flatMap(all)]
  const radios = all(container).filter((e) => e.type === 'radio')
  expect(container.hidden).toBe(false)
  expect(radios).toHaveLength(4) // all, red, green, blue
  expect(radios.map((r) => r.checked)).toEqual([true, false, false, false])
  expect(find(container, 'select')).toBeUndefined()
})
