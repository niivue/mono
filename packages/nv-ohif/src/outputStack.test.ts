import { expect, mock, test } from 'bun:test'
import type { NiiVue } from '@niivue/niivue'
import * as React from 'react'
import type { DicomConversion } from './dicomToNiivue'
import type { OhifDisplaySet } from './ohif-types'

const effects: Array<() => () => void> = []
mock.module('react', () => ({
  ...React,
  useEffect: (fn: () => () => void) => effects.push(fn),
}))
const { useOutputStack } = await import('./outputStack')
const {
  registerNiivue,
  getNiivueEntry,
  updateNiivueViewport,
  unregisterNiivue,
} = await import('./niivueRegistry')

const frames = (sop: string) => ({
  origin: [0, 0, 0] as [number, number, number],
  normal: [0, 0, 1] as [number, number, number],
  frames: [{ SOPInstanceUID: sop, frameNumber: 1 }],
})

// R15 audit: a localizer output still loading when the series is replaced
// must not install over the new series (volume or frame identity).
test('a pending output load does not overwrite a replacement series', async () => {
  let finish: (v: unknown) => void = () => {}
  const fake = {
    canvas: new EventTarget(),
    volumes: [{ name: 'old-a', dims: [3, 2, 2, 1] }] as unknown[],
    prepareVolume: () => new Promise((resolve) => (finish = resolve)),
    loadVolumes: async (v: unknown[]) => {
      fake.volumes = v
    },
  }
  const nv = fake as unknown as NiiVue
  registerNiivue('vp', nv)
  const conversion = {
    image: { name: 'old-a' },
    sliceFrames: frames('old-a'),
    alternates: [{ image: { name: 'old-b' }, sliceFrames: frames('old-b') }],
  } as unknown as DicomConversion
  const ds = {
    instances: [{ SOPInstanceUID: 'old-a' }, { SOPInstanceUID: 'old-b' }],
  } as unknown as OhifDisplaySet
  useOutputStack(nv, 'vp', ds, conversion)
  const cleanup = effects.pop()?.()
  expect(getNiivueEntry('vp')?.switchToInstance?.('old-b')).toBe(true)
  cleanup?.()
  fake.volumes = [{ name: 'new-series' }]
  updateNiivueViewport('vp', { sliceFrames: frames('new-series') })
  finish({ name: 'old-b', dims: [3, 2, 2, 1] })
  await new Promise((r) => setTimeout(r, 0))
  expect(fake.volumes).toEqual([{ name: 'new-series' }])
  expect(getNiivueEntry('vp')?.sliceFrames?.frames[0]?.SOPInstanceUID).toBe(
    'new-series',
  )
  unregisterNiivue('vp')
})
