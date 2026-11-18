import type NiiVue from '@niivue/niivue'
import { useEffect, useState } from 'react'
import {
  getActiveNiivueEntry,
  getNiivueEntry,
  type NiivueViewportEntry,
} from './niivueRegistry'
import type { OhifExtensionManager, OhifServicesManager } from './ohif-types'
import { toolMode } from './segEdit'

// OHIF's ReferenceLines (enabled by default in the basic modes, toggled by
// toggleEnabledDisabledToolbar on the pane's tool group): every other pane
// shows where the active pane's slice plane cuts it. NiiVue 2D tiles are world
// aligned, so the cut is a line of constant x, y or z across the tile.

type Vec3 = [number, number, number]
// World axis along each 2D tile's normal (axial z, coronal y, sagittal x).
const NORMAL_AXIS = [2, 1, 0]

/** The 2D tile of a single-plane pane (none for multiplanar, 3D or slides). */
function soleTile(nv: NiiVue) {
  const tiles = nv.view?.screenSlices ?? []
  return tiles.length === 1 && (tiles[0]?.axCorSag ?? 9) <= 2
    ? tiles[0]
    : undefined
}

/**
 * Ends (world mm) of the line where the plane `axis` = `at` cuts a tile of
 * orientation `axCorSag` at depth `depth`, spanning its screen bounds; none
 * when the planes are parallel.
 */
export function cutLine(
  axCorSag: number,
  depth: number,
  mnMM: ArrayLike<number>,
  mxMM: ArrayLike<number>,
  axis: number,
  at: number,
): [Vec3, Vec3] | undefined {
  const normal = NORMAL_AXIS[axCorSag] as number
  if (axis === normal) return undefined
  // The tile's screen axes, as core's slicePanUV: u then v.
  const u = axCorSag === 2 ? 1 : 0
  const v = axCorSag === 0 ? 1 : 2
  const along = axis === u ? v : u
  const [lo, hi] = along === u ? [mnMM[0], mxMM[0]] : [mnMM[1], mxMM[1]]
  const end = (t: number | undefined): Vec3 => {
    const p: Vec3 = [0, 0, 0]
    p[normal] = depth
    p[axis] = at
    p[along] = t ?? 0
    return p
  }
  return [end(lo), end(hi)]
}

function lineOn(
  entry: NiivueViewportEntry,
  active: NiivueViewportEntry,
): [number, number, number, number] | undefined {
  const tile = soleTile(entry.nv)
  const from = soleTile(active.nv)
  const at = active.crosshairMM
  const depthAt = entry.crosshairMM
  if (!tile?.screen || !from || !at || !depthAt) return undefined
  const axis = NORMAL_AXIS[from.axCorSag] as number
  const normal = NORMAL_AXIS[tile.axCorSag] as number
  const ends = cutLine(
    tile.axCorSag,
    depthAt[normal] ?? 0,
    tile.screen.mnMM,
    tile.screen.mxMM,
    axis,
    at[axis] ?? 0,
  )
  const a = ends && entry.nv.mmToCanvas(ends[0])
  const b = ends && entry.nv.mmToCanvas(ends[1])
  if (!a || !b) return undefined
  const dpr = entry.nv.effectiveDevicePixelRatio
  return [a.x / dpr, a.y / dpr, b.x / dpr, b.y / dpr]
}

export function ReferenceLines({
  viewportId,
  isLoaded,
  servicesManager,
  extensionManager,
}: {
  viewportId: string
  isLoaded: boolean
  servicesManager: OhifServicesManager | undefined
  extensionManager: OhifExtensionManager | undefined
}) {
  const [line, setLine] = useState<string>()
  // ponytail: polls each frame (a tool-mode read and a few multiplies);
  // events from every pane's camera, crosshair and tool group if it ever
  // shows in a profile.
  useEffect(() => {
    if (!isLoaded) return setLine(undefined)
    let raf = requestAnimationFrame(function poll() {
      raf = requestAnimationFrame(poll)
      const entry = getNiivueEntry(viewportId)
      const active = getActiveNiivueEntry(servicesManager)
      const on =
        entry &&
        toolMode(
          extensionManager,
          entry.toolGroupId ?? 'default',
          'ReferenceLines',
        ) === 'Enabled'
      const l =
        on && active && active !== entry
          ? lineOn(entry, active)?.join()
          : undefined
      setLine((prev) => (prev === l ? prev : l))
    })
    return () => cancelAnimationFrame(raf)
  }, [isLoaded, viewportId, servicesManager, extensionManager])
  if (!line) return null
  const [x1, y1, x2, y2] = line.split(',').map(Number)
  return (
    <svg
      data-reference-line={line}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      <title>Reference line</title>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgb(0, 200, 0)" />
    </svg>
  )
}
