import { expect, mock, test } from 'bun:test'
import * as React from 'react'

const effects: Array<() => undefined | (() => void)> = []
let renders = 0
mock.module('react', () => ({
  ...React,
  useEffect: (fn: () => undefined | (() => void)) => {
    effects.push(fn)
  },
  useReducer: () => [0, () => renders++],
}))
const { DynamicVolumePanel } = await import('./dynamicPanel')

test('a new active pane rereads the series it controls', async () => {
  let changed = () => {}
  const viewportGridService = {
    getActiveViewportId: () => undefined,
    EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'active' },
    subscribe: (event: string, cb: () => void) => {
      if (event === 'active') changed = cb
      return { unsubscribe: () => {} }
    },
  }
  DynamicVolumePanel({
    servicesManager: { services: { viewportGridService } },
  } as never)
  const cleanups = effects.splice(0).map((f) => f())
  changed()
  await new Promise((r) => setTimeout(r, 0))
  expect(renders).toBe(1)
  for (const c of cleanups) c?.()
})
