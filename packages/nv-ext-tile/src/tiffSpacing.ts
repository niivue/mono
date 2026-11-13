// A TIFF slide's level-0 pixel size, from the first source that states it:
// vendor metadata, OME-XML, then the resolution tags. A recognised vendor
// never falls through to the tags, which slide writers fill with defaults.
import { omeLengthToMicrons } from '@niivue/niivue'
import { leicaRegions } from './vendor/leica'
import { philipsSpacingMM } from './vendor/philips'
import { attrs } from './vendor/placement'

export interface TiffSpacingTags {
  /** IFD0 ImageDescription. */
  description: string
  /** IFD0 XMP (tag 700): Ventana's iScan. */
  xmp?: string
  /** Level 0's XResolution, YResolution (pixels per unit) and ResolutionUnit. */
  xResolution?: number
  yResolution?: number
  resolutionUnit?: number
  /** Level 0's size as opened: picks the Leica region it shows. */
  width?: number
  height?: number
}

// A resolution tag coarser than this is a writer default (72/96/300 dpi,
// Generic-TIFF's 10 px/cm), not a scanner calibration: slide scanners stay
// near 0.1-2 um/px. ponytail: also drops a true calibration at 10 um/px or
// coarser (a flatbed scan); a per-writer allowlist would keep those.
const MAX_TAG_UM = 10

// TIFF 6.0 ResolutionUnit: 2 inch (the default), 3 cm; 1 has no unit.
const UNIT_UM: Record<number, number | undefined> = { 2: 25400, 3: 10000 }

/** [x, y] mm per level-0 pixel, or undefined when no source states it. */
export function tiffPixelSpacingMM(
  t: TiffSpacingTags,
): [number, number] | undefined {
  const um = (x: number, y = x): [number, number] | undefined =>
    x > 0 && y > 0 ? [x / 1000, y / 1000] : undefined
  const d = t.description
  if (d.startsWith('Aperio'))
    return um(Number(/\|\s*MPP\s*=\s*([\d.]+)/.exec(d)?.[1]))
  if (/<(?:\w+:)?OME\b/.test(d)) {
    const p = attrs(/<(?:\w+:)?Pixels\b[^>]*>/.exec(d)?.[0] ?? '')
    return um(
      omeLengthToMicrons(Number(p.PhysicalSizeX), p.PhysicalSizeXUnit),
      omeLengthToMicrons(Number(p.PhysicalSizeY), p.PhysicalSizeYUnit),
    )
  }
  if (d.includes('DPUfsImport')) return philipsSpacingMM(d)
  if (/<scn\b/.test(d)) {
    // View in nm over pixels, of the region level 0 shows; a size no region
    // has is the brightfield composition (placement). Regions that disagree
    // (beyond leicaComposition's 0.1%) leave level 0's size unknown.
    const all = leicaRegions(d) ?? []
    const shown = all.filter(
      (r) => r.width === t.width && r.height === t.height,
    )
    const regions = shown.length ? shown : all.filter((r) => r.brightfield)
    const nm = (r: (typeof regions)[number]): [number, number] => [
      r.view.width / r.width,
      r.view.height / r.height,
    ]
    const r = regions[0]
    if (!r) return undefined
    const [x, y] = nm(r)
    const near = (a: number, b: number) => Math.abs(a - b) <= b * 1e-3
    return regions.every((q) => {
      const [qx, qy] = nm(q)
      return near(qx, x) && near(qy, y)
    })
      ? um(x / 1000, y / 1000)
      : undefined
  }
  const scanRes = t.xmp && /<iScan\b[^>]*\bScanRes="([\d.]+)"/.exec(t.xmp)
  if (scanRes) return um(Number(scanRes[1]))
  const perUnit = UNIT_UM[t.resolutionUnit ?? 2]
  if (!perUnit || !t.xResolution || !t.yResolution) return undefined
  const x = perUnit / t.xResolution
  const y = perUnit / t.yResolution
  return x < MAX_TAG_UM && y < MAX_TAG_UM ? um(x, y) : undefined
}
