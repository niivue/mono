import { vec3 } from 'gl-matrix'
import { maybeDecompress } from '@/codecs/NVGz'
import { log } from '@/logger'
import * as NVLoader from '@/NVLoader'
import type {
  LUT,
  MeshFromUrlOptions,
  MeshKind,
  MZ3,
  NVConnectomeOptions,
  NVMeshLayer,
  NVMesh as NVMeshType,
  NVTractData,
  NVTractOptions,
} from '@/NVTypes'
import {
  connectomeExtensions,
  defaultConnectomeOptions,
  extrude,
  getConnectomeReader,
  isConnectomeExtension,
} from './connectome'
import {
  compositeLayers,
  computeMeshLabelCentroids,
  createLayer,
  layerExtensions,
  loadLayerFromUrl,
  loadLayersFromOptions,
} from './layers'
import { probeVTKContent, readVTKLines } from './readers/vtk'
import {
  computeAllScalarMeta,
  defaultTractOptions,
  getTractReader,
  isTractExtension,
  tessellate,
  tractExtensions,
} from './tracts'
import { loadTractScalars } from './tracts/scalars'
import * as meshWriters from './writers'
import { writeMesh } from './writers'

export {
  compositeLayers,
  connectomeExtensions,
  createLayer,
  isConnectomeExtension,
  isTractExtension,
  layerExtensions,
  loadLayerFromUrl,
  tractExtensions,
}

type MeshReader = {
  extensions?: string[]
  read: (buffer: ArrayBufferLike) => Promise<MZ3>
}

const modules = import.meta.glob<MeshReader>('./readers/*.ts', { eager: true })
const readerByExt = NVLoader.buildExtensionMap(modules)

export function meshWriteExtensions(): string[] {
  return meshWriters.writeExtensions()
}

export { writeMesh }

/** All supported mesh-family extensions (triangulated mesh + tract + connectome). */
export function meshExtensions(): string[] {
  return [
    ...Array.from(readerByExt.keys()),
    ...tractExtensions(),
    ...connectomeExtensions(),
  ].sort()
}

export function registerExternalReader(
  fromExt: string,
  toExt: string,
  converter: (
    buffer: ArrayBuffer,
  ) => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>,
): void {
  const targetReader = readerByExt.get(toExt.toUpperCase())
  if (!targetReader) {
    throw new Error(`No built-in mesh reader for target format "${toExt}"`)
  }
  const wrappedReader: MeshReader = {
    extensions: [fromExt.toUpperCase()],
    read: async (buffer) => {
      const converted = await converter(buffer as ArrayBuffer)
      const ab =
        converted instanceof ArrayBuffer
          ? converted
          : (new Uint8Array(converted).buffer as ArrayBuffer)
      return targetReader.read(ab)
    },
  }
  readerByExt.set(fromExt.toUpperCase(), wrappedReader)
}

export function generateNormals(
  pts: Float32Array,
  tris: Uint32Array,
): Float32Array {
  const norms = new Float32Array(pts.length)
  for (let i = 0; i < tris.length; i += 3) {
    const i1 = tris[i] * 3
    const i2 = tris[i + 1] * 3
    const i3 = tris[i + 2] * 3
    const v1 = [pts[i1], pts[i1 + 1], pts[i1 + 2]]
    const v2 = [pts[i2], pts[i2 + 1], pts[i2 + 2]]
    const v3 = [pts[i3], pts[i3 + 1], pts[i3 + 2]]
    const q = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]]
    const p = [v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2]]
    const n = [
      p[1] * q[2] - p[2] * q[1],
      p[2] * q[0] - p[0] * q[2],
      p[0] * q[1] - p[1] * q[0],
    ]
    for (const index of [i1, i2, i3]) {
      norms[index] += n[0]
      norms[index + 1] += n[1]
      norms[index + 2] += n[2]
    }
  }
  for (let i = 0; i < norms.length; i += 3) {
    const len = Math.sqrt(norms[i] ** 2 + norms[i + 1] ** 2 + norms[i + 2] ** 2)
    if (len > 0) {
      norms[i] /= -len
      norms[i + 1] /= -len
      norms[i + 2] /= -len
    }
  }
  return norms
}

export function createMesh(
  positions: Float32Array,
  indices: Uint32Array,
  colors: Uint32Array,
  options: Record<string, unknown> = {},
): NVMeshType {
  const kind = (options.kind ?? 'mesh') as MeshKind
  const defaults = {
    kind,
    shaderType: 'phong',
    opacity: 1.0,
    color: [1, 1, 1, 1] as [number, number, number, number],
    isColorbarVisible: false,
    isLegendVisible: false,
    layers: [] as NVMeshLayer[],
    perVertexColors: null as Uint32Array | null,
    mz3: kind === 'mesh' ? { positions, indices } : null,
    trx: null,
    jcon: null,
    tractOptions: null,
    connectomeOptions: null,
  }
  const opts = { ...defaults, ...options }
  const numVerts = positions.length / 3
  const mn = vec3.fromValues(Infinity, Infinity, Infinity)
  const mx = vec3.fromValues(-Infinity, -Infinity, -Infinity)
  for (let i = 0; i < numVerts; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]
    mn[0] = Math.min(mn[0], x)
    mn[1] = Math.min(mn[1], y)
    mn[2] = Math.min(mn[2], z)
    mx[0] = Math.max(mx[0], x)
    mx[1] = Math.max(mx[1], y)
    mx[2] = Math.max(mx[2], z)
  }
  return {
    positions,
    indices,
    colors,
    extentsMin: mn,
    extentsMax: mx,
    clipPlane: new Float32Array([0.0, 0.0, 0.0, 0.0]),
    ...opts,
  } as NVMeshType
}

export async function loadMesh(mesh: MeshFromUrlOptions): Promise<NVMeshType> {
  const ext = NVLoader.getFileExt(mesh.url)

  // Dispatch to tract loading
  if (isTractExtension(ext)) {
    return loadTract(mesh, ext)
  }
  // Dispatch to connectome loading
  if (isConnectomeExtension(ext)) {
    return loadConnectome(mesh, ext)
  }

  // VTK content-based dispatch: same .vtk extension can be mesh or tract
  let prefetchedBuffer: ArrayBuffer | null = null
  if (ext === 'VTK') {
    const rawBuffer = await NVLoader.fetchFile(mesh.url)
    const buffer = await maybeDecompress(rawBuffer)
    if (probeVTKContent(buffer) === 'tract') {
      const tractData = readVTKLines(buffer)
      return buildTractMesh(mesh, tractData)
    }
    prefetchedBuffer = buffer // reuse for mesh path, avoid double fetch
  }

  // --- Triangulated mesh loading (existing path) ---
  const {
    url,
    rgba255,
    color: colorInput,
    layers: layerOptions,
    ...restOptions
  } = mesh
  // Convert rgba255 to color if provided, otherwise use color or default
  let color: [number, number, number, number] = [1, 1, 1, 1]
  if (rgba255) {
    color = [
      Math.min(1, Math.max(0, rgba255[0] / 255)),
      Math.min(1, Math.max(0, rgba255[1] / 255)),
      Math.min(1, Math.max(0, rgba255[2] / 255)),
      Math.min(1, Math.max(0, rgba255[3] / 255)),
    ]
  } else if (colorInput) {
    color = [
      Math.min(1, Math.max(0, colorInput[0])),
      Math.min(1, Math.max(0, colorInput[1])),
      Math.min(1, Math.max(0, colorInput[2])),
      Math.min(1, Math.max(0, colorInput[3])),
    ]
  }
  const result = prefetchedBuffer ?? (await NVLoader.fetchFile(url))
  let reader = readerByExt.get(ext)
  if (!reader || typeof reader.read !== 'function') {
    log.warn(`Unsupported mesh format "${ext}", falling back to MZ3 reader`)
    reader = readerByExt.get('MZ3')
  }
  if (!reader) {
    throw new Error(`No mesh reader available for extension ${ext}`)
  }
  const meshData = await reader.read(result)
  if (!meshData.positions || !meshData.indices) {
    throw new Error('Mesh reader did not return positions/indices')
  }
  const numVerts = meshData.positions.length / 3
  const packedColors = new Uint32Array(numVerts)
  let perVertexColors: Uint32Array | null = null
  const a = Math.round(color[3] * 255)
  if (meshData.colors) {
    // Pack per-vertex colors from mesh file
    for (let i = 0; i < numVerts; i++) {
      const r = Math.round(meshData.colors[i * 3] * 255)
      const g = Math.round(meshData.colors[i * 3 + 1] * 255)
      const b = Math.round(meshData.colors[i * 3 + 2] * 255)
      packedColors[i] = (a << 24) | (b << 16) | (g << 8) | r
    }
    perVertexColors = packedColors.slice()
  } else {
    // Fill with uniform color from options
    const packed =
      (a << 24) |
      (Math.round(color[2] * 255) << 16) |
      (Math.round(color[1] * 255) << 8) |
      Math.round(color[0] * 255)
    packedColors.fill(packed)
  }

  // Build layers from reader scalars and/or user-provided layer options
  const layers: NVMeshLayer[] = []

  // Auto-create layer from inline scalars returned by the mesh reader
  if (meshData.scalars && meshData.scalars.length > 0) {
    const nFrame = Math.max(1, Math.floor(meshData.scalars.length / numVerts))
    layers.push(
      createLayer(meshData.scalars, numVerts, {
        nFrame4D: nFrame,
        colormap: 'warm',
        opacity: 1.0,
        isColorbarVisible: true,
        colormapLabel: (meshData.colormapLabel as LUT) ?? null,
      }),
    )
  }

  // Load external layer files if specified
  if (layerOptions && layerOptions.length > 0) {
    const externalLayers = await loadLayersFromOptions(layerOptions, numVerts)
    layers.push(...externalLayers)
  }

  // Compute label centroids for layers with label colormaps
  for (const layer of layers) {
    if (layer.colormapLabel) {
      layer.colormapLabel.centroids = computeMeshLabelCentroids(
        meshData.positions,
        layer,
      )
    }
  }

  // Composite layers over base colors
  if (layers.length > 0) {
    compositeLayers(perVertexColors, color, layers, packedColors)
  }

  // Build mesh options, storing color (not rgba255)
  const urlString = typeof url === 'string' ? url : url.name
  const opts = {
    ...restOptions,
    color,
    url: urlString,
    name: restOptions.name ?? urlString,
    layers,
    perVertexColors,
  }
  return createMesh(meshData.positions, meshData.indices, packedColors, opts)
}

/**
 * Build a tract mesh from pre-parsed NVTractData and mesh options.
 * Shared by loadTract() (format-specific readers) and VTK LINES dispatch.
 */
async function buildTractMesh(
  mesh: MeshFromUrlOptions,
  tractData: NVTractData,
): Promise<NVMeshType> {
  // Load tract scalar layers (TSF → dpv, TXT → dps)
  if (mesh.layers && mesh.layers.length > 0) {
    await loadTractScalars(tractData, mesh.layers)
  }

  // Compute global_min/global_max for all scalar overlays
  computeAllScalarMeta(tractData)

  // Propagate mesh color to fixedColor if not explicitly set in tractOptions
  let fixedColor: [number, number, number, number] | undefined
  if (!mesh.tractOptions?.fixedColor) {
    if (mesh.rgba255) {
      fixedColor = [
        mesh.rgba255[0],
        mesh.rgba255[1],
        mesh.rgba255[2],
        mesh.rgba255[3],
      ]
    } else if (mesh.color) {
      fixedColor = [
        Math.round(mesh.color[0] * 255),
        Math.round(mesh.color[1] * 255),
        Math.round(mesh.color[2] * 255),
        Math.round(mesh.color[3] * 255),
      ]
    }
  }
  const tractOptions: NVTractOptions = {
    ...defaultTractOptions,
    ...(fixedColor && { fixedColor }),
    ...mesh.tractOptions,
  }

  const { positions, indices, colors } = tessellate(tractData, tractOptions)
  const urlString = typeof mesh.url === 'string' ? mesh.url : mesh.url.name
  // Show colorbar automatically when using scalar coloring, unless explicitly overridden
  const hasScalarColor =
    tractOptions.colorBy.startsWith('dpv:') ||
    tractOptions.colorBy.startsWith('dps:')
  return createMesh(positions, indices, colors, {
    kind: 'tract' as MeshKind,
    trx: tractData,
    tractOptions,
    opacity: mesh.opacity ?? 1.0,
    shaderType: mesh.shaderType ?? 'phong',
    color: mesh.color ?? [1, 1, 1, 1],
    isColorbarVisible: mesh.isColorbarVisible ?? hasScalarColor,
    url: urlString,
    name: mesh.name ?? urlString,
  })
}

/**
 * Load a tract/streamline file, tessellate into cylinders, and return as NVMesh.
 */
async function loadTract(
  mesh: MeshFromUrlOptions,
  ext: string,
): Promise<NVMeshType> {
  const reader = getTractReader(ext)
  if (!reader) throw new Error(`No tract reader for extension ${ext}`)
  const buffer = await NVLoader.fetchFile(mesh.url)
  const tractData = await reader.read(buffer)
  return buildTractMesh(mesh, tractData)
}

/**
 * Load a connectome file, extrude nodes/edges into geometry, and return as NVMesh.
 */
async function loadConnectome(
  mesh: MeshFromUrlOptions,
  ext: string,
): Promise<NVMeshType> {
  const reader = getConnectomeReader(ext)
  if (!reader) throw new Error(`No connectome reader for extension ${ext}`)
  const buffer = await NVLoader.fetchFile(mesh.url)
  const fileData = await reader.read(buffer)
  // Merge: file defaults → user overrides
  const connectomeOptions: NVConnectomeOptions = {
    ...defaultConnectomeOptions,
    ...fileData.options,
    ...mesh.connectomeOptions,
  }

  const { positions, indices, colors } = extrude(
    fileData.data,
    connectomeOptions,
  )
  const urlString = typeof mesh.url === 'string' ? mesh.url : mesh.url.name
  return createMesh(positions, indices, colors, {
    kind: 'connectome' as MeshKind,
    jcon: fileData.data,
    connectomeOptions,
    opacity: mesh.opacity ?? 1.0,
    shaderType: mesh.shaderType ?? 'phong',
    color: mesh.color ?? [1, 1, 1, 1],
    isColorbarVisible: mesh.isColorbarVisible ?? true,
    isLegendVisible: mesh.isLegendVisible ?? false,
    url: urlString,
    name: mesh.name ?? urlString,
  })
}

/**
 * Re-tessellate a tract mesh with updated options.
 * Mutates the mesh's derived GPU-ready arrays in place.
 */
export function retessellateTract(mesh: NVMeshType): void {
  if (mesh.kind !== 'tract' || !mesh.trx || !mesh.tractOptions) return
  const result = tessellate(mesh.trx, mesh.tractOptions)
  mesh.positions = result.positions
  mesh.indices = result.indices
  mesh.colors = result.colors
  // Update extents
  const mn = vec3.fromValues(Infinity, Infinity, Infinity)
  const mx = vec3.fromValues(-Infinity, -Infinity, -Infinity)
  const nv = result.positions.length / 3
  for (let i = 0; i < nv; i++) {
    mn[0] = Math.min(mn[0], result.positions[i * 3])
    mn[1] = Math.min(mn[1], result.positions[i * 3 + 1])
    mn[2] = Math.min(mn[2], result.positions[i * 3 + 2])
    mx[0] = Math.max(mx[0], result.positions[i * 3])
    mx[1] = Math.max(mx[1], result.positions[i * 3 + 1])
    mx[2] = Math.max(mx[2], result.positions[i * 3 + 2])
  }
  mesh.extentsMin = mn
  mesh.extentsMax = mx
}

/**
 * Re-extrude a connectome mesh with updated options.
 * Mutates the mesh's derived GPU-ready arrays in place.
 */
export function reextrudeConnectome(mesh: NVMeshType): void {
  if (mesh.kind !== 'connectome' || !mesh.jcon || !mesh.connectomeOptions)
    return
  const result = extrude(mesh.jcon, mesh.connectomeOptions)
  mesh.positions = result.positions
  mesh.indices = result.indices
  mesh.colors = result.colors
  // Update extents
  const mn = vec3.fromValues(Infinity, Infinity, Infinity)
  const mx = vec3.fromValues(-Infinity, -Infinity, -Infinity)
  const nv = result.positions.length / 3
  for (let i = 0; i < nv; i++) {
    mn[0] = Math.min(mn[0], result.positions[i * 3])
    mn[1] = Math.min(mn[1], result.positions[i * 3 + 1])
    mn[2] = Math.min(mn[2], result.positions[i * 3 + 2])
    mx[0] = Math.max(mx[0], result.positions[i * 3])
    mx[1] = Math.max(mx[1], result.positions[i * 3 + 1])
    mx[2] = Math.max(mx[2], result.positions[i * 3 + 2])
  }
  mesh.extentsMin = mn
  mesh.extentsMax = mx
}
