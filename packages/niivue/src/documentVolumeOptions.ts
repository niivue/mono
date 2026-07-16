import type { NVDocumentVolume } from '@/NVDocument'
import type { ImageFromUrlOptions } from '@/NVTypes'

/**
 * Build the `addVolume` options for a URL-referenced document volume, forwarding
 * only the fields the document actually specifies.
 *
 * `reconstructVolume`'s URL branch passes these straight into `addVolume` ->
 * `prepareVolume`, whose `{ ...base, ...volumeDefaults, ...overrides }` merge
 * treats an explicit `undefined` as a value and overwrites what it spreads. So a
 * document that omits `calMin`/`calMax` (e.g. one authored before any viewer
 * computed them) would wipe the robust window `nii2volume` derived at load,
 * leaving the volume unrendered until a manual contrast reset. Dropping undefined
 * fields here lets those computed defaults survive — matching how the
 * embedded-data branch guards each field with `!== undefined`.
 *
 * Extracted as a standalone leaf for Bun-testability: `reconstructVolume`'s
 * module evaluates Vite's `import.meta.glob` transitively, which the Bun test
 * runner can't load. Uses `!== undefined` (not a truthy check) so legitimate
 * falsy values (`calMin: 0`, `opacity: 0`, `isColorbarVisible: false`) are kept.
 */
export function urlVolumeOptions(v: NVDocumentVolume): ImageFromUrlOptions {
  if (v.url === undefined) {
    throw new Error('urlVolumeOptions requires a document volume with a url')
  }
  const opts: ImageFromUrlOptions = { url: v.url }
  if (v.name !== undefined) opts.name = v.name
  if (v.colormap !== undefined) opts.colormap = v.colormap
  if (v.colormapNegative !== undefined)
    opts.colormapNegative = v.colormapNegative
  if (v.opacity !== undefined) opts.opacity = v.opacity
  if (v.calMin !== undefined) opts.calMin = v.calMin
  if (v.calMax !== undefined) opts.calMax = v.calMax
  if (v.calMinNeg !== undefined) opts.calMinNeg = v.calMinNeg
  if (v.calMaxNeg !== undefined) opts.calMaxNeg = v.calMaxNeg
  if (v.colormapType !== undefined) opts.colormapType = v.colormapType
  if (v.isTransparentBelowCalMin !== undefined) {
    opts.isTransparentBelowCalMin = v.isTransparentBelowCalMin
  }
  if (v.modulateAlpha !== undefined) opts.modulateAlpha = v.modulateAlpha
  if (v.isColorbarVisible !== undefined)
    opts.isColorbarVisible = v.isColorbarVisible
  return opts
}
