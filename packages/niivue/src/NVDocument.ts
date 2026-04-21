import { decode, encode } from "cbor-x"
import * as Drawing from "@/drawing"
import { encodeRLE } from "@/drawing/rle"
import { log } from "@/logger"
import * as NVMeshLayers from "@/mesh/layers"
import * as NVMesh from "@/mesh/NVMesh"
import * as NVConstants from "@/NVConstants"
import type NVModel from "@/NVModel"
import type {
  AnnotationConfig,
  DrawConfig,
  InteractionConfig,
  LayoutConfig,
  MeshKind,
  MeshRenderConfig,
  NIFTI1,
  NIFTI2,
  NVConnectomeData,
  NVConnectomeOptions,
  NVMeshLayer,
  NVTractData,
  NVTractOptions,
  UIConfig,
  VectorAnnotation,
  VolumeRenderConfig,
} from "@/NVTypes"
import * as NVVolume from "@/volume/NVVolume"
import { computeVolumeLabelCentroids } from "@/volume/utils"

const DOCUMENT_VERSION = 7

/**
 * Embedded volume data for self-contained documents.
 * Stores the complete NIFTI header and raw voxel data.
 */
export type NVDocumentVolumeData = {
  hdr: NIFTI1 | NIFTI2
  img: Uint8Array
  datatypeCode: number
}

export type NVDocumentVolume = {
  url?: string
  name?: string
  colormap?: string
  colormapNegative?: string
  opacity?: number
  calMin?: number
  calMax?: number
  calMinNeg?: number
  calMaxNeg?: number
  colormapType?: number
  isTransparentBelowCalMin?: boolean
  modulateAlpha?: number
  isColorbarVisible?: boolean
  isLegendVisible?: boolean
  frame4D?: number
  /** Embedded volume data (when URL is not a valid remote URL) */
  data?: NVDocumentVolumeData
  /** Label colormap LUT for atlas/parcellation volumes */
  colormapLabel?: {
    lut: Uint8Array
    min: number
    max: number
    labels?: string[]
  }
}

/**
 * Embedded mesh data for self-contained documents.
 * Stores positions, indices, and vertex colors.
 */
export type NVDocumentMeshData = {
  positions: Uint8Array // Float32Array as bytes
  indices: Uint8Array // Uint32Array as bytes
  colors: Uint8Array // Uint32Array as bytes
  perVertexColors?: Uint8Array // Uint32Array as bytes (per-vertex colors from file, omitted for uniform-color meshes)
}

/**
 * Embedded tract source data for self-contained documents.
 * Stores streamline vertices, offsets, and scalar overlays.
 */
export type NVDocumentTractData = {
  vertices: Uint8Array // Float32Array as bytes
  offsets: Uint8Array // Uint32Array as bytes
  dpv: Record<string, Uint8Array> // per-vertex Float32Arrays as bytes
  dps: Record<string, Uint8Array> // per-streamline Float32Arrays as bytes
  groups: Record<string, Uint8Array> // group Uint32Arrays as bytes
  dpvMeta: Record<string, { globalMin: number; globalMax: number }>
  dpsMeta: Record<string, { globalMin: number; globalMax: number }>
}

/**
 * Serialized mesh layer (scalar overlay) for NVD documents.
 */
export type NVDocumentMeshLayer = {
  url?: string
  name?: string
  colormap?: string
  colormapNegative?: string
  calMin?: number
  calMax?: number
  calMinNeg?: number
  calMaxNeg?: number
  opacity?: number
  isColorbarVisible?: boolean
  isColormapInverted?: boolean
  colormapType?: number
  isTransparentBelowCalMin?: boolean
  isAdditiveBlend?: boolean
  nFrame4D?: number
  frame4D?: number
  outlineWidth?: number
  /** Embedded scalar data (Float32Array as bytes) */
  data?: Uint8Array
  /** Label colormap LUT for atlas/parcellation layers */
  colormapLabel?: {
    lut: Uint8Array
    min: number
    max: number
    labels?: string[]
  }
}

export type NVDocumentMesh = {
  url?: string
  name?: string
  opacity?: number
  shaderType?: string
  color?: [number, number, number, number]
  isColorbarVisible?: boolean
  isLegendVisible?: boolean
  /** Mesh species: 'mesh', 'tract', or 'connectome' (default: 'mesh') */
  kind?: MeshKind
  /** Tract source data (only for kind === 'tract') */
  tractData?: NVDocumentTractData
  /** Tract display/tessellation options (only for kind === 'tract') */
  tractOptions?: NVTractOptions
  /** Connectome source data (only for kind === 'connectome') */
  connectomeData?: NVConnectomeData
  /** Connectome display/extrusion options (only for kind === 'connectome') */
  connectomeOptions?: NVConnectomeOptions
  /** Embedded mesh data (when URL is not a valid remote URL) */
  data?: NVDocumentMeshData
  /** Scalar overlay layers */
  layers?: NVDocumentMeshLayer[]
}

export type NVDocumentData = {
  version: number
  created: string
  scene: {
    azimuth: number
    elevation: number
    scaleMultiplier: number
    gamma: number
    crosshairPos: [number, number, number]
    pan2Dxyzmm: [number, number, number, number]
    backgroundColor: [number, number, number, number]
    clipPlaneColor: number[]
    isClipPlaneCutaway: boolean
  }
  layout: LayoutConfig
  ui: UIConfig
  volume: VolumeRenderConfig
  mesh: MeshRenderConfig
  draw: DrawConfig
  interaction: InteractionConfig
  clipPlanes: number[]
  /** RLE-compressed drawing bitmap (if a drawing was active) */
  drawingBitmapRLE?: Uint8Array
  /** Uncompressed length of drawing bitmap */
  drawingBitmapLength?: number
  volumes: NVDocumentVolume[]
  meshes: NVDocumentMesh[]
  annotations?: VectorAnnotation[]
  annotationConfig?: AnnotationConfig
}

/**
 * Convert a TypedArray to Uint8Array (as raw bytes).
 */
function typedArrayToBytes(arr: ArrayBufferView): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
}

/**
 * Extract only serializable properties from NIFTI header.
 * The nifti-reader-js header objects contain methods that CBOR can't serialize.
 */
function extractHeaderData(hdr: NIFTI1 | NIFTI2): NIFTI1 | NIFTI2 {
  return {
    littleEndian: hdr.littleEndian,
    dim_info: hdr.dim_info,
    dims: [...hdr.dims],
    pixDims: [...hdr.pixDims],
    intent_p1: hdr.intent_p1,
    intent_p2: hdr.intent_p2,
    intent_p3: hdr.intent_p3,
    intent_code: hdr.intent_code,
    datatypeCode: hdr.datatypeCode,
    numBitsPerVoxel: hdr.numBitsPerVoxel,
    slice_start: hdr.slice_start,
    vox_offset: hdr.vox_offset,
    scl_slope: hdr.scl_slope,
    scl_inter: hdr.scl_inter,
    slice_end: hdr.slice_end,
    slice_code: hdr.slice_code,
    xyzt_units: hdr.xyzt_units,
    cal_max: hdr.cal_max,
    cal_min: hdr.cal_min,
    slice_duration: hdr.slice_duration,
    toffset: hdr.toffset,
    description: hdr.description,
    aux_file: hdr.aux_file,
    qform_code: hdr.qform_code,
    sform_code: hdr.sform_code,
    quatern_b: hdr.quatern_b,
    quatern_c: hdr.quatern_c,
    quatern_d: hdr.quatern_d,
    qoffset_x: hdr.qoffset_x,
    qoffset_y: hdr.qoffset_y,
    qoffset_z: hdr.qoffset_z,
    affine: hdr.affine.map((row) => [...row]),
    intent_name: hdr.intent_name,
    magic: hdr.magic,
  }
}

export function serialize(model: NVModel): Uint8Array {
  // Extract volumes with embedded data
  const volumes: NVDocumentVolume[] = model.volumes.map((v) => {
    const vol: NVDocumentVolume = {
      url: v.url,
      name: v.name,
      colormap: v.colormap,
      colormapNegative: v.colormapNegative,
      opacity: v.opacity,
      calMin: v.calMin,
      calMax: v.calMax,
      calMinNeg: v.calMinNeg,
      calMaxNeg: v.calMaxNeg,
      colormapType: v.colormapType,
      isTransparentBelowCalMin: v.isTransparentBelowCalMin,
      modulateAlpha: v.modulateAlpha,
      isColorbarVisible: v.isColorbarVisible,
      isLegendVisible: v.isLegendVisible,
      frame4D: v.frame4D,
    }

    // Serialize label colormap if present
    if (v.colormapLabel) {
      vol.colormapLabel = {
        lut: new Uint8Array(
          v.colormapLabel.lut.buffer,
          v.colormapLabel.lut.byteOffset,
          v.colormapLabel.lut.byteLength,
        ),
        min: v.colormapLabel.min ?? 0,
        max: v.colormapLabel.max ?? 0,
        labels: v.colormapLabel.labels,
      }
    }

    // Always embed volume data for self-contained documents
    if (v.hdr && v.img) {
      const imgData = typedArrayToBytes(v.img)

      vol.data = {
        hdr: extractHeaderData(v.hdr),
        img: imgData,
        datatypeCode: v.hdr.datatypeCode,
      }
    }

    return vol
  })

  // Extract meshes with embedded data
  const meshes: NVDocumentMesh[] = model.meshes.map((m) => {
    const mesh: NVDocumentMesh = {
      url: m.url,
      name: m.name,
      opacity: m.opacity,
      shaderType: m.shaderType,
      color: m.color,
      isColorbarVisible: m.isColorbarVisible,
      isLegendVisible: m.isLegendVisible,
      kind: m.kind,
    }

    // Always embed mesh data for self-contained documents
    if (m.positions && m.indices && m.colors) {
      mesh.data = {
        positions: typedArrayToBytes(m.positions),
        indices: typedArrayToBytes(m.indices),
        colors: typedArrayToBytes(m.colors),
        perVertexColors: m.perVertexColors
          ? typedArrayToBytes(m.perVertexColors)
          : undefined,
      }
    }

    // Serialize tract source data and options
    if (m.kind === "tract" && m.trx) {
      mesh.tractData = {
        vertices: typedArrayToBytes(m.trx.vertices),
        offsets: typedArrayToBytes(m.trx.offsets),
        dpv: Object.fromEntries(
          Object.entries(m.trx.dpv).map(([k, v]) => [k, typedArrayToBytes(v)]),
        ),
        dps: Object.fromEntries(
          Object.entries(m.trx.dps).map(([k, v]) => [k, typedArrayToBytes(v)]),
        ),
        groups: Object.fromEntries(
          Object.entries(m.trx.groups).map(([k, v]) => [
            k,
            typedArrayToBytes(v),
          ]),
        ),
        dpvMeta: Object.fromEntries(
          Object.entries(m.trx.dpvMeta).map(([k, v]) => [
            k,
            { globalMin: v.globalMin, globalMax: v.globalMax },
          ]),
        ),
        dpsMeta: Object.fromEntries(
          Object.entries(m.trx.dpsMeta).map(([k, v]) => [
            k,
            { globalMin: v.globalMin, globalMax: v.globalMax },
          ]),
        ),
      }
      if (m.tractOptions) mesh.tractOptions = { ...m.tractOptions }
    }

    // Serialize connectome source data and options
    if (m.kind === "connectome" && m.jcon) {
      mesh.connectomeData = {
        nodes: m.jcon.nodes.map((n) => ({ ...n })),
        edges: m.jcon.edges.map((e) => ({ ...e })),
      }
      if (m.connectomeOptions)
        mesh.connectomeOptions = { ...m.connectomeOptions }
    }

    // Serialize layers
    if (m.layers && m.layers.length > 0) {
      mesh.layers = m.layers.map((layer) => {
        const docLayer: NVDocumentMeshLayer = {
          url: layer.url,
          name: layer.name,
          colormap: layer.colormap,
          colormapNegative: layer.colormapNegative,
          calMin: layer.calMin,
          calMax: layer.calMax,
          calMinNeg: layer.calMinNeg,
          calMaxNeg: layer.calMaxNeg,
          opacity: layer.opacity,
          isColorbarVisible: layer.isColorbarVisible,
          isColormapInverted: layer.isColormapInverted,
          colormapType: layer.colormapType,
          isTransparentBelowCalMin: layer.isTransparentBelowCalMin,
          isAdditiveBlend: layer.isAdditiveBlend,
          nFrame4D: layer.nFrame4D,
          frame4D: layer.frame4D,
          outlineWidth: layer.outlineWidth,
          data: typedArrayToBytes(layer.values),
        }
        // Serialize layer label colormap if present
        if (layer.colormapLabel) {
          docLayer.colormapLabel = {
            lut: new Uint8Array(
              layer.colormapLabel.lut.buffer,
              layer.colormapLabel.lut.byteOffset,
              layer.colormapLabel.lut.byteLength,
            ),
            min: layer.colormapLabel.min ?? 0,
            max: layer.colormapLabel.max ?? 0,
            labels: layer.colormapLabel.labels,
          }
        }
        return docLayer
      })
    }

    return mesh
  })

  const doc: NVDocumentData = {
    version: DOCUMENT_VERSION,
    created: new Date().toISOString(),
    scene: {
      azimuth: model.scene.azimuth,
      elevation: model.scene.elevation,
      scaleMultiplier: model.scene.scaleMultiplier,
      gamma: model.scene.gamma,
      crosshairPos: [
        model.scene.crosshairPos[0],
        model.scene.crosshairPos[1],
        model.scene.crosshairPos[2],
      ],
      pan2Dxyzmm: [
        model.scene.pan2Dxyzmm[0],
        model.scene.pan2Dxyzmm[1],
        model.scene.pan2Dxyzmm[2],
        model.scene.pan2Dxyzmm[3],
      ],
      backgroundColor: [...model.scene.backgroundColor] as [
        number,
        number,
        number,
        number,
      ],
      clipPlaneColor: [...model.scene.clipPlaneColor],
      isClipPlaneCutaway: model.scene.isClipPlaneCutaway,
    },
    layout: { ...model.layout },
    ui: { ...model.ui },
    volume: { ...model.volume },
    mesh: { ...model.mesh },
    draw: { ...model.draw },
    interaction: { ...model.interaction },
    clipPlanes: [...model.clipPlanes],
    drawingBitmapRLE: model.drawingVolume
      ? encodeRLE(Drawing.getDrawingBitmap(model.drawingVolume))
      : undefined,
    drawingBitmapLength: model.drawingVolume
      ? Drawing.getDrawingBitmap(model.drawingVolume).length
      : undefined,
    volumes,
    meshes,
    annotations: model.annotations.length > 0 ? model.annotations : undefined,
    annotationConfig: { ...model.annotation },
  }

  return encode(doc)
}

export function deserialize(data: Uint8Array): NVDocumentData {
  const doc = decode(data) as NVDocumentData

  // Version check
  if (typeof doc.version !== "number") {
    throw new Error("Invalid NVD file: missing version")
  }
  if (doc.version > DOCUMENT_VERSION) {
    throw new Error(
      `NVD file version ${doc.version} is newer than supported version ${DOCUMENT_VERSION}`,
    )
  }

  // Validate required fields
  if (!doc.scene || !doc.layout) {
    throw new Error("Invalid NVD file: missing required fields")
  }

  // Migrate v5 → v6: rename drawing bitmap fields
  if (doc.version <= 5) {
    const legacy = doc as Record<string, unknown>
    if (legacy.drawBitmapRLE) {
      doc.drawingBitmapRLE = legacy.drawBitmapRLE as Uint8Array
      doc.drawingBitmapLength = legacy.drawBitmapLength as number
      delete legacy.drawBitmapRLE
      delete legacy.drawBitmapLength
    }
  }

  return doc
}

export function applyDocumentToModel(
  model: NVModel,
  doc: NVDocumentData,
): void {
  // Apply scene state
  model.scene.azimuth = doc.scene.azimuth
  model.scene.elevation = doc.scene.elevation
  model.scene.scaleMultiplier = doc.scene.scaleMultiplier
  model.scene.gamma = doc.scene.gamma
  model.scene.crosshairPos[0] = doc.scene.crosshairPos[0]
  model.scene.crosshairPos[1] = doc.scene.crosshairPos[1]
  model.scene.crosshairPos[2] = doc.scene.crosshairPos[2]
  model.scene.pan2Dxyzmm[0] = doc.scene.pan2Dxyzmm[0]
  model.scene.pan2Dxyzmm[1] = doc.scene.pan2Dxyzmm[1]
  model.scene.pan2Dxyzmm[2] = doc.scene.pan2Dxyzmm[2]
  model.scene.pan2Dxyzmm[3] = doc.scene.pan2Dxyzmm[3]
  model.scene.backgroundColor = [...doc.scene.backgroundColor] as [
    number,
    number,
    number,
    number,
  ]
  model.scene.clipPlaneColor = [...doc.scene.clipPlaneColor]
  model.scene.isClipPlaneCutaway = doc.scene.isClipPlaneCutaway

  // Apply config groups
  Object.assign(model.layout, doc.layout)
  Object.assign(model.ui, doc.ui)
  Object.assign(model.volume, doc.volume)
  Object.assign(model.mesh, doc.mesh)
  Object.assign(model.draw, doc.draw)
  Object.assign(model.interaction, doc.interaction)
  // annotation config restored separately below, after annotations array

  // Apply clip planes
  for (
    let i = 0;
    i < doc.clipPlanes.length && i < model.clipPlanes.length;
    i++
  ) {
    model.clipPlanes[i] = doc.clipPlanes[i]
  }

  // Restore annotations (v7+); clear if not present to avoid stale state
  model.annotations = doc.annotations ?? []
  if (doc.annotationConfig) {
    model.annotation = { ...doc.annotationConfig } as AnnotationConfig
  } else {
    model.annotation = { ...NVConstants.ANNOTATION_DEFAULTS }
  }

  // Drawing bitmap restoration is handled by the controller's loadDocument()
  // after volumes are reconstructed, since we need a background volume to
  // create the drawingVolume.
}

/**
 * Reconstruct a volume from a document entry and add it to the model.
 */
export async function reconstructVolume(
  model: NVModel,
  v: NVDocumentVolume,
): Promise<void> {
  try {
    if (v.data) {
      // Reconstruct volume from embedded data
      // Convert to proper ArrayBuffer (Uint8Array.buffer could be SharedArrayBuffer)
      const imgBuffer = v.data.img.buffer.slice(
        v.data.img.byteOffset,
        v.data.img.byteOffset + v.data.img.byteLength,
      ) as ArrayBuffer
      const base = NVVolume.nii2volume(
        v.data.hdr,
        imgBuffer,
        v.name ?? "volume",
      )
      // Only override properties that are defined in the document
      if (v.url !== undefined) base.url = v.url
      if (v.colormap !== undefined) base.colormap = v.colormap
      if (v.colormapNegative !== undefined)
        base.colormapNegative = v.colormapNegative
      if (v.opacity !== undefined) base.opacity = v.opacity
      if (v.calMin !== undefined) base.calMin = v.calMin
      if (v.calMax !== undefined) base.calMax = v.calMax
      if (v.calMinNeg !== undefined) base.calMinNeg = v.calMinNeg
      if (v.calMaxNeg !== undefined) base.calMaxNeg = v.calMaxNeg
      if (v.colormapType !== undefined) base.colormapType = v.colormapType
      if (v.isTransparentBelowCalMin !== undefined)
        base.isTransparentBelowCalMin = v.isTransparentBelowCalMin
      if (v.modulateAlpha !== undefined) base.modulateAlpha = v.modulateAlpha
      if (v.isColorbarVisible !== undefined)
        base.isColorbarVisible = v.isColorbarVisible
      if (v.isLegendVisible !== undefined)
        base.isLegendVisible = v.isLegendVisible
      if (v.frame4D !== undefined) base.frame4D = v.frame4D
      await model.addVolume(base)
    } else if (v.url) {
      // Load from URL
      await model.addVolume({
        url: v.url,
        name: v.name,
        colormap: v.colormap,
        colormapNegative: v.colormapNegative,
        opacity: v.opacity,
        calMin: v.calMin,
        calMax: v.calMax,
        calMinNeg: v.calMinNeg,
        calMaxNeg: v.calMaxNeg,
        colormapType: v.colormapType,
        isTransparentBelowCalMin: v.isTransparentBelowCalMin,
        modulateAlpha: v.modulateAlpha,
        isColorbarVisible: v.isColorbarVisible,
      })
    }
    // Apply post-load properties to the just-added volume
    const vol = model.volumes[model.volumes.length - 1]
    if (vol) {
      if (v.isLegendVisible !== undefined)
        vol.isLegendVisible = v.isLegendVisible
      if (v.frame4D !== undefined) vol.frame4D = v.frame4D
      // Restore label colormap if present in document
      if (v.colormapLabel) {
        const lutData = v.colormapLabel.lut
        vol.colormapLabel = {
          lut: new Uint8ClampedArray(
            lutData.buffer,
            lutData.byteOffset,
            lutData.byteLength,
          ),
          min: v.colormapLabel.min,
          max: v.colormapLabel.max,
          labels: v.colormapLabel.labels,
        }
        vol.colormapLabel.centroids = computeVolumeLabelCentroids(vol)
      }
    }
  } catch (err) {
    log.warn(`Failed to load volume ${v.name ?? v.url}:`, err)
  }
}

/**
 * Reconstruct a mesh from a document entry and add it to the model.
 */
export async function reconstructMesh(
  model: NVModel,
  m: NVDocumentMesh,
): Promise<void> {
  try {
    if (m.data) {
      // Reconstruct mesh from embedded data
      // Create copies to ensure proper alignment (CBOR may give unaligned views)
      const posBuffer = m.data.positions.buffer.slice(
        m.data.positions.byteOffset,
        m.data.positions.byteOffset + m.data.positions.byteLength,
      )
      const idxBuffer = m.data.indices.buffer.slice(
        m.data.indices.byteOffset,
        m.data.indices.byteOffset + m.data.indices.byteLength,
      )
      const colBuffer = m.data.colors.buffer.slice(
        m.data.colors.byteOffset,
        m.data.colors.byteOffset + m.data.colors.byteLength,
      )
      const positions = new Float32Array(posBuffer)
      const indices = new Uint32Array(idxBuffer)
      const colors = new Uint32Array(colBuffer)
      // Restore perVertexColors if present (only for meshes with file colors)
      let perVertexColors: Uint32Array | null = null
      if (m.data.perVertexColors) {
        const pvcBuffer = m.data.perVertexColors.buffer.slice(
          m.data.perVertexColors.byteOffset,
          m.data.perVertexColors.byteOffset + m.data.perVertexColors.byteLength,
        ) as ArrayBuffer
        perVertexColors = new Uint32Array(pvcBuffer)
      }
      // Restore layers from embedded data
      const layers: NVMeshLayer[] = []
      if (m.layers) {
        const nVert = positions.length / 3
        for (const docLayer of m.layers) {
          if (docLayer.data) {
            const valBuffer = docLayer.data.buffer.slice(
              docLayer.data.byteOffset,
              docLayer.data.byteOffset + docLayer.data.byteLength,
            )
            const values = new Float32Array(valBuffer)
            const layer = NVMeshLayers.createLayer(values, nVert, {
              url: docLayer.url,
              name: docLayer.name,
              colormap: docLayer.colormap,
              colormapNegative: docLayer.colormapNegative,
              calMin: docLayer.calMin,
              calMax: docLayer.calMax,
              calMinNeg: docLayer.calMinNeg,
              calMaxNeg: docLayer.calMaxNeg,
              opacity: docLayer.opacity,
              isColorbarVisible: docLayer.isColorbarVisible,
              isColormapInverted: docLayer.isColormapInverted,
              colormapType: docLayer.colormapType,
              isTransparentBelowCalMin: docLayer.isTransparentBelowCalMin,
              isAdditiveBlend: docLayer.isAdditiveBlend,
              nFrame4D: docLayer.nFrame4D,
              frame4D: docLayer.frame4D,
              outlineWidth: docLayer.outlineWidth,
            })
            // Restore layer label colormap if present
            if (docLayer.colormapLabel) {
              const lutData = docLayer.colormapLabel.lut
              layer.colormapLabel = {
                lut: new Uint8ClampedArray(
                  lutData.buffer,
                  lutData.byteOffset,
                  lutData.byteLength,
                ),
                min: docLayer.colormapLabel.min,
                max: docLayer.colormapLabel.max,
                labels: docLayer.colormapLabel.labels,
              }
              layer.colormapLabel.centroids =
                NVMeshLayers.computeMeshLabelCentroids(positions, layer)
            }
            layers.push(layer)
          }
        }
      }

      // Build species-specific source data
      const kind = m.kind ?? "mesh"
      const meshOpts: Record<string, unknown> = {
        kind,
        url: m.url,
        name: m.name,
        opacity: m.opacity,
        shaderType: m.shaderType,
        color: m.color,
        isColorbarVisible: m.isColorbarVisible,
        isLegendVisible: m.isLegendVisible,
        perVertexColors,
        layers,
      }

      // Restore tract source data so retessellateTract() works
      if (kind === "tract" && m.tractData) {
        const td = m.tractData
        const trx: NVTractData = {
          vertices: new Float32Array(
            td.vertices.buffer.slice(
              td.vertices.byteOffset,
              td.vertices.byteOffset + td.vertices.byteLength,
            ),
          ),
          offsets: new Uint32Array(
            td.offsets.buffer.slice(
              td.offsets.byteOffset,
              td.offsets.byteOffset + td.offsets.byteLength,
            ),
          ),
          dpv: Object.fromEntries(
            Object.entries(td.dpv).map(([k, v]) => [
              k,
              new Float32Array(
                v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
              ),
            ]),
          ),
          dps: Object.fromEntries(
            Object.entries(td.dps).map(([k, v]) => [
              k,
              new Float32Array(
                v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
              ),
            ]),
          ),
          groups: Object.fromEntries(
            Object.entries(td.groups).map(([k, v]) => [
              k,
              new Uint32Array(
                v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
              ),
            ]),
          ),
          dpvMeta: Object.fromEntries(
            Object.entries(td.dpvMeta).map(([k, v]) => [
              k,
              { globalMin: v.globalMin, globalMax: v.globalMax },
            ]),
          ),
          dpsMeta: Object.fromEntries(
            Object.entries(td.dpsMeta).map(([k, v]) => [
              k,
              { globalMin: v.globalMin, globalMax: v.globalMax },
            ]),
          ),
        }
        meshOpts.trx = trx
        meshOpts.tractOptions = m.tractOptions ?? null
      }

      // Restore connectome source data so reextrudeConnectome() works
      if (kind === "connectome" && m.connectomeData) {
        meshOpts.jcon = m.connectomeData
        meshOpts.connectomeOptions = m.connectomeOptions ?? null
      }

      const mesh = NVMesh.createMesh(positions, indices, colors, meshOpts)
      await model.addMesh(mesh)
    } else if (m.url) {
      // Load from URL (layers loaded via MeshFromUrlOptions)
      await model.addMesh({
        url: m.url,
        name: m.name,
        opacity: m.opacity,
        shaderType: m.shaderType,
        color: m.color,
        isColorbarVisible: m.isColorbarVisible,
        isLegendVisible: m.isLegendVisible,
      })
    }
  } catch (err) {
    log.warn(`Failed to load mesh ${m.name ?? m.url}:`, err)
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function triggerDownload(data: Uint8Array, filename: string): void {
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer
  const name = filename.endsWith(".nvd") ? filename : `${filename}.nvd`
  downloadBlob(new Blob([buffer], { type: "application/cbor" }), name)
}
