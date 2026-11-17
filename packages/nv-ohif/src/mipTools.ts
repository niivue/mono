import type NiiVue from '@niivue/niivue'
import { SLICE_TYPE } from '@niivue/niivue'
import { useEffect } from 'react'
import type { OhifServicesManager } from './ohif-types'

// TMTV's MIP pane tools, as its tool group binds them (cornerstone tool
// names): VolumeRotateMouseWheel turns the camera, MIPJumpToClickTool
// (primary) sends the crosshair to the
// brightest voxel along the clicked ray (every pane follows through sync).

const WHEEL = 524288 // cornerstone MouseBindings.Wheel

type ToolGroup = {
  toolOptions?: Record<
    string,
    { mode?: string; bindings?: { mouseButton?: number }[] }
  >
  getToolConfiguration?: (tool: string, key?: string) => unknown
}
type Volume = {
  img?: ArrayLike<number> | null
  hdr?: { dims?: number[]; pixDims?: number[]; affine?: number[][] } | null
}

/** NiiVue's camera axis for azimuth/elevation (core sph2cartDeg). */
export function viewAxis(azimuth: number, elevation: number): number[] {
  const phi = (-elevation * Math.PI) / 180
  const theta = (((azimuth + 90) % 360) * Math.PI) / 180
  return [
    Math.cos(phi) * Math.cos(theta),
    Math.cos(phi) * Math.sin(theta),
    Math.sin(phi),
  ]
}

/**
 * The world (mm) centre of the brightest voxel on the line through `mm`
 * along `axis` (either way), as cornerstone's MipJumpToClick searches.
 */
export function brightestAlongRay(
  vol: Volume,
  mm: number[],
  axis: number[],
): number[] | undefined {
  const { img, hdr } = vol
  const A = hdr?.affine
  const [, nx = 0, ny = 0, nz = 0] = hdr?.dims ?? []
  if (!img || !A || !nx || !ny || !nz) return undefined
  const m = A.map((r) => r.slice(0, 3)) as number[][]
  const t = A.map((r) => r[3] ?? 0)
  const inv = invert3(m)
  if (!inv) return undefined
  // Half-voxel steps over the volume's diagonal on both sides of `mm`.
  const [, sx = 1, sy = 1, sz = 1] = hdr?.pixDims ?? []
  const step = Math.min(sx, sy, sz) / 2
  const reach = Math.hypot(nx * sx, ny * sy, nz * sz)
  let best = -Infinity
  let bestVox: number[] | undefined
  for (let s = -reach; s <= reach; s += step) {
    const d = [0, 1, 2].map(
      (k) => (mm[k] ?? 0) + s * (axis[k] ?? 0) - (t[k] ?? 0),
    )
    const [i, j, k] = [0, 1, 2].map((r) =>
      Math.round(
        (inv[r]?.[0] ?? 0) * (d[0] ?? 0) +
          (inv[r]?.[1] ?? 0) * (d[1] ?? 0) +
          (inv[r]?.[2] ?? 0) * (d[2] ?? 0),
      ),
    ) as [number, number, number]
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue
    const v = img[i + nx * (j + ny * k)] ?? -Infinity
    if (v > best) {
      best = v
      bestVox = [i, j, k]
    }
  }
  return bestVox?.map((_, r) =>
    (m[r] ?? []).reduce(
      (acc, c, q) => acc + c * (bestVox?.[q] ?? 0),
      t[r] ?? 0,
    ),
  )
}

function invert3(m: number[][]): number[][] | undefined {
  const [a = 0, b = 0, c = 0] = m[0] ?? []
  const [d = 0, e = 0, f = 0] = m[1] ?? []
  const [g = 0, h = 0, i = 0] = m[2] ?? []
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (!det) return undefined
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

/**
 * Wires the MIP tools on a 3D-render pane whose tool group binds them (read
 * per event: tool groups and the render mode can change after mount).
 */
export function useMipTools(
  nv: NiiVue | null,
  container: HTMLElement | null,
  toolGroupId: string,
  servicesManager: OhifServicesManager | undefined,
): void {
  useEffect(() => {
    if (!nv || !container) return
    const svc = (
      servicesManager as
        | {
            services?: {
              toolGroupService?: {
                getToolGroup?: (id: string) => ToolGroup | undefined
                getActivePrimaryMouseButtonTool?: (id: string) => string
              }
            }
          }
        | undefined
    )?.services?.toolGroupService
    const isRender = () => nv.sliceType === SLICE_TYPE.RENDER
    const onWheel = (e: WheelEvent) => {
      const group = svc?.getToolGroup?.(toolGroupId)
      const rotate = group?.toolOptions?.VolumeRotateMouseWheel
      if (
        !isRender() ||
        rotate?.mode !== 'Active' ||
        !rotate.bindings?.some((b) => b.mouseButton === WHEEL)
      )
        return
      e.preventDefault()
      e.stopPropagation()
      const degrees = Number(
        group?.getToolConfiguration?.(
          'VolumeRotateMouseWheel',
          'rotateIncrementDegrees',
        ) ?? 5,
      )
      nv.azimuth = (nv.azimuth + Math.sign(e.deltaY) * degrees + 360) % 360
    }
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
    }
    const onUp = async (e: PointerEvent) => {
      const click =
        down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4
      down = null
      const canvas = nv.canvas
      if (
        !click ||
        !canvas ||
        !isRender() ||
        svc?.getActivePrimaryMouseButtonTool?.(toolGroupId) !==
          'MIPJumpToClickTool'
      )
        return
      const rect = canvas.getBoundingClientRect()
      const scale = canvas.width / rect.width
      const hit = await nv.pickAt(
        (e.clientX - rect.left) * scale,
        (e.clientY - rect.top) * scale,
      )
      const mm =
        hit &&
        brightestAlongRay(
          nv.volumes[0] as Volume,
          hit,
          viewAxis(nv.azimuth, nv.elevation),
        )
      if (mm) nv.setCrosshairPos(mm as [number, number, number])
    }
    container.addEventListener('wheel', onWheel, {
      capture: true,
      passive: false,
    })
    container.addEventListener('pointerdown', onDown)
    container.addEventListener('pointerup', onUp)
    return () => {
      container.removeEventListener('wheel', onWheel, { capture: true })
      container.removeEventListener('pointerdown', onDown)
      container.removeEventListener('pointerup', onUp)
    }
  }, [nv, container, toolGroupId, servicesManager])
}
