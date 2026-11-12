import { afterEach, expect, test } from 'bun:test'
import type { SlideView } from '@niivue/niivue'
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
