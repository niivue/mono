import { afterEach, expect, test } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import {
  getNiivueEntry,
  type NiivueViewportEntry,
  registerNiivue,
  unregisterNiivue,
} from './niivueRegistry'
import { joinSyncGroups } from './viewportSync'

// Panes stay registered otherwise and break suites that need an empty registry.
const panes: string[] = []
afterEach(() => {
  for (const id of panes.splice(0)) unregisterNiivue(id)
})

// A pane showing display sets `uids` (base first, then overlays), recording
// its broadcast targets and the windows set on it.
const pane = (id: string, uids: string[]) => {
  const volumes = uids.map((uid) => ({ hdr: { uid }, calMin: 0, calMax: 1 }))
  const listeners: Record<string, ((e: Event) => void)[]> = {}
  const emit = (type: string, detail: unknown) => {
    for (const f of listeners[type] ?? []) f(new CustomEvent(type, { detail }))
  }
  let pan: Float32Array = new Float32Array([0, 0, 0, 1])
  const p = {
    targets: [] as unknown[],
    volumes,
    get pan2Dxyzmm() {
      return pan
    },
    set pan2Dxyzmm(v: Float32Array) {
      pan = v
      emit('change', { property: 'pan2Dxyzmm', value: v })
    },
    broadcastTo: (t?: unknown[]) => {
      p.targets = t ?? []
    },
    addEventListener: (type: string, f: (e: Event) => void) => {
      listeners[type] = [...(listeners[type] ?? []), f]
    },
    removeEventListener: () => {},
    setVolume: async (i: number, w: { calMin: number; calMax: number }) => {
      Object.assign(volumes[i] as object, w)
      emit('volumeUpdated', { volumeIndex: i, volume: volumes[i], changes: w })
    },
  }
  const nv = p as typeof p & NiiVue
  registerNiivue(id, nv)
  panes.push(id)
  const entry = getNiivueEntry(id) as NiivueViewportEntry
  entry.displaySets = [{ displaySetInstanceUID: uids[0] }]
  for (const v of volumes.slice(1))
    entry.overlays.set(v.hdr.uid, v.hdr as never)
  return nv
}

test('panes sharing any group share the crosshair; others stay out', () => {
  const [ax, cor, vr] = [
    pane('ax', ['ct']),
    pane('cor', ['ct']),
    pane('vr', ['ct']),
  ]
  const leaveAx = joinSyncGroups('ax', ax, [{ type: 'voi', id: 'mpr' }])
  joinSyncGroups('cor', cor, [
    { type: 'voi', id: 'mpr' },
    { type: 'hydrateseg', id: 'for' },
  ])
  joinSyncGroups('vr', vr, [{ type: 'cameraPosition', id: 'other' }])
  expect(ax.targets).toEqual([cor])
  expect(cor.targets).toEqual([ax])
  expect(vr.targets).toEqual([])
  leaveAx()
  expect(cor.targets).toEqual([])
})

test('a VOI group windows the same display set, source to target only', async () => {
  // TMTV: PT windows the fusion's PT overlay (not its CT base); fusion is not a source.
  const pt = pane('pt', ['PT'])
  const fusion = pane('fusion', ['CT', 'PT'])
  const ct = pane('ct', ['CT'])
  joinSyncGroups('pt', pt, [{ type: 'voi', id: 'ptFusion', target: false }])
  joinSyncGroups('fusion', fusion, [
    { type: 'voi', id: 'ptFusion', source: false },
    { type: 'voi', id: 'ctWL', source: false },
  ])
  joinSyncGroups('ct', ct, [{ type: 'voi', id: 'ctWL' }])
  await pt.setVolume(0, { calMin: 0, calMax: 5 })
  expect(fusion.volumes[1]).toMatchObject({ calMin: 0, calMax: 5 })
  expect(fusion.volumes[0]).toMatchObject({ calMin: 0, calMax: 1 })
  await ct.setVolume(0, { calMin: -160, calMax: 240 })
  expect(fusion.volumes[0]).toMatchObject({ calMin: -160, calMax: 240 })
  await fusion.setVolume(1, { calMin: 1, calMax: 2 })
  expect(pt.volumes[0]).toMatchObject({ calMin: 0, calMax: 5 })
})

test('preclinical-4d groups: camera per orientation, VOI per ct/pt/fusion', async () => {
  const cam = (id: string) => ({ type: 'cameraPosition', id })
  const voi = (id: string, source = true) => ({ type: 'voi', id, source })
  const ctAx = pane('ctAx', ['CT'])
  const ctSag = pane('ctSag', ['CT'])
  const ptAx = pane('ptAx', ['PT'])
  const ptSag = pane('ptSag', ['PT'])
  const fuAx = pane('fuAx', ['CT', 'PT'])
  joinSyncGroups('ctAx', ctAx, [cam('axial'), voi('ctWL')])
  joinSyncGroups('ctSag', ctSag, [cam('sagittal'), voi('ctWL')])
  joinSyncGroups('ptAx', ptAx, [cam('axial'), voi('ptWL')])
  joinSyncGroups('ptSag', ptSag, [cam('sagittal'), voi('ptWL')])
  joinSyncGroups('fuAx', fuAx, [
    cam('axial'),
    voi('ctWL', false),
    voi('fusionWL'),
    voi('ptFusionWL', false),
  ])
  ctAx.pan2Dxyzmm = new Float32Array([5, 6, 7, 2])
  expect([...fuAx.pan2Dxyzmm]).toEqual([5, 6, 7, 2])
  expect([...ptAx.pan2Dxyzmm]).toEqual([5, 6, 7, 2])
  expect([...ctSag.pan2Dxyzmm]).toEqual([0, 0, 0, 1])
  await ctAx.setVolume(0, { calMin: -160, calMax: 240 })
  expect(fuAx.volumes[0]).toMatchObject({ calMin: -160, calMax: 240 })
  expect(ptAx.volumes[0]).toMatchObject({ calMin: 0, calMax: 1 })
  // As declared, no pane is a ptFusionWL source: PT reaches PT panes only.
  await ptAx.setVolume(0, { calMin: 0, calMax: 5 })
  expect(ptSag.volumes[0]).toMatchObject({ calMin: 0, calMax: 5 })
  expect(fuAx.volumes[1]).toMatchObject({ calMin: 0, calMax: 1 })
})
