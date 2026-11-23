import { afterAll, mock } from 'bun:test'
import * as React from 'react'

type Hook = (...args: never[]) => unknown

/**
 * Test-only: mock React hooks for the calling test file. Bun keeps a module
 * mock for every later test file, so each hook hands back to the one it
 * replaced once this file's tests are done.
 */
export function mockReactHooks(hooks: Record<string, Hook>): void {
  const prior = { ...React } as unknown as Record<string, Hook>
  let active = true
  afterAll(() => {
    active = false
  })
  const handOff = Object.fromEntries(
    Object.entries(hooks).map(([name, hook]) => [
      name,
      (...args: never[]) => (active ? hook : (prior[name] as Hook))(...args),
    ]),
  )
  mock.module('react', () => ({ ...prior, ...handOff }))
}
