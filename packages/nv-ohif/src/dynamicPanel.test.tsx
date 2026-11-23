import { expect, test } from 'bun:test'
import { mockReactHooks } from './mockReact'

const effects: Array<() => undefined | (() => void)> = []
let renders = 0
mockReactHooks({
  useEffect: (fn: () => undefined | (() => void)) => {
    effects.push(fn)
  },
  useReducer: () => [0, () => renders++],
  // A range left over from a longer series.
  useState: () => [[2, 5], () => {}],
})
const { DynamicVolumePanel } = await import('./dynamicPanel')
const { joinFrames } = await import('./frames4D')

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

type Node = { props?: { children?: unknown; onClick?: () => void } }
const buttons = (n: unknown): Array<() => void> => {
  if (Array.isArray(n)) return n.flatMap(buttons)
  const props = (n as Node)?.props
  if (!props) return []
  return [...(props.onClick ? [props.onClick] : []), ...buttons(props.children)]
}

test('a range from a longer series clamps to the shown one', () => {
  const frameSource = { group: {}, count: 3, frame: 0 }
  const nv = {
    volumes: [{ frameSource }],
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const leave = joinFrames('short', nv as never, undefined, null)
  const runs: unknown[] = []
  const tree = DynamicVolumePanel({
    servicesManager: {
      services: {
        viewportGridService: { getActiveViewportId: () => 'short' },
      },
    },
    commandsManager: { runCommand: (_: string, o: unknown) => runs.push(o) },
  } as never)
  effects.splice(0)
  for (const click of buttons(tree)) click()
  expect(runs).toContainEqual({ operation: 'SUM', start: 2, end: 3 })
  leave()
})
