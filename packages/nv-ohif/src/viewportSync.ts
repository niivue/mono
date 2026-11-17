import type NiiVue from '@niivue/niivue'

// OHIF hanging protocols link viewports through sync groups. NiiVue panes in
// the same VOI group ('mpr' in MPR layouts) share the crosshair position (in
// mm) and the base window, through core broadcastTo. A pane outside every VOI
// group (a 3D pane with its own preset window) stays independent.

type SyncGroup = { type?: string; id?: string } | string

const members = new Map<string, { nv: NiiVue; groups: Set<string> }>()

const SYNC = { crosshair: true, calMin: true, calMax: true }

function rewire(): void {
  for (const [id, { nv, groups }] of members) {
    const peers = [...members]
      .filter(
        ([other, m]) =>
          other !== id && [...m.groups].some((g) => groups.has(g)),
      )
      .map(([, m]) => m.nv)
    if (peers.length) nv.broadcastTo(peers, SYNC)
    else nv.broadcastTo()
  }
}

/** Join the VOI sync groups in `syncGroups`; the returned function leaves them. */
export function joinSyncGroups(
  viewportId: string,
  nv: NiiVue,
  syncGroups: readonly SyncGroup[] | undefined,
): () => void {
  const groups = new Set(
    (syncGroups ?? [])
      .filter(
        (g): g is { type?: string; id?: string } =>
          typeof g === 'object' && g?.type === 'voi',
      )
      .map((g) => String(g.id)),
  )
  if (groups.size === 0) return () => {}
  members.set(viewportId, { nv, groups })
  rewire()
  return () => {
    if (members.get(viewportId)?.nv !== nv) return
    members.delete(viewportId)
    nv.broadcastTo()
    rewire()
  }
}
