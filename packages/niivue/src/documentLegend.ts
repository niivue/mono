// v10 and earlier saved a per-volume and per-mesh `isLegendVisible` that the
// legend never read (it checked a `showLegend` nothing set) and that defaulted
// to false. Dropping it keeps those scenes showing their legends now that the
// flag works. Signal display options were saved whole, so their `showLegend`
// is renamed. Pure (no Vite imports), so it is unit-testable under Bun.

type UpgradableDocument = {
  version: number
  volumes?: { isLegendVisible?: boolean }[]
  meshes?: { isLegendVisible?: boolean }[]
  signals?: { display?: { isLegendVisible?: boolean; showLegend?: boolean } }[]
}

export function upgradeLegendFlags(doc: UpgradableDocument): void {
  if (doc.version > 10) return
  for (const v of doc.volumes ?? []) delete v.isLegendVisible
  for (const m of doc.meshes ?? []) delete m.isLegendVisible
  for (const s of doc.signals ?? []) {
    const d = s.display
    if (!d) continue // a hand-written document may omit it
    if (d.showLegend !== undefined) d.isLegendVisible = d.showLegend
    delete d.showLegend
  }
}
