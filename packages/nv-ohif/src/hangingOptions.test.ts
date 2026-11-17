import { expect, mock, test } from 'bun:test'
import * as React from 'react'

const effects: Array<() => undefined | (() => void)> = []
const effectDeps: unknown[][] = []
mock.module('react', () => ({
  ...React,
  useEffect: (fn: () => undefined | (() => void), deps: unknown[]) => {
    effects.push(fn)
    effectDeps.push(deps)
  },
}))
const { applyViewportStyle, isMip, useHungOverlays } = await import(
  './hangingOptions'
)
const { getNiivueEntry, registerNiivue, unregisterNiivue } = await import(
  './niivueRegistry'
)

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

test('leaving a MIP restores composite rendering', () => {
  const nv = { sliceType: 0, volumeRenderMode: 0, azimuth: 0, elevation: 0 }
  const canvas = { style: { filter: '' } }
  const pane = { viewportType: 'volume3d', orientation: 'sagittal' }
  const style = (blendMode: string) =>
    applyViewportStyle(nv as never, canvas as never, pane, [
      { options: { blendMode, slabThickness: 'fullVolume' } },
    ] as never)
  style('MIP')
  expect(nv.volumeRenderMode).toBe(1)
  style('COMPOSITE')
  expect(nv.volumeRenderMode).toBe(0)
})

const ds = (uid: string) => ({
  displaySetInstanceUID: uid,
  url: `${uid}.nii.gz`,
})

test('dropping a hung overlay mid-load aborts that load', () => {
  const nv = { colormaps: [], volumes: [] }
  registerNiivue('vp-drop', nv as never)
  const entry = getNiivueEntry('vp-drop')
  const loads: AbortController[] = []
  const commandsManager = {
    // As niivueAddOverlay: the controller is installed before the first await.
    runCommand: () => {
      const abort = new AbortController()
      loads.push(abort)
      if (entry) entry.overlayAbort = abort
      return new Promise(() => {})
    },
  }
  const hang = (uids: string[]) => {
    useHungOverlays(
      nv as never,
      'vp-drop',
      [ds('ct'), ...uids.map(ds)] as never,
      [],
      'ct',
      commandsManager as never,
    )
    return (effects.pop() as () => (() => void) | undefined)()
  }
  const cleanup = hang(['pt'])
  expect(loads).toHaveLength(1)
  cleanup?.()
  hang([])
  expect(loads[0]?.signal.aborted).toBe(true)
  unregisterNiivue('vp-drop')
})

test('a new window on a layered overlay restyles it in place', async () => {
  const base = {}
  const pt = {}
  const updates: Array<[number, Record<string, unknown>]> = []
  const nv = {
    colormaps: [],
    volumes: [{ hdr: base }, { hdr: pt }],
    setVolume: async (i: number, o: Record<string, unknown>) => {
      updates.push([i, o])
    },
  }
  registerNiivue('vp-style', nv as never)
  getNiivueEntry('vp-style')?.overlays.set('pt', pt as never)
  const added: unknown[] = []
  const commandsManager = {
    runCommand: async (...a: unknown[]) => added.push(a),
  }
  const hang = (width: number) => {
    useHungOverlays(
      nv as never,
      'vp-style',
      [ds('ct'), ds('pt')] as never,
      [
        {},
        { options: { voi: { windowWidth: width, windowCenter: width / 2 } } },
      ],
      'ct',
      commandsManager as never,
    )
    effects.pop()?.()
  }
  hang(5)
  hang(10)
  await new Promise((r) => setTimeout(r, 0))
  const [narrow, wide] = effectDeps.slice(-2)
  expect(narrow).not.toEqual(wide)
  expect(added).toEqual([])
  expect(updates.map(([i, o]) => [i, o.calMin, o.calMax])).toEqual([
    [1, 0, 5],
    [1, 0, 10],
  ])
  unregisterNiivue('vp-style')
})

test('an overlay dropped from the protocol after it loaded is removed', async () => {
  const removed: number[] = []
  const user = {}
  const nv = {
    colormaps: [],
    volumes: [{ hdr: {} }, { hdr: user }],
    removeVolume: async (i: number) => {
      removed.push(i)
      nv.volumes.splice(i, 1)
    },
  }
  registerNiivue('vp-drop', nv as never)
  const entry = getNiivueEntry('vp-drop')
  // A user-added overlay the protocol never hung stays.
  entry?.overlays.set('user', user as never)
  const removeCalls: unknown[] = []
  const commandsManager = {
    runCommand: async (
      name: string,
      a: { viewportId: string; displaySetInstanceUID: string },
    ) => {
      if (name === 'niivueRemoveOverlay') {
        removeCalls.push(a)
        const hdr = entry?.overlays.get(a.displaySetInstanceUID)
        entry?.overlays.delete(a.displaySetInstanceUID)
        return nv.removeVolume(nv.volumes.findIndex((v) => v.hdr === hdr))
      }
      const hdr = {}
      nv.volumes.push({ hdr })
      entry?.overlays.set(a.displaySetInstanceUID, hdr as never)
    },
  }
  const hang = async (uids: string[]) => {
    useHungOverlays(
      nv as never,
      'vp-drop',
      uids.map(ds) as never,
      [],
      'ct',
      commandsManager as never,
    )
    effects.pop()?.()
    await new Promise((r) => setTimeout(r, 0))
  }
  await hang(['ct', 'pt'])
  await hang(['ct'])
  // Through the command, which also refreshes the toolbar.
  expect(removeCalls).toEqual([
    { viewportId: 'vp-drop', displaySetInstanceUID: 'pt' },
  ])
  expect(removed).toEqual([2])
  expect(entry?.overlays.has('pt')).toBe(false)
  expect(entry?.overlays.has('user')).toBe(true)
  unregisterNiivue('vp-drop')
})
