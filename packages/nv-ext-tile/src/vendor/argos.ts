// Argos AVS: a z-stack stores one full pyramid per focal plane, one after
// another in the main IFD chain; tag 65000 (Argos.Scan.Metadata XML) states
// MinZ/MaxZ. The single plane a viewer opens on is the middle one, which
// matches the unstacked scan's focus. Spec: scratch/vendor/argos-spec.md.

import { elementText } from './placement'

/** Private tag holding the Argos scan XML. */
export const ARGOS_TAG = 65000

export interface ArgosStack {
  /**
   * Main-chain image indices of each plane's pyramid, plane 0 first. Plane i
   * is focal step MinZ + i (units unstated); plane -MinZ is step 0.
   */
  planes: number[][]
  /** The plane opened by default (owner): the middle, usually the sharpest. */
  middle: number
  minZ: number
  maxZ: number
}

const num = (xml: string, tag: string) => Number(elementText(xml, `${tag}\\b`))

/**
 * The planes of an Argos z-stack from its XML and its main-chain images
 * (`tiled` false for strips, e.g. the macro and label), or null when the file
 * is not a stack or its images do not repeat once per plane.
 */
export function argosStack(
  xml: string,
  images: readonly { width: number; height: number; tiled: boolean }[],
): ArgosStack | null {
  if (!xml.includes('<Argos.Scan.Metadata>')) return null
  const minZ = num(xml, 'MinZ')
  const maxZ = num(xml, 'MaxZ')
  const n = maxZ - minZ + 1
  if (!(Number.isInteger(minZ) && Number.isInteger(maxZ) && n > 1)) return null
  const tiled = images.flatMap((im, i) => (im.tiled ? [i] : []))
  const per = tiled.length / n
  if (!Number.isInteger(per) || per < 1) return null
  const planes = Array.from({ length: n }, (_, p) =>
    tiled.slice(p * per, (p + 1) * per),
  )
  const shape = (ids: number[]) =>
    ids.map((i) => `${images[i]?.width}x${images[i]?.height}`).join()
  const first = shape(planes[0] as number[])
  if (planes.some((ids) => shape(ids) !== first)) return null
  return { planes, middle: Math.floor((n - 1) / 2), minZ, maxZ }
}
