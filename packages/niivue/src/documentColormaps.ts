// Colormaps in NVD documents. From v10 a volume names its colormap and the
// document embeds the definition of every colormap registered at runtime
// (`colormaps`). v9 and earlier embedded a compiled label LUT per volume and
// used `_`-prefixed drawing colormap names; `upgradeColormaps` converts those.
// Pure (no Vite imports), so it is unit-testable under Bun.

import type { ColorMap } from '@/NVTypes'

/** A v9 compiled label LUT: dense RGBA over IDs min..max. */
export type LegacyLabelLut = {
  lut: Uint8Array
  min: number
  max: number
  labels?: string[]
}

type UpgradableDocument = {
  version: number
  colormaps?: Record<string, ColorMap>
  draw?: { colormap?: string }
  volumes?: {
    name?: string
    colormap?: string
    colormapNegative?: string
    colormapLabel?: LegacyLabelLut
  }[]
}

// v9 drawing colormaps were hidden from colormapNames() by a `_` prefix.
const RENAMED: Record<string, string> = {
  _draw: 'Draw',
  _itksnap: 'Itksnap',
  _slicer3d: 'Slicer3d',
}

function renamed(name: string | undefined): string | undefined {
  return name === undefined ? undefined : (RENAMED[name] ?? name)
}

/** Rebuild a label colormap from a compiled LUT, one entry per ID. */
export function labelLutToColormap(lut: LegacyLabelLut): ColorMap {
  const n = lut.lut.length / 4
  const cm: ColorMap = { R: [], G: [], B: [], A: [], I: [], labels: [] }
  for (let i = 0; i < n; i++) {
    cm.R.push(lut.lut[4 * i])
    cm.G.push(lut.lut[4 * i + 1])
    cm.B.push(lut.lut[4 * i + 2])
    cm.A.push(lut.lut[4 * i + 3])
    cm.I.push(lut.min + i)
  }
  if (lut.labels?.length === n) cm.labels = lut.labels.slice()
  return cm
}

/**
 * Bring a v9-or-earlier document to the v10 colormap model in place: each
 * embedded label LUT becomes a document colormap that the volume names, and
 * `_`-prefixed drawing colormap names lose the prefix. `isTaken` says whether
 * a name is already registered with other colours, which must not be
 * replaced; the same table loaded again keeps its name.
 */
export function upgradeColormaps(
  doc: UpgradableDocument,
  isTaken: (name: string, cm: ColorMap) => boolean = () => false,
): void {
  if (doc.version > 9) return
  if (doc.draw?.colormap !== undefined)
    doc.draw.colormap = renamed(doc.draw.colormap)
  const colormaps = doc.colormaps ?? {}
  for (const v of doc.volumes ?? []) {
    v.colormap = renamed(v.colormap)
    v.colormapNegative = renamed(v.colormapNegative)
    if (!v.colormapLabel) continue
    const stem = (v.name ?? 'volume').replace(/\.[^/]*$/, '')
    const base = `${stem.charAt(0).toUpperCase()}${stem.slice(1)} labels`
    let name = base
    const cm = labelLutToColormap(v.colormapLabel)
    for (let k = 2; name in colormaps || isTaken(name, cm); k++)
      name = `${base} ${k}`
    colormaps[name] = cm
    v.colormap = name
    delete v.colormapLabel
  }
  if (Object.keys(colormaps).length > 0) doc.colormaps = colormaps
}
