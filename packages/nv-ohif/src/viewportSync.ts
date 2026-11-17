import type NiiVue from '@niivue/niivue'
import type { VolumeUpdatedDetail } from '@niivue/niivue'
import { windowFor } from './hangingOptions'
import { getNiivueEntry } from './niivueRegistry'

// OHIF hanging protocols link viewports through sync groups. NiiVue panes
// sharing any group (camera, VOI, segmentation) share the crosshair (in mm,
// core broadcastTo). A VOI group also carries the window, as cornerstone's
// voi synchronizer: from a source pane to target panes, onto the volume
// showing the same display set there (base or overlay). TMTV relies on both:
// a PT pane windows the fusion pane's PT overlay, never its CT base. A
// cameraPosition group also carries 2D pan/zoom (pan2Dxyzmm, in mm), as
// cornerstone's camera synchronizer (4D: one group per orientation).

type SyncGroup =
  | { type?: string; id?: string; source?: boolean; target?: boolean }
  | string
type Role = {
  voi: boolean
  camera: boolean
  source: boolean
  target: boolean
}

const members = new Map<string, { nv: NiiVue; groups: Map<string, Role> }>()
// Set while a window or camera is being copied: copies are not sources themselves.
let copying = false

// Members `kind`-linked from `viewportId` as source to target.
function linkedTargets(viewportId: string, kind: 'voi' | 'camera') {
  const from = members.get(viewportId)
  if (!from) return []
  return [...members].filter(
    ([id, to]) =>
      id !== viewportId &&
      [...from.groups].some(
        ([g, r]) => r[kind] && r.source && to.groups.get(g)?.target,
      ),
  )
}

function copyCamera(viewportId: string, nv: NiiVue): void {
  if (copying) return
  copying = true
  try {
    for (const [, to] of linkedTargets(viewportId, 'camera'))
      to.nv.pan2Dxyzmm = Float32Array.from(nv.pan2Dxyzmm)
  } finally {
    copying = false
  }
}

function rewire(): void {
  for (const [id, { nv, groups }] of members) {
    const peers = [...members]
      .filter(
        ([other, m]) =>
          other !== id && [...m.groups.keys()].some((g) => groups.has(g)),
      )
      .map(([, m]) => m.nv)
    if (peers.length) nv.broadcastTo(peers, { crosshair: true })
    else nv.broadcastTo()
  }
}

// The display set a pane's volume shows: the base at 0, else an overlay.
function volumeUid(viewportId: string, index: number): string | undefined {
  const entry = getNiivueEntry(viewportId)
  if (!entry) return undefined
  if (index === 0)
    return entry.displaySets[0]?.displaySetInstanceUID as string | undefined
  const hdr = entry.nv.volumes[index]?.hdr
  for (const [uid, h] of entry.overlays) if (h === hdr) return uid
  return undefined
}

function volumeIndex(viewportId: string, uid: string): number {
  const entry = getNiivueEntry(viewportId)
  if (!entry) return -1
  if (entry.displaySets[0]?.displaySetInstanceUID === uid) return 0
  const hdr = entry.overlays.get(uid)
  return hdr ? entry.nv.volumes.findIndex((v) => v.hdr === hdr) : -1
}

function copyWindow(viewportId: string, detail: VolumeUpdatedDetail): void {
  const { calMin, calMax } = detail.changes
  if (copying || (calMin === undefined && calMax === undefined)) return
  const uid = volumeUid(viewportId, detail.volumeIndex)
  if (!uid) return
  const shown = { calMin: detail.volume.calMin, calMax: detail.volume.calMax }
  copying = true
  try {
    for (const [id, to] of linkedTargets(viewportId, 'voi')) {
      const index = volumeIndex(id, uid)
      if (index < 0) continue
      const next = windowFor(
        to.nv.volumes[index]?.hdr,
        shown.calMin,
        shown.calMax,
      )
      void to.nv.setVolume(index, next).catch(() => {})
    }
  } finally {
    copying = false
  }
}

/** Join the sync groups in `syncGroups`; the returned function leaves them. */
export function joinSyncGroups(
  viewportId: string,
  nv: NiiVue,
  syncGroups: readonly SyncGroup[] | undefined,
): () => void {
  const groups = new Map<string, Role>()
  for (const g of syncGroups ?? []) {
    if (typeof g !== 'object' || !g?.id) continue
    groups.set(String(g.id), {
      voi: g.type === 'voi',
      camera: g.type === 'cameraPosition',
      source: g.source !== false,
      target: g.target !== false,
    })
  }
  if (groups.size === 0) return () => {}
  members.set(viewportId, { nv, groups })
  const onVolumeUpdated = (e: Event) =>
    copyWindow(viewportId, (e as CustomEvent<VolumeUpdatedDetail>).detail)
  const onChange = (e: Event) => {
    if (
      (e as CustomEvent<{ property?: string }>).detail?.property ===
      'pan2Dxyzmm'
    )
      copyCamera(viewportId, nv)
  }
  nv.addEventListener('volumeUpdated', onVolumeUpdated)
  nv.addEventListener('change', onChange)
  rewire()
  return () => {
    nv.removeEventListener('volumeUpdated', onVolumeUpdated)
    nv.removeEventListener('change', onChange)
    if (members.get(viewportId)?.nv !== nv) return
    members.delete(viewportId)
    nv.broadcastTo()
    rewire()
  }
}
