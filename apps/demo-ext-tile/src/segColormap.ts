import {
  type OmeZarrInfo,
  omeZarrLabelColormap,
} from '@niivue/nv-ext-tile/zarr'

/**
 * A segmentation's label colormap and a name unique to this addition (`segId`):
 * core replaces a table registered under a name already in use, so two stores
 * named alike would otherwise recolour each other. Null without colours.
 */
export function segmentationColormap(info: OmeZarrInfo, segId: string) {
  const map = omeZarrLabelColormap(info)
  return map
    ? { name: `${info.name ?? 'segmentation'} labels (${segId})`, map }
    : null
}
