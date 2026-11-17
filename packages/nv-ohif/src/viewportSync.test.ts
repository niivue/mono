import { afterEach, expect, test } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { tileVisibleWindowMM } from '@niivue/niivue'
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
const pane = (id: string, uids: string[], tile?: object) => {
  const volumes = uids.map((uid) => ({ hdr: { uid }, calMin: 0, calMax: 1 }))
  const listeners: Record<string, ((e: Event) => void)[]> = {}
  const emit = (type: string, detail: unknown) => {
    for (const f of listeners[type] ?? []) f(new CustomEvent(type, { detail }))
  }
  let pan: Float32Array = new Float32Array([0, 0, 0, 1])
  const p = {
    targets: [] as unknown[],
    volumes,
    view: tile && { screenSlices: [tile] },
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
  // Axial tiles of D2's unequal fields of view (CT 486 x 0.12471 mm, PET
  // 112 x 0.4 mm, off-centre) on unequal panes, spans pre-zoom as core's.
  const axial = (mn: number[], mx: number[], px: number) => ({
    axCorSag: 0,
    leftTopWidthHeight: [0, 0, px, px],
    screen: { mnMM: mn, mxMM: mx },
  })
  const ctTile = axial([-30.3, -30.3], [30.3, 30.3], 400)
  const ptTile = axial([-20, -25], [24.8, 19.8], 300)
  const ctAx = pane('ctAx', ['CT'], ctTile)
  const ctSag = pane('ctSag', ['CT'])
  const ptAx = pane('ptAx', ['PT'], ptTile)
  const ptSag = pane('ptSag', ['PT'])
  const fuAx = pane('fuAx', ['CT', 'PT'], ctTile)
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
  // Same physical camera: world centre and mm per screen px.
  const view = (tile: typeof ctTile, nv: NiiVue) =>
    (tileVisibleWindowMM(tile as never, nv.pan2Dxyzmm) ?? [])
      .slice(0, 2)
      .flatMap((w) => [
        ((w?.minMM ?? 0) + (w?.maxMM ?? 0)) / 2,
        ((w?.maxMM ?? 0) - (w?.minMM ?? 0)) / (tile.leftTopWidthHeight[2] ?? 1),
      ])
  const ct = view(ctTile, ctAx)
  for (const [tile, nv] of [
    [ptTile, ptAx],
    [ctTile, fuAx],
  ] as const)
    for (const [i, x] of view(tile, nv).entries())
      expect(x).toBeCloseTo(ct[i] ?? Number.NaN, 5)
  expect([...ctSag.pan2Dxyzmm]).toEqual([0, 0, 0, 1])
  await ctAx.setVolume(0, { calMin: -160, calMax: 240 })
  expect(fuAx.volumes[0]).toMatchObject({ calMin: -160, calMax: 240 })
  expect(ptAx.volumes[0]).toMatchObject({ calMin: 0, calMax: 1 })
  // As declared, no pane is a ptFusionWL source: PT reaches PT panes only.
  await ptAx.setVolume(0, { calMin: 0, calMax: 5 })
  expect(ptSag.volumes[0]).toMatchObject({ calMin: 0, calMax: 5 })
  expect(fuAx.volumes[1]).toMatchObject({ calMin: 0, calMax: 1 })
})
