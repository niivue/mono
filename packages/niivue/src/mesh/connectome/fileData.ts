import type {
  NVConnectomeData,
  NVConnectomeEdge,
  NVConnectomeNode,
  NVConnectomeOptions,
} from '@/NVTypes'

// Shared by the connectome readers and `index.ts`. Kept out of `index.ts` so a
// reader never imports the module that registers it (`index.ts` builds its
// reader map from `readers/_registry.ts` at load time).

/** Raw parsed connectome file — includes both data and default display options from the file. */
export type ConnectomeFileData = {
  data: NVConnectomeData
  options: Partial<NVConnectomeOptions>
}

export const defaultConnectomeOptions: NVConnectomeOptions = {
  nodeColormap: 'warm',
  nodeColormapNegative: '',
  nodeMinColor: 0,
  nodeMaxColor: 0,
  nodeScale: 3,
  edgeColormap: 'warm',
  edgeColormapNegative: '',
  edgeMin: 0,
  edgeMax: 0,
  edgeScale: 1,
}

/**
 * Convert a dense (legacy) connectome format to sparse NVConnectomeData.
 * Dense format stores edges as a flattened NxN upper-triangular matrix.
 */
export function convertDenseToSparse(
  nodesObj: {
    names: string[]
    X: number[]
    Y: number[]
    Z: number[]
    Color: number[]
    Size: number[]
  },
  edgesFlat: number[],
): { data: NVConnectomeData } {
  const n = nodesObj.names.length
  const nodes: NVConnectomeNode[] = []
  for (let i = 0; i < n; i++) {
    nodes.push({
      name: nodesObj.names[i],
      x: nodesObj.X[i],
      y: nodesObj.Y[i],
      z: nodesObj.Z[i],
      colorValue: nodesObj.Color[i],
      sizeValue: nodesObj.Size[i],
    })
  }
  const edges: NVConnectomeEdge[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const val = edgesFlat[i * n + j]
      if (val !== 0) {
        edges.push({ first: i, second: j, colorValue: val })
      }
    }
  }
  return { data: { nodes, edges } }
}
