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
const { cineStep } = await import('./sliceCine')
const {
  applyNiivueAnnotationDelta,
  jumpToNiivueMeasurement,
  reflectNiivueAnnotation,
  reflectedRowUid,
} = await import('./commands')
const { DRAG_MODE, generateShape } = await import('@niivue/niivue')
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

// Review of 167ecb0a: a wheel from a single-slice output into a multi-slice
// one landed on its centre slice (B2), skipping B1; a volume viewport too
// (review of 0c96b432).
for (const isVolumeViewport of [false, true])
  test(`the wheel enters a multi-slice output on its adjacent image${isVolumeViewport ? ' (volume viewport)' : ''}`, async () => {
    const sf = (sops: string[], z: number) => ({
      origin: [0, 0, z] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
      frames: sops.map((SOPInstanceUID) => ({
        SOPInstanceUID,
        frameNumber: 1,
      })),
    })
    const a = {
      name: 'A',
      dims: [3, 2, 2, 1],
      dimsRAS: [3, 2, 2, 1],
      permRAS: [1, 2, 3],
    }
    const b = {
      name: 'B',
      dims: [3, 2, 2, 3],
      dimsRAS: [3, 2, 2, 3],
      permRAS: [1, 2, 3],
    }
    let z = 0
    const nv = {
      canvas: new EventTarget(),
      volumes: [a],
      sliceType: 0,
      prepareVolume: async (o: { name: string }) => (o.name === 'A' ? a : b),
      loadVolumes: async (v: (typeof a)[]) => {
        nv.volumes = v
      },
      vox2frac: (v: number[]) => v,
      set crosshairPos(v: number[]) {
        nv.setCrosshairPos([0, 0, (nv.volumes[0] === a ? 0 : 10) + (v[2] ?? 0)])
      },
      setCrosshairPos: (p: number[]) => {
        z = p[2] ?? 0
        const entry = getNiivueEntry('vw')
        if (entry) entry.crosshairMM = p
      },
    }
    const ds = {
      instances: ['A', 'B1', 'B2', 'B3'].map((SOPInstanceUID) => ({
        SOPInstanceUID,
      })),
    } as unknown as OhifDisplaySet
    registerNiivue('vw', nv as unknown as NiiVue)
    updateNiivueViewport('vw', {
      displaySets: [ds],
      sliceFrames: sf(['A'], 0),
      isVolumeViewport,
    })
    const entry = getNiivueEntry('vw')
    if (entry) entry.crosshairMM = [0, 0, 0]
    useOutputStack(
      nv as unknown as NiiVue,
      'vw',
      ds,
      {
        image: { name: 'A' },
        sliceFrames: sf(['A'], 0),
        alternates: [
          { image: { name: 'B' }, sliceFrames: sf(['B1', 'B2', 'B3'], 10) },
        ],
      } as unknown as DicomConversion,
      () => {},
    )
    const cleanup = effects.pop()?.()
    const wheel = async () => {
      nv.canvas.dispatchEvent(
        Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 1 }),
      )
      await new Promise((r) => setTimeout(r, 0))
    }
    await wheel()
    expect([nv.volumes[0]?.name, z]).toEqual(['B', 10])
    await wheel()
    expect(z).toBe(11)
    // Review of the R28 draft: from A, one 12 px StackScroll move (three
    // steps) must reach B3, the steps after the switch waiting for its load.
    const back = (deltaY: number) =>
      nv.canvas.dispatchEvent(
        Object.assign(new Event('wheel', { cancelable: true }), { deltaY }),
      )
    back(-1)
    back(-1)
    await new Promise((r) => setTimeout(r, 0))
    expect(nv.volumes[0]?.name).toBe('A')
    Object.assign(nv, { primaryDragMode: DRAG_MODE.slice })
    for (const [type, clientY] of [
      ['pointerdown', 0],
      ['pointermove', 12],
    ] as const)
      nv.canvas.dispatchEvent(
        Object.assign(new Event(type), { button: 0, buttons: 1, clientY }),
      )
    await new Promise((r) => setTimeout(r, 0))
    expect([nv.volumes[0]?.name, z]).toEqual(['B', 12])
    cleanup?.()
    unregisterNiivue('vw')
  })

// Review of bf1651c3: a volume viewport counts one output's frames, so at a
// single-slice output's end the wheel must switch outputs, not clamp. Viewed
// across (coronal), it must not just move the crosshair in the slice.
test.each([
  0, 1,
])('the wheel steps single-slice outputs on a volume viewport (sliceType %d)', async (sliceType) => {
  const sf = (sop: string) => ({
    origin: [0, 0, 0] as [number, number, number],
    normal: [0, 0, 1] as [number, number, number],
    frames: [{ SOPInstanceUID: sop, frameNumber: 1 }],
  })
  const vol = (name: string) => ({
    name,
    dims: [3, 2, 2, 1],
    dimsRAS: [3, 2, 2, 1],
    permRAS: [1, 2, 3],
  })
  const a = vol('A')
  const b = vol('B')
  const nv = {
    canvas: new EventTarget(),
    volumes: [a],
    sliceType,
    prepareVolume: async (o: { name: string }) => (o.name === 'A' ? a : b),
    loadVolumes: async (v: (typeof a)[]) => {
      nv.volumes = v
    },
    vox2frac: (v: number[]) => v,
    crosshairPos: [0, 0, 0],
    setCrosshairPos: () => {},
    moveCrosshairInVox: (x: number, y: number, z: number) => {
      const [px = 0, py = 0, pz = 0] = nv.crosshairPos
      nv.crosshairPos = [px + x, py + y, pz + z]
    },
  }
  const ds = {
    instances: [{ SOPInstanceUID: 'A' }, { SOPInstanceUID: 'B' }],
  } as unknown as OhifDisplaySet
  registerNiivue('vv', nv as unknown as NiiVue)
  updateNiivueViewport('vv', {
    displaySets: [ds],
    sliceFrames: sf('A'),
    isVolumeViewport: true,
  })
  const entry = getNiivueEntry('vv')
  if (entry) entry.crosshairMM = [0, 0, 0]
  useOutputStack(
    nv as unknown as NiiVue,
    'vv',
    ds,
    {
      image: { name: 'A' },
      sliceFrames: sf('A'),
      alternates: [{ image: { name: 'B' }, sliceFrames: sf('B') }],
    } as unknown as DicomConversion,
    () => {},
  )
  const cleanup = effects.pop()?.()
  nv.canvas.dispatchEvent(
    Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 1 }),
  )
  await new Promise((r) => setTimeout(r, 0))
  expect(nv.volumes[0]?.name).toBe('B')
  cleanup?.()
  unregisterNiivue('vv')
})

// Review of 85bbce02: outputs sorted by their first slice put B, whose first
// slice is unmapped, before A, so the wheel could not reach it; and cine
// wrapped instead of waiting for the switch into B.
test.each([
  'wheel',
  'cine',
] as const)('outputs order by first instance; %s steps across them', async (run) => {
  const vol = (name: string, n: number) => ({
    name,
    dims: [3, 2, 2, n],
    dimsRAS: [3, 2, 2, n],
    permRAS: [1, 2, 3],
  })
  const a = vol('A', 1)
  const b = vol('B', 2)
  const nv = {
    canvas: new EventTarget(),
    volumes: [a],
    sliceType: 0,
    prepareVolume: async (o: { name: string }) => (o.name === 'A' ? a : b),
    loadVolumes: async (v: (typeof a)[]) => {
      nv.volumes = v
    },
    vox2frac: (v: number[]) => v,
    crosshairPos: [0, 0, 0],
    setCrosshairPos: () => {},
    moveCrosshairInVox: () => {},
  }
  const frame = (SOPInstanceUID: string) => ({ SOPInstanceUID, frameNumber: 1 })
  const sf = (frames: Array<ReturnType<typeof frame> | undefined>) => ({
    origin: [0, 0, 0] as [number, number, number],
    normal: [0, 0, 1] as [number, number, number],
    frames,
  })
  const ds = {
    instances: [{ SOPInstanceUID: 'A' }, { SOPInstanceUID: 'B' }],
  } as unknown as OhifDisplaySet
  nv.volumes = [a]
  registerNiivue('vo', nv as unknown as NiiVue)
  updateNiivueViewport('vo', {
    displaySets: [ds],
    sliceFrames: sf([frame('A')]),
    isVolumeViewport: run === 'wheel',
  })
  const entry = getNiivueEntry('vo')
  if (entry) entry.crosshairMM = [0, 0, 0]
  useOutputStack(
    nv as unknown as NiiVue,
    'vo',
    ds,
    {
      image: { name: 'A' },
      sliceFrames: sf([frame('A')]),
      alternates: [
        { image: { name: 'B' }, sliceFrames: sf([undefined, frame('B')]) },
      ],
    } as unknown as DicomConversion,
    () => {},
  )
  const cleanup = effects.pop()?.()
  if (run === 'wheel')
    nv.canvas.dispatchEvent(
      Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 1 }),
    )
  else if (entry) cineStep(entry)
  await new Promise((r) => setTimeout(r, 0))
  expect([run, nv.volumes[0]?.name]).toEqual([run, 'B'])
  cleanup?.()
  unregisterNiivue('vo')
})

// Review of d2bb6a5e: on a slice without a frame, the wheel moved the
// crosshair and also switched outputs.
test('the wheel moves through unmapped slices without switching', async () => {
  const vol = (name: string, n: number) => ({
    name,
    dims: [3, 2, 2, n],
    dimsRAS: [3, 2, 2, n],
    permRAS: [1, 2, 3],
  })
  const a = vol('A', 1)
  const b = vol('B', 3)
  const nv = {
    canvas: new EventTarget(),
    volumes: [b],
    sliceType: 0,
    prepareVolume: async (o: { name: string }) => (o.name === 'A' ? a : b),
    loadVolumes: async (v: (typeof a)[]) => {
      nv.volumes = v
    },
    vox2frac: (v: number[]) => v,
    crosshairPos: [0, 0, 1],
    setCrosshairPos: () => {},
    moveCrosshairInVox: (x: number, y: number, z: number) => {
      const [px = 0, py = 0, pz = 0] = nv.crosshairPos
      nv.crosshairPos = [px + x, py + y, pz + z]
    },
  }
  const frame = (SOPInstanceUID: string) => ({ SOPInstanceUID, frameNumber: 1 })
  const sf = (frames: Array<ReturnType<typeof frame> | undefined>) => ({
    origin: [0, 0, 0] as [number, number, number],
    normal: [0, 0, 1] as [number, number, number],
    frames,
  })
  const ds = {
    instances: [{ SOPInstanceUID: 'B' }, { SOPInstanceUID: 'A' }],
  } as unknown as OhifDisplaySet
  const bFrames = sf([undefined, undefined, frame('B')])
  registerNiivue('vu', nv as unknown as NiiVue)
  updateNiivueViewport('vu', {
    displaySets: [ds],
    sliceFrames: bFrames,
    isVolumeViewport: true,
  })
  const entry = getNiivueEntry('vu')
  if (entry) entry.crosshairMM = [0, 0, 1]
  useOutputStack(
    nv as unknown as NiiVue,
    'vu',
    ds,
    {
      image: { name: 'B' },
      sliceFrames: bFrames,
      alternates: [{ image: { name: 'A' }, sliceFrames: sf([frame('A')]) }],
    } as unknown as DicomConversion,
    () => {},
  )
  const cleanup = effects.pop()?.()
  nv.canvas.dispatchEvent(
    Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 1 }),
  )
  await new Promise((r) => setTimeout(r, 0))
  expect([nv.volumes[0]?.name, nv.crosshairPos[2]]).toEqual(['B', 2])
  cleanup?.()
  unregisterNiivue('vu')
})

// Review of the R28 draft: a StackScroll drag over single-slice outputs moved
// one image per pointer event, however many 4 px steps it crossed, and steps
// taken while a switch loads must carry on from it.
test('a StackScroll drag steps by distance, not by event count', async () => {
  const end = async (moves: number[], released = false) => {
    const sf = (sop: string) => ({
      origin: [0, 0, 0] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
      frames: [{ SOPInstanceUID: sop, frameNumber: 1 }],
    })
    const vs = ['A', 'B', 'C', 'D'].map((name) => ({
      name,
      dims: [3, 2, 2, 1],
      dimsRAS: [3, 2, 2, 1],
      permRAS: [1, 2, 3],
    }))
    const nv = {
      canvas: new EventTarget(),
      volumes: [vs[0]],
      sliceType: 0,
      primaryDragMode: DRAG_MODE.slice,
      prepareVolume: async (o: { name: string }) =>
        vs.find((v) => v.name === o.name),
      loadVolumes: async (v: typeof vs) => {
        nv.volumes = v
      },
      vox2frac: (v: number[]) => v,
      crosshairPos: [0, 0, 0],
      setCrosshairPos: () => {},
      moveCrosshairInVox: () => {},
    }
    const ds = {
      instances: vs.map((v) => ({ SOPInstanceUID: v.name })),
    } as unknown as OhifDisplaySet
    registerNiivue('drag', nv as unknown as NiiVue)
    updateNiivueViewport('drag', {
      displaySets: [ds],
      sliceFrames: sf('A'),
      isVolumeViewport: true,
    })
    useOutputStack(
      nv as unknown as NiiVue,
      'drag',
      ds,
      {
        image: { name: 'A' },
        sliceFrames: sf('A'),
        alternates: vs
          .slice(1)
          .map((v) => ({ image: { name: v.name }, sliceFrames: sf(v.name) })),
      } as unknown as DicomConversion,
      () => {},
    )
    const cleanup = effects.pop()?.()
    const pointer = (type: string, clientY: number) =>
      nv.canvas.dispatchEvent(
        Object.assign(new Event(type), { button: 0, buttons: 1, clientY }),
      )
    pointer('pointerdown', 0)
    if (released) pointer('pointerup', 0)
    for (const y of moves) pointer('pointermove', y)
    await new Promise((r) => setTimeout(r, 0))
    cleanup?.()
    unregisterNiivue('drag')
    return nv.volumes[0]?.name
  }
  // Past D and back one image: C, however the steps meet the loads.
  expect([await end([12]), await end([4, 8, 12]), await end([20, 16])]).toEqual(
    ['D', 'D', 'C'],
  )
  // Review of #876: a press entering after a release does not scroll.
  expect(await end([8], true)).toBe('A')
})
