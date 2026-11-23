import { afterAll, beforeAll, expect, test } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { VOLUME_RENDER_MODE } from '@niivue/niivue'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RenderingOptions } from './displayMenu'

// A DOM only for this file; the rest of the suite runs without one.
const win = new Window()
const saved = { window: globalThis.window, document: globalThis.document }
beforeAll(() => {
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
})
afterAll(() => {
  Object.assign(globalThis, saved)
  win.close()
})

function mount() {
  const events = new EventTarget()
  const state = { sampleRate: 1 }
  const nv = {
    volumes: [],
    volumeIllumination: 0,
    volumeRenderMode: VOLUME_RENDER_MODE.CINEMATIC,
    volumeCinematic: { ambient: 3, volumetricDiffuse: 0.5, specular: 1 },
    get volumeSampleRate() {
      return state.sampleRate
    },
    set volumeSampleRate(v: number) {
      state.sampleRate = v
      events.dispatchEvent(
        new CustomEvent('change', {
          detail: { property: 'volumeSampleRate', value: v },
        }),
      )
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  }
  const host = win.document.createElement('div')
  win.document.body.appendChild(host)
  const root = createRoot(host as unknown as HTMLElement)
  const render = () =>
    act(() =>
      root.render(
        <RenderingOptions nv={nv as unknown as NiiVue} redraw={() => {}} />,
      ),
    )
  const input = (label: string) =>
    [...host.getElementsByTagName('input')].find(
      (i) => i.getAttribute('aria-label') === label,
    ) as unknown as HTMLInputElement
  return { nv, render, input, unmount: () => act(() => root.unmount()) }
}

test('quality follows a change made elsewhere; a lowered light can return', async () => {
  const { nv, render, input, unmount } = mount()
  await render()
  await act(async () => {
    nv.volumeSampleRate = 4
  })
  expect(input('Volume rendering quality').value).toBe('4')
  const ambient = () => input('Volume lighting ambient')
  expect(ambient().max).toBe('3')
  nv.volumeCinematic.ambient = 2.9
  await render()
  expect(ambient().max).toBe('3')
  await unmount()
})
