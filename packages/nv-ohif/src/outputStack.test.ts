import { expect, mock, test } from 'bun:test'
import type { NiiVue } from '@niivue/niivue'
import * as React from 'react'
import type { DicomConversion } from './dicomToNiivue'
import type { OhifDisplaySet } from './ohif-types'

const effects: Array<() => () => void> = []
mock.module('react', () => ({
  ...React,
  useEffect: (fn: () => () => void) => effects.push(fn),
  useRef: <T>(current: T) => ({ current }),
}))
const { useOutputStack } = await import('./outputStack')
const {
  applyNiivueAnnotationDelta,
  jumpToNiivueMeasurement,
  reflectNiivueAnnotation,
  reflectedRowUid,
} = await import('./commands')
const { generateShape } = await import('@niivue/niivue')
const {
  registerNiivue,
  getNiivueEntry,
  updateNiivueViewport,
  unregisterNiivue,
} = await import('./niivueRegistry')

const frames = (sop: string, z = 0) => ({
  origin: [0, 0, z] as [number, number, number],
  normal: [0, 0, 1] as [number, number, number],
  frames: [{ SOPInstanceUID: sop, frameNumber: 1 }],
})
const ellipse = (id: string, z = 0) => ({
  id,
  label: 0,
  group: '',
  sliceType: 0,
  slicePosition: z,
  text: id,
  polygons: generateShape('measureEllipse', { x: 0, y: 0 }, { x: 1, y: 1 }, 1),
  style: { fillColor: [1, 1, 1, 1], strokeColor: [1, 1, 1, 1], strokeWidth: 1 },
  stats: { area: 1, min: 0, mean: 0, max: 0, stdDev: 0 },
  shape: { type: 'measureEllipse', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
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
  useOutputStack(nv, 'vp', ds, conversion, () => {})
  const cleanup = effects.pop()?.()
  expect(getNiivueEntry('vp')?.switchToInstance?.('old-b')).toBeDefined()
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

test('a failed output load becomes a note', async () => {
  const fake = {
    canvas: new EventTarget(),
    volumes: [{ name: 'a', dims: [3, 2, 2, 1] }],
    prepareVolume: async () => {
      throw new Error('bad file')
    },
  }
  const notes: string[] = []
  const conversion = {
    image: { name: 'a' },
    sliceFrames: frames('a'),
    alternates: [{ image: { name: 'b' }, sliceFrames: frames('b') }],
  } as unknown as DicomConversion
  const ds = {
    instances: [{ SOPInstanceUID: 'a' }, { SOPInstanceUID: 'b' }],
  } as unknown as OhifDisplaySet
  registerNiivue('vf', fake as unknown as NiiVue)
  useOutputStack(fake as unknown as NiiVue, 'vf', ds, conversion, (m) =>
    notes.push(m),
  )
  const cleanup = effects.pop()?.()
  expect(await getNiivueEntry('vf')?.switchToInstance?.('b')).toBe(false)
  expect(notes).toEqual(['Switching output failed: bad file'])
  cleanup?.()
  unregisterNiivue('vf')
})

// R15 round 19: three localizer outputs a, b, c with measurements A, B, C.
function jumpRig() {
  const loads: Array<() => void> = []
  let selected: string | null = null
  const nv = {
    canvas: new EventTarget(),
    volumes: [{ name: 'la', dims: [3, 2, 2, 1] }] as unknown[],
    annotations: [ellipse('LA'), ellipse('LB'), ellipse('LC')],
    prepareVolume: async (o: { name: string }) => ({ name: o.name }),
    loadVolumes: (v: unknown[]) =>
      new Promise<void>((resolve) =>
        loads.push(() => {
          nv.volumes = v
          resolve()
        }),
      ),
    selectAnnotation: (id: string | null) => {
      selected = id
    },
    get selectedAnnotation() {
      return selected
    },
    setCrosshairPos() {},
    vox2frac: () => [0.5, 0.5, 0.5],
  }
  registerNiivue('vj', nv as unknown as NiiVue)
  const sop: Record<string, string> = {}
  const ds = {
    SeriesInstanceUID: 's',
    displaySetInstanceUID: 'd',
    instances: ['la', 'lb', 'lc'].map((o) => ({ SOPInstanceUID: o })),
  }
  const sm = {
    services: {
      measurementService: {
        createSource: () => ({}),
        addMapping() {},
        addRawMeasurement: (_s: unknown, _t: unknown, d: { uid: string }) =>
          d.uid,
        getMeasurement: (uid: string) => ({ SOPInstanceUID: sop[uid] }),
      },
      displaySetService: { getDisplaySetsForSeries: () => [ds] },
    },
  } as never
  updateNiivueViewport('vj', {
    displaySets: [ds] as never,
    sliceFrames: frames('la'),
  })
  const conversion = {
    image: { name: 'la' },
    sliceFrames: frames('la'),
    alternates: ['lb', 'lc'].map((o, i) => ({
      image: { name: o },
      sliceFrames: frames(o, 5 * (i + 1)),
    })),
  } as unknown as DicomConversion
  // biome-ignore lint/correctness/useHookAtTopLevel: useEffect is mocked
  useOutputStack(
    nv as unknown as NiiVue,
    'vj',
    ds as never,
    conversion,
    () => {},
  )
  effects.pop()?.()
  const uid = (id: string) => reflectedRowUid(id) as string
  for (const a of nv.annotations) {
    reflectNiivueAnnotation('vj', sm, a as never)
    sop[uid(a.id)] = a.id.toLowerCase()
  }
  const jump = (id: string) => jumpToNiivueMeasurement(uid(id), sm)
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const settle = async () => {
    for (await tick(); loads.length; await tick()) loads.shift()?.()
  }
  return { nv, jump, settle }
}

test('a jump during a localizer load wins over the earlier jump', async () => {
  const { nv, jump, settle } = jumpRig()
  jump('LB')
  jump('LC') // while lb loads: queued, not dropped
  await settle()
  expect((nv.volumes[0] as { name: string }).name).toBe('lc')
  expect(nv.selectedAnnotation).toBe('LC')
  unregisterNiivue('vj')
})

test('a jump to the shown output during a load keeps that output', async () => {
  const { nv, jump, settle } = jumpRig()
  jump('LB')
  jump('LA') // la is shown: lb's load must not take over after it
  await settle()
  expect((nv.volumes[0] as { name: string }).name).toBe('la')
  expect(nv.selectedAnnotation).toBe('LA')
  unregisterNiivue('vj')
})

test('a selection made during a jump load survives it', async () => {
  const { nv, jump, settle } = jumpRig()
  jump('LB')
  nv.selectAnnotation('LA') // a click on another shape
  await settle()
  expect(nv.selectedAnnotation).toBe('LA')
  unregisterNiivue('vj')
})

// R15 round 19: coplanar outputs (echoes) or a shape on the line where
// localizer planes intersect lie in several outputs; a rename keeps the row's
// own image, not the shown output's.
test('rename keeps the image of a measurement on a coplanar output', () => {
  const a = ellipse('R')
  registerNiivue('vr', { annotations: [a] } as unknown as NiiVue)
  const ds = {
    SeriesInstanceUID: 's',
    displaySetInstanceUID: 'd',
    instances: [{}],
  }
  const rows: Record<string, { SOPInstanceUID?: string }> = {}
  const sm = {
    services: {
      measurementService: {
        createSource: () => ({}),
        addMapping() {},
        addRawMeasurement: (
          _s: unknown,
          _t: unknown,
          d: { uid: string },
          toRow: (d: unknown) => never,
        ) => {
          rows[d.uid] = toRow(d)
          return d.uid
        },
        getMeasurement: (uid: string) => rows[uid],
      },
      displaySetService: { getDisplaySetsForSeries: () => [ds] },
    },
  } as never
  const [fa, fb] = [frames('sop-a'), frames('sop-b')]
  updateNiivueViewport('vr', {
    displaySets: [ds] as never,
    sliceFrames: fb,
    outputFrames: [fa, fb],
  })
  reflectNiivueAnnotation('vr', sm, a as never) // drawn on output b
  updateNiivueViewport('vr', { sliceFrames: fa }) // wheel to output a
  a.text = 'renamed'
  applyNiivueAnnotationDelta('vr', sm, {
    added: [],
    updated: ['R'],
    removed: [],
  })
  expect(rows[reflectedRowUid('R') as string]?.SOPInstanceUID).toBe('sop-b')
  unregisterNiivue('vr')
})

test('a superseded output load fails without a note', async () => {
  let calls = 0
  let rejectFirst: (e: Error) => void = () => {}
  const fake = {
    canvas: new EventTarget(),
    volumes: [{ name: 'a', dims: [3, 2, 2, 1] }],
    prepareVolume: () =>
      ++calls === 1
        ? new Promise((_, reject) => {
            rejectFirst = reject
          })
        : Promise.reject(new Error('new failure')),
  }
  const notes: string[] = []
  const conversion = {
    image: { name: 'a' },
    sliceFrames: frames('a'),
    alternates: [{ image: { name: 'b' }, sliceFrames: frames('b') }],
  } as unknown as DicomConversion
  const ds = {
    instances: [{ SOPInstanceUID: 'a' }, { SOPInstanceUID: 'b' }],
  } as unknown as OhifDisplaySet
  registerNiivue('vs', fake as unknown as NiiVue)
  useOutputStack(fake as unknown as NiiVue, 'vs', ds, conversion, (m) =>
    notes.push(m),
  )
  const cleanup = effects.pop()?.()
  const first = getNiivueEntry('vs')?.switchToInstance?.('b')
  const second = getNiivueEntry('vs')?.switchToInstance?.('b')
  rejectFirst(new Error('old failure'))
  expect([await first, await second]).toEqual([false, false])
  expect(notes).toEqual(['Switching output failed: new failure'])
  cleanup?.()
  unregisterNiivue('vs')
})
