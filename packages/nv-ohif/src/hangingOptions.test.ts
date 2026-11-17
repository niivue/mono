import { expect, mock, test } from 'bun:test'
import * as React from 'react'

const effects: Array<() => undefined | (() => void)> = []
mock.module('react', () => ({
  ...React,
  useEffect: (fn: () => undefined | (() => void)) => effects.push(fn),
}))
const { isMip, useHungOverlays } = await import('./hangingOptions')

// The 4D demo's PT panes say MIP without a slab: cornerstone shows a slice.
test('isMip needs a full-volume slab', () => {
  expect(isMip([{ options: { blendMode: 'MIP' } }])).toBe(false)
  expect(
    isMip([{ options: { blendMode: 'MIP', slabThickness: 'fullVolume' } }]),
  ).toBe(true)
})

test('a superseded overlay run adds no more overlays', async () => {
  const ds = (uid: string) => ({
    displaySetInstanceUID: uid,
    url: `${uid}.nii.gz`,
  })
  const added: string[] = []
  let release = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  const commandsManager = {
    runCommand: async (
      _: string,
      { displaySetInstanceUID: uid }: { displaySetInstanceUID: string },
    ) => {
      added.push(uid)
      if (uid === 'old1') await held
    },
  }
  const nv = { colormaps: [] }
  const hang = (uids: string[]) => {
    useHungOverlays(
      nv as never,
      'vp',
      [ds('ct'), ...uids.map(ds)] as never,
      [],
      'ct',
      commandsManager as never,
    )
    return (effects.pop() as () => (() => void) | undefined)()
  }
  const cleanup = hang(['old1', 'old2'])
  cleanup?.()
  hang(['new1'])
  release()
  await new Promise((r) => setTimeout(r, 0))
  expect(added).toEqual(['old1', 'new1'])
})
