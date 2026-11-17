import { expect, mock, test } from 'bun:test'
import * as React from 'react'

const effects: Array<() => undefined | (() => void)> = []
mock.module('react', () => ({
  ...React,
  useState: <T>(init: T | (() => T)) => [
    typeof init === 'function' ? (init as () => T)() : init,
    () => {},
  ],
  useEffect: (fn: () => undefined | (() => void)) => effects.push(fn),
}))
const { useHydratePrompt } = await import('./segHydration')

test('switching SEG or reloading retires the open hydrate prompt', () => {
  const log: string[] = []
  let submit: (response: number) => void = () => {}
  const servicesManager = {
    services: {
      viewportGridService: {
        getActiveViewportId: () => 'vp',
        subscribe: () => ({ unsubscribe: () => {} }),
        EVENTS: {},
      },
      uiViewportDialogService: {
        show: (p: { onSubmit: (r: number) => void }) => {
          log.push('show')
          submit = p.onSubmit
        },
        hide: () => log.push('hide'),
      },
    },
  }
  const commandsManager = {
    runCommand: (
      _: string,
      { displaySet }: { displaySet: { displaySetInstanceUID: string } },
    ) => log.push(`hydrate:${displaySet.displaySetInstanceUID}`),
  }
  effects.length = 0
  useHydratePrompt(
    { displaySetInstanceUID: 'A', Modality: 'SEG' } as never,
    true,
    true,
    {
      viewportId: 'vp',
      servicesManager: servicesManager as never,
      commandsManager: commandsManager as never,
    },
  )
  // The prompt effect is the last one the hook registers.
  const cleanup = (effects.at(-1) as () => (() => void) | undefined)()
  const yesToA = submit
  cleanup?.()
  yesToA(5)
  expect(log).toEqual(['show', 'hide'])
})
