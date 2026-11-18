import type NiiVue from '@niivue/niivue'
import type { VolumeUpdatedDetail } from '@niivue/niivue'
import { getNiivueEntry } from './niivueRegistry'

// OHIF hanging protocols link viewports through sync groups. NiiVue panes
// sharing a camera or VOI group share the crosshair (in mm,
// core broadcastTo). A VOI group also carries the window, as cornerstone's
// voi synchronizer: from a source pane to target panes, onto the volume
// showing the same display set there (base or overlay). TMTV relies on both:
// a PT pane windows the fusion pane's PT overlay, never its CT base. A
// cameraPosition group also carries 2D pan/zoom (pan2Dxyzmm, in mm), as
// cornerstone's camera synchronizer (4D: one group per orientation).

type SyncGroup =
  | { type?: string; id?: string; source?: boolean; target?: boolean }
  | string
// hydrateseg only links segmentations: OHIF puts it on every pane of a layout,
// across frames of reference, so it carries no crosshair.
type Role = {
  voi: boolean
  camera: boolean
  crosshair: boolean
  source: boolean
  target: boolean
}

const members = new Map<string, { nv: NiiVue; groups: Map<string, Role> }>()
// OHIF's ImageSliceSync (toggleSynchronizer type imageSlice): every
// reconstructable pane shares the crosshair, so stacks show the same position.
let isSliceSync = false
const isReconstructable = (id: string) => {
  const ds = getNiivueEntry(id)?.displaySets[0]
  return !!ds && ds.isReconstructable !== false
}
// Set while a window or camera is being copied: copies are not sources themselves.
let copying = false

// Members `kind`-linked from `viewportId` as source to target.
function linkedTargets(viewportId: string, kind: 'voi' | 'camera') {
  const from = members.get(viewportId)
  if (!from) return []
  return [...members].filter(
    ([id, to]) =>
      id !== viewportId &&
      [...from.groups].some(([g, r]) => {
        const t = to.groups.get(g)
        return r[kind] && r.source && t?.[kind] && t.target
      }),
  )
}

// A pane's 2D camera frame on its `axCorSag` tile (first 2D tile when
// undefined): world axes of screen U, V (as core's slicePanUV), their unzoomed
// centres (mm) and unzoomed mm per screen px (geometric mean: rotation-invariant).
function frameOf(nv: NiiVue, axCorSag?: number) {
  const t = nv.view?.screenSlices.find(
    (t) =>
      t.space !== 'global3d' &&
      t.axCorSag <= 2 &&
      t.axCorSag === (axCorSag ?? t.axCorSag),
  )
  const [u0 = 0, v0 = 0] = t?.screen?.mnMM ?? []
  const [u1 = 0, v1 = 0] = t?.screen?.mxMM ?? []
  const [, , w = 0, h = 0] = t?.leftTopWidthHeight ?? []
  const mmPerPx = Math.sqrt(Math.abs(((u1 - u0) * (v1 - v0)) / (w * h)))
  if (!t || !(mmPerPx > 0 && mmPerPx < Infinity)) return undefined
  return {
    axCorSag: t.axCorSag,
    u: t.axCorSag === 2 ? 1 : 0,
    v: t.axCorSag === 0 ? 1 : 2,
    mid: [(u0 + u1) / 2, (v0 + v1) / 2] as const,
    mmPerPx,
  }
}

// pan2Dxyzmm is relative to each pane's fitted bounds (pan from their centre,
// zoom of their span), so copy the physical camera as cornerstone does: the
// world centre (bounds centre - pan) and mm per screen px.
function copyCamera(viewportId: string, nv: NiiVue): void {
  if (copying) return
  copying = true
  try {
    const [x = 0, y = 0, z = 0, zoom = 1] = nv.pan2Dxyzmm
    const from = frameOf(nv)
    for (const [, to] of linkedTargets(viewportId, 'camera')) {
      const into = from && frameOf(to.nv, from.axCorSag)
      if (!from || !into) {
        to.nv.pan2Dxyzmm = Float32Array.from(nv.pan2Dxyzmm)
        continue
      }
      const shift = [0, 0, 0]
      shift[from.u] = into.mid[0] - from.mid[0]
      shift[from.v] = into.mid[1] - from.mid[1]
      const [dx = 0, dy = 0, dz = 0] = shift
      const scale = into.mmPerPx / from.mmPerPx
      to.nv.pan2Dxyzmm = new Float32Array([
        x + dx,
        y + dy,
        z + dz,
        zoom * scale,
      ])
    }
  } finally {
    copying = false
  }
}

function rewire(): void {
  for (const [id, { nv, groups }] of members) {
    const peers = [...members]
      .filter(
        ([other, m]) =>
          other !== id &&
          ((isSliceSync && isReconstructable(id) && isReconstructable(other)) ||
            [...m.groups].some(
              ([g, r]) => r.crosshair && groups.get(g)?.crosshair,
            )),
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
      void to.nv.setVolume(index, shown).catch(() => {})
    }
  } finally {
    copying = false
  }
}

/** Toggle ImageSliceSync across NiiVue panes; returns the new state. */
export function toggleSliceSync(): boolean {
  isSliceSync = !isSliceSync
  rewire()
  return isSliceSync
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
      crosshair: g.type !== 'hydrateseg',
      source: g.source !== false,
      target: g.target !== false,
    })
  }
  // Panes without groups still join: ImageSliceSync links them.
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
