import type { NVDocumentMeshLayer } from './NVDocument'
import type { MeshLayerFromUrlOptions } from './NVTypes'

/**
 * Select the scalar-overlay layers of a URL-referenced document mesh that can
 * be reloaded on the URL path.
 *
 * When `reconstructMesh` restores a mesh from a URL (rather than embedded
 * geometry), layers are loaded via `loadLayersFromOptions`, which fetches each
 * layer by its URL. Layers that carry only embedded data (no URL) belong to
 * embedded meshes and cannot be reloaded here, so they are dropped. The filter
 * also narrows the optional `url` to a required `string`, matching
 * `MeshLayerFromUrlOptions`.
 *
 * Extracted as a pure function because the document-reconstruction module is
 * not unit-testable under the bun test runner (its transitive imports evaluate
 * Vite's `import.meta.glob`).
 */
export function selectUrlMeshLayers(
  layers?: NVDocumentMeshLayer[],
): MeshLayerFromUrlOptions[] | undefined {
  return layers?.filter(
    (layer): layer is NVDocumentMeshLayer & { url: string } =>
      typeof layer.url === 'string',
  )
}
