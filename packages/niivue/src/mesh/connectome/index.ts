import * as NVCmaps from "@/cmap/NVCmaps"
import { createCylinder, createSphere } from "@/mesh/NVShapes"
import * as NVLoader from "@/NVLoader"
import type {
  NVConnectomeData,
  NVConnectomeEdge,
  NVConnectomeNode,
  NVConnectomeOptions,
} from "@/NVTypes"

type ConnectomeReader = {
  extensions?: string[]
  read: (buffer: ArrayBufferLike) => Promise<ConnectomeFileData>
}

/** Raw parsed connectome file — includes both data and default display options from the file. */
export type ConnectomeFileData = {
  data: NVConnectomeData
  options: Partial<NVConnectomeOptions>
}

const modules = import.meta.glob<ConnectomeReader>("./readers/*.ts", {
  eager: true,
})
const readerByExt = NVLoader.buildExtensionMap(modules)

export function connectomeExtensions(): string[] {
  return Array.from(readerByExt.keys()).sort()
}

export function isConnectomeExtension(ext: string): boolean {
  return readerByExt.has(ext.toUpperCase())
}

export function getConnectomeReader(ext: string): ConnectomeReader | undefined {
  return readerByExt.get(ext.toUpperCase())
}

export const defaultConnectomeOptions: NVConnectomeOptions = {
  nodeColormap: "warm",
  nodeColormapNegative: "",
  nodeMinColor: 0,
  nodeMaxColor: 0,
  nodeScale: 3,
  edgeColormap: "warm",
  edgeColormapNegative: "",
  edgeMin: 0,
  edgeMax: 0,
  edgeScale: 1,
}

export type ExtrusionResult = {
  positions: Float32Array
  indices: Uint32Array
  colors: Uint32Array
}

/**
 * Extrude connectome nodes into spheres and edges into cylinders.
 * Pure function: source data + options in, GPU-ready buffers out.
 */
export function extrude(
  data: NVConnectomeData,
  options: NVConnectomeOptions,
): ExtrusionResult {
  const { nodes, edges } = data

  if (nodes.length === 0) {
    return {
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      colors: new Uint32Array(0),
    }
  }

  // Build LUTs for colormapping
  const nodeLut = NVCmaps.lutrgba8(options.nodeColormap)
  const nodeLutNeg = options.nodeColormapNegative
    ? NVCmaps.lutrgba8(options.nodeColormapNegative)
    : null
  const edgeLut = NVCmaps.lutrgba8(options.edgeColormap)
  const edgeLutNeg = options.edgeColormapNegative
    ? NVCmaps.lutrgba8(options.edgeColormapNegative)
    : null

  // Collect all geometry parts
  const allPositions: number[][] = []
  const allIndices: number[][] = []
  const allColors: number[] = []
  let vertexCount = 0

  // Generate spheres for nodes
  for (const node of nodes) {
    const radius = Math.abs(node.sizeValue) * options.nodeScale
    if (radius <= 0) continue
    const color = colormapLookup(
      node.colorValue,
      options.nodeMinColor,
      options.nodeMaxColor,
      nodeLut,
      nodeLutNeg,
    )
    const sphere = createSphere([node.x, node.y, node.z], radius, color, 2)
    // Offset indices
    const offsetIndices = sphere.indices.map((i) => i + vertexCount)
    allPositions.push(sphere.positions)
    allIndices.push(offsetIndices)
    // Fill colors for all vertices
    const nVerts = sphere.positions.length / 3
    for (let i = 0; i < nVerts; i++) allColors.push(sphere.rgba32)
    vertexCount += nVerts
  }

  // Generate cylinders for edges
  for (const edge of edges) {
    const absVal = Math.abs(edge.colorValue)
    if (absVal < options.edgeMin) continue
    if (options.edgeMax > 0 && absVal > options.edgeMax) continue
    const nodeA = nodes[edge.first]
    const nodeB = nodes[edge.second]
    if (!nodeA || !nodeB) continue
    const radius = absVal * options.edgeScale
    if (radius <= 0) continue
    const color = colormapLookup(
      edge.colorValue,
      options.edgeMin,
      options.edgeMax,
      edgeLut,
      edgeLutNeg,
    )
    const cylinder = createCylinder(
      [nodeA.x, nodeA.y, nodeA.z],
      [nodeB.x, nodeB.y, nodeB.z],
      radius,
      color,
      20,
      true,
    )
    const offsetIndices = cylinder.indices.map((i) => i + vertexCount)
    allPositions.push(cylinder.positions)
    allIndices.push(offsetIndices)
    const nVerts = cylinder.positions.length / 3
    for (let i = 0; i < nVerts; i++) allColors.push(cylinder.rgba32)
    vertexCount += nVerts
  }

  // Flatten into typed arrays
  const positions = new Float32Array(vertexCount * 3)
  let posOffset = 0
  for (const p of allPositions) {
    for (let i = 0; i < p.length; i++) {
      positions[posOffset++] = p[i]
    }
  }

  let totalIndices = 0
  for (const idx of allIndices) totalIndices += idx.length
  const indices = new Uint32Array(totalIndices)
  let idxOffset = 0
  for (const idx of allIndices) {
    for (let i = 0; i < idx.length; i++) {
      indices[idxOffset++] = idx[i]
    }
  }

  const colors = new Uint32Array(allColors)

  return { positions, indices, colors }
}

/**
 * Map a scalar value through a colormap LUT, returning [r,g,b,a] in 0-1 range.
 * Supports positive and negative colormaps.
 */
export function colormapLookup(
  value: number,
  min: number,
  max: number,
  lut: Uint8ClampedArray,
  lutNeg: Uint8ClampedArray | null,
): [number, number, number, number] {
  const absVal = Math.abs(value)
  const activeLut = value < 0 && lutNeg ? lutNeg : lut
  const range = max - min
  const f = range > 0 ? Math.max(0, Math.min(1, (absVal - min) / range)) : 0
  const nColors = activeLut.length / 4
  const idx = Math.min(nColors - 1, Math.floor(f * (nColors - 1))) * 4
  return [
    activeLut[idx] / 255,
    activeLut[idx + 1] / 255,
    activeLut[idx + 2] / 255,
    activeLut[idx + 3] / 255,
  ]
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
