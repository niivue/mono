import { decode, encode } from 'cbor-x'
import {
  decodeDocumentJSON,
  encodeDocumentJSON,
  looksLikeJSON,
} from '@/documentJson'
import { isTransientStreamedVolume, shouldLinkVolume } from '@/documentLinkData'
import {
  fillGroup,
  fillModeFor,
  type SettingsFillPolicy,
  type SettingsSavePolicy,
  sparsifyGroup,
} from '@/documentSettings'
import { getDrawingBitmap } from '@/drawing/drawingManager'
import { encodeRLE } from '@/drawing/rle'
import { log } from '@/logger'
import * as NVMeshLayers from '@/mesh/layers'
import * as NVMesh from '@/mesh/NVMesh'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
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
} from '@/NVTypes'
import {
  reconstructSignal,
  type SerializedSignal,
  serializeSignal,
} from '@/signal/persistence'
import type { NVSlideManifest } from '@/slide/NVSlide'
import type { SlideVectorShape } from '@/slide/slideVector'
import * as NVVolume from '@/volume/NVVolume'
import { computeVolumeLabelCentroids } from '@/volume/utils'

// v8 added two independent optional, additive fields: the `signals` array
// (NVSignal persistence, incl. each signal's optional `annotations`) and the
// `slidePlane` object (registered NVSlide plane + its slide-space drawing).
// Both are optional and round-trip as absent on readers/writers that lack them
// (forward- and backward-compatible), so they share one version. Later additive
// optional volume fields (e.g. `modulationImage`) likewise did NOT bump the
// version. Bump only when adding a field that older code would misread.
//
// v9 made the settings groups (scene/layout/ui/volume/mesh/draw/interaction/
// annotation) SPARSE: a document omits any setting equal to its default. On load
// a specified setting always wins; an OMITTED setting is filled per the caller's
// fill policy (default: reset to its built-in default, so a document is a complete
// scene; 'current': keep the loading instance's value). A v8 loader would read an
// omitted scene field as `undefined`, so the version is bumped: an old reader
// rejects a v9 doc rather than corrupting state. v8 docs (all fields present) load
// unchanged. The numeric value lives in NVConstants (pure, importable by the
// legacy converter without pulling this Vite module graph).
const DOCUMENT_VERSION = NVConstants.NVD_DOCUMENT_VERSION

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
  modulationImage?: string
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
  sliceShaderType?: string
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

/**
 * A registered NVSlide plane plus its slide-space drawing. The slide is stored
 * by manifest (data URLs + byte-range tile graph) so tiles refetch on load;
 * the annotation raster is RLE-compressed like the volume drawing. Tile bytes
 * are NOT embedded (a pyramid is far too large) — reconstruction refetches them,
 * so the manifest's data URLs must still be reachable. Custom tile sources
 * (DZI/TIFF/codec adapters) reconstruct geometry + drawing but need the app to
 * have re-registered their decoders for tiles to load.
 */
export type NVDocumentSlidePlane = {
  manifest: NVSlideManifest
  manifestUrl?: string
  /** Column-major 4x4 slide base-pixel -> world mm. */
  pixelToWorld: number[]
  /** Pinned level (camera LOD off) or undefined for automatic LOD. */
  levelIndex?: number
  /** RLE-compressed slide-space drawing raster (label indices). */
  drawingRLE?: Uint8Array
  drawingWidth?: number
  drawingHeight?: number
  /** Vector annotations in slide base-pixel coordinates (v8+). */
  vectorShapes?: SlideVectorShape[]
}

export type NVDocumentData = {
  version: number
  created: string
  // Settings groups are SPARSE: a document omits any setting that equals its
  // default (v9+), so every field is optional. On load a specified setting wins;
  // an omitted setting is filled per the caller's fill policy (default: reset to
  // its built-in default; 'current': keep the instance's value). See
  // applyDocumentToModel. Older (v8-) documents embed every field, so they load
  // unchanged.
  scene: {
    azimuth?: number
    elevation?: number
    scaleMultiplier?: number
    gamma?: number
    crosshairPos?: [number, number, number]
    pan2Dxyzmm?: [number, number, number, number]
    backgroundColor?: [number, number, number, number]
    clipPlaneColor?: number[]
    isClipPlaneCutaway?: boolean
  }
  layout: Partial<LayoutConfig>
  ui: Partial<UIConfig>
  volume: Partial<VolumeRenderConfig>
  mesh: Partial<MeshRenderConfig>
  draw: Partial<DrawConfig>
  interaction: Partial<InteractionConfig>
  clipPlanes: number[]
  /** RLE-compressed drawing bitmap (if a drawing was active) */
  drawingBitmapRLE?: Uint8Array
  /** Uncompressed length of drawing bitmap */
  drawingBitmapLength?: number
  volumes: NVDocumentVolume[]
  meshes: NVDocumentMesh[]
  signals?: SerializedSignal[]
  annotations?: VectorAnnotation[]
  annotationConfig?: Partial<AnnotationConfig>
  /** Registered slide plane + its slide-space drawing (v8+). */
  slidePlane?: NVDocumentSlidePlane
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

/** Options for {@link serialize}. */
export interface SerializeOptions {
  /**
   * Which settings the document includes (sparse). Omitted -> omit any setting
   * equal to its default. See {@link SettingsSavePolicy}.
   */
  settings?: SettingsSavePolicy
  /**
   * Link (rather than embed) volume data. When true, a volume that has a
   * fetchable URL is serialized WITHOUT its bytes and the loader refetches from
   * the URL — a small, "linked" document. Volumes with no linkable URL
   * (drag-dropped files, `blob:`/`data:` URLs) still embed their data so the
   * document always round-trips. Default false (self-contained).
   *
   * INVARIANT — a linked volume assumes the URL's content is immutable and still
   * matches the in-memory voxels. Linking keys off "has a fetchable URL," NOT off
   * "the bytes are unchanged," so if the volume was mutated in place after load
   * (`applyVolumeTransform`, `loadImgV1`, ...) OR the server content at the URL
   * changed, a linked save silently drops the edited/original bytes and reload
   * fetches whatever the URL now serves. Do not link a volume you have edited in
   * place — embed it (the default) instead. (Display state and the drawing bitmap
   * are serialized separately and survive; only the raw voxels can diverge.)
   *
   * NOTE: meshes are always embedded (their URL-restore path does not yet reapply
   * overlay layers / tract options).
   */
  linkData?: boolean
  /**
   * Encoding of the returned bytes: `'cbor'` (default) is the compact binary
   * `.nvd`; `'json'` is a human-readable/portable JSON document (typed arrays
   * base64-tagged). Both round-trip the same structure; `deserialize` accepts
   * either. `saveDocument` picks `'json'` automatically for a `.json` filename.
   */
  format?: 'cbor' | 'json'
}

// Defaults for the SERIALIZED subset of scene fields (a sparse document omits
// any that match). Derived from NVConstants.SCENE_DEFAULTS so they can't drift.
const SCENE_DOC_DEFAULTS = {
  azimuth: NVConstants.SCENE_DEFAULTS.azimuth,
  elevation: NVConstants.SCENE_DEFAULTS.elevation,
  scaleMultiplier: NVConstants.SCENE_DEFAULTS.scaleMultiplier,
  gamma: NVConstants.SCENE_DEFAULTS.gamma,
  crosshairPos: NVConstants.SCENE_DEFAULTS.crosshairPos,
  pan2Dxyzmm: NVConstants.SCENE_DEFAULTS.pan2Dxyzmm,
  backgroundColor: NVConstants.SCENE_DEFAULTS.backgroundColor,
  clipPlaneColor: NVConstants.SCENE_DEFAULTS.clipPlaneColor,
  isClipPlaneCutaway: NVConstants.SCENE_DEFAULTS.isClipPlaneCutaway,
}

export function serialize(
  model: NVModel,
  slidePlane?: NVDocumentSlidePlane,
  options?: SerializeOptions,
): Uint8Array {
  const policy = options?.settings
  const linkData = options?.linkData ?? false
  // Extract volumes with embedded data. Skip streamed/chunked volumes whose
  // voxels live only in a runtime chunkSource closure (img=null + chunkPlan/
  // chunkSource): they have no bytes to embed and their `streamed://<id>` url is
  // a renderer texture-cache key, not a fetchable resource, so serializing them
  // would drive a broken fetch on reload. Dropping them keeps the remaining
  // (restorable) volumes' relative order intact; the modulationImage link is by
  // volume id and resolves by find-by-id at render time, so a reference to a
  // dropped volume degrades to a no-op rather than corrupting the document.
  const volumes: NVDocumentVolume[] = model.volumes
    .filter((v) => !isTransientStreamedVolume(v))
    .map((v) => {
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
        modulationImage: v.modulationImage,
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

      // Embed volume data for a self-contained document, UNLESS linkData is set
      // and this volume has a fetchable URL (then the loader refetches it). A
      // linked volume with no usable URL still embeds so the document round-trips.
      if (v.hdr && v.img) {
        if (shouldLinkVolume(v.url, linkData)) {
          // linked: bytes omitted, loader fetches from v.url
        } else {
          if (linkData) {
            log.warn(
              `serialize: volume "${v.name ?? v.url ?? '(unnamed)'}" has no linkable URL; embedding its data`,
            )
          }
          const imgData = typedArrayToBytes(v.img)
          const hdrData = extractHeaderData(v.hdr)
          // A partial 4D volume loaded from a local File cannot be deferred-reloaded
          // after restore: `_sourceFile` is runtime-only (not serialized) and `url` is
          // just the bare filename. Collapse the saved header's frame count to the
          // frames actually embedded, so the restored volume presents as complete and
          // the graph offers no dead deferred action. URL-sourced self-contained-NII
          // partials have no `_sourceFile`, keep their full dims, and still reload
          // correctly on restore. Detached-header formats (AFNI .HEAD+.BRIK, NRRD
          // .nhdr+.raw, MRtrix detached .mif, MetaImage detached .mha) also can't be
          // deferred-reloaded after restore: `_urlImageData` is runtime-only (same
          // allowlist contract as `_sourceFile`), so a saved partial would offer a
          // dead deferred action — collapse it too.
          const partial = (v.nFrame4D ?? 1) < (v.nTotalFrame4D ?? 1)
          if (partial && (v._sourceFile != null || v._urlImageData != null)) {
            // Represent the loaded prefix as a flat 4D sequence of `nFrame4D` frames.
            // For a rare partial 5D/6D File volume this intentionally flattens the
            // higher axes — only the first nFrame4D frames were loaded (not a clean
            // multiple of dims[5]/dims[6]), so a flat 4D count is the only faithful
            // representation of what the document actually contains.
            const n = v.nFrame4D ?? 1
            hdrData.dims[0] = n > 1 ? 4 : 3
            hdrData.dims[4] = n
            hdrData.dims[5] = 1
            hdrData.dims[6] = 1
          }
          vol.data = {
            hdr: hdrData,
            img: imgData,
            datatypeCode: v.hdr.datatypeCode,
          }
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
      sliceShaderType: m.sliceShaderType,
      color: m.color,
      isColorbarVisible: m.isColorbarVisible,
      isLegendVisible: m.isLegendVisible,
      kind: m.kind,
    }

    // Meshes are always embedded, even under linkData: the mesh URL-restore path
    // does not yet reapply scalar-overlay layers or tract/connectome options, so
    // linking a mesh would silently drop that state. linkData covers volumes
    // (whose URL-restore is complete); mesh linking is a tracked follow-up.
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
    if (m.kind === 'tract' && m.trx) {
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
    if (m.kind === 'connectome' && m.jcon) {
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

  const signals: SerializedSignal[] = model.signals.map(serializeSignal)

  const doc: NVDocumentData = {
    version: DOCUMENT_VERSION,
    created: new Date().toISOString(),
    // Settings groups are sparse: each `sparsifyGroup` drops any setting equal to
    // its default (honoring the caller's neverSave/alwaysSave policy). Omitted
    // settings are left at the loading instance's current value.
    scene: sparsifyGroup(
      'scene',
      {
        azimuth: model.scene.azimuth,
        elevation: model.scene.elevation,
        scaleMultiplier: model.scene.scaleMultiplier,
        gamma: model.scene.gamma,
        crosshairPos: [
          model.scene.crosshairPos[0],
          model.scene.crosshairPos[1],
          model.scene.crosshairPos[2],
        ] as [number, number, number],
        pan2Dxyzmm: [
          model.scene.pan2Dxyzmm[0],
          model.scene.pan2Dxyzmm[1],
          model.scene.pan2Dxyzmm[2],
          model.scene.pan2Dxyzmm[3],
        ] as [number, number, number, number],
        backgroundColor: [...model.scene.backgroundColor] as [
          number,
          number,
          number,
          number,
        ],
        clipPlaneColor: [...model.scene.clipPlaneColor],
        isClipPlaneCutaway: model.scene.isClipPlaneCutaway,
      },
      SCENE_DOC_DEFAULTS,
      policy,
    ),
    layout: sparsifyGroup(
      'layout',
      model.layout,
      NVConstants.LAYOUT_DEFAULTS,
      policy,
    ),
    ui: sparsifyGroup('ui', model.ui, NVConstants.UI_DEFAULTS, policy),
    volume: sparsifyGroup(
      'volume',
      model.volume,
      NVConstants.VOLUME_DEFAULTS,
      policy,
    ),
    mesh: sparsifyGroup('mesh', model.mesh, NVConstants.MESH_DEFAULTS, policy),
    draw: sparsifyGroup('draw', model.draw, NVConstants.DRAW_DEFAULTS, policy),
    interaction: sparsifyGroup(
      'interaction',
      model.interaction,
      NVConstants.INTERACTION_DEFAULTS,
      policy,
    ),
    clipPlanes: [...model.clipPlanes],
    drawingBitmapRLE: model.drawingVolume
      ? encodeRLE(getDrawingBitmap(model.drawingVolume))
      : undefined,
    drawingBitmapLength: model.drawingVolume
      ? getDrawingBitmap(model.drawingVolume).length
      : undefined,
    volumes,
    meshes,
    signals: signals.length > 0 ? signals : undefined,
    annotations: model.annotations.length > 0 ? model.annotations : undefined,
    annotationConfig: sparsifyGroup(
      'annotation',
      model.annotation,
      NVConstants.ANNOTATION_DEFAULTS,
      policy,
    ),
    slidePlane,
  }

  if (options?.format === 'json') {
    return new TextEncoder().encode(encodeDocumentJSON(doc))
  }
  return encode(doc)
}

export function deserialize(data: Uint8Array): NVDocumentData {
  // Accept either encoding: JSON (first non-whitespace byte `{`) or CBOR.
  const doc = looksLikeJSON(data)
    ? (decodeDocumentJSON(new TextDecoder().decode(data)) as NVDocumentData)
    : (decode(data) as NVDocumentData)

  // Version check
  if (typeof doc.version !== 'number') {
    throw new Error('Invalid NVD file: missing version')
  }
  if (doc.version > DOCUMENT_VERSION) {
    throw new Error(
      `NVD file version ${doc.version} is newer than supported version ${DOCUMENT_VERSION}`,
    )
  }

  // Validate required fields
  if (!doc.scene || !doc.layout) {
    throw new Error('Invalid NVD file: missing required fields')
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
  fill?: SettingsFillPolicy,
): void {
  // Apply scene state. Sparse (v9+) documents omit any field left at its default;
  // a field the document OMITS is filled per `fill` (default: reset to its
  // built-in default; 'current': leave the loading instance's value). A field the
  // document specifies always wins.
  const sd = NVConstants.SCENE_DEFAULTS
  const s = doc.scene
  // scalars
  const scalar = <V>(key: string, docVal: V | undefined, def: V, cur: V): V =>
    docVal !== undefined
      ? docVal
      : fillModeFor('scene', key, fill) === 'current'
        ? cur
        : def
  model.scene.azimuth = scalar(
    'azimuth',
    s.azimuth,
    sd.azimuth,
    model.scene.azimuth,
  )
  model.scene.elevation = scalar(
    'elevation',
    s.elevation,
    sd.elevation,
    model.scene.elevation,
  )
  model.scene.scaleMultiplier = scalar(
    'scaleMultiplier',
    s.scaleMultiplier,
    sd.scaleMultiplier,
    model.scene.scaleMultiplier,
  )
  model.scene.gamma = scalar('gamma', s.gamma, sd.gamma, model.scene.gamma)
  model.scene.isClipPlaneCutaway = scalar(
    'isClipPlaneCutaway',
    s.isClipPlaneCutaway,
    sd.isClipPlaneCutaway,
    model.scene.isClipPlaneCutaway,
  )
  // vecs (mutate in place): omit + 'current' => leave; else write doc/default
  const fillVec = (
    key: string,
    docVal: readonly number[] | undefined,
    def: readonly number[],
    target: { length: number; [i: number]: number },
  ): void => {
    const src =
      docVal ?? (fillModeFor('scene', key, fill) === 'current' ? null : def)
    if (!src) return
    for (let i = 0; i < target.length; i++) target[i] = src[i]
  }
  fillVec(
    'crosshairPos',
    s.crosshairPos,
    sd.crosshairPos,
    model.scene.crosshairPos,
  )
  fillVec('pan2Dxyzmm', s.pan2Dxyzmm, sd.pan2Dxyzmm, model.scene.pan2Dxyzmm)
  // plain arrays (reassign a copy; never alias SCENE_DEFAULTS)
  const fillArr = (
    key: string,
    docVal: readonly number[] | undefined,
    def: readonly number[],
    cur: number[],
  ): number[] =>
    docVal
      ? [...docVal]
      : fillModeFor('scene', key, fill) === 'current'
        ? cur
        : [...def]
  model.scene.backgroundColor = fillArr(
    'backgroundColor',
    s.backgroundColor,
    sd.backgroundColor,
    model.scene.backgroundColor,
  ) as [number, number, number, number]
  model.scene.clipPlaneColor = fillArr(
    'clipPlaneColor',
    s.clipPlaneColor,
    sd.clipPlaneColor,
    model.scene.clipPlaneColor,
  )

  // Config groups: fillGroup resolves every key (doc wins; omitted -> default or
  // current per `fill`), so a document is a complete scene by default.
  const C = NVConstants
  Object.assign(
    model.layout,
    fillGroup('layout', model.layout, C.LAYOUT_DEFAULTS, doc.layout, fill),
  )
  Object.assign(
    model.ui,
    fillGroup('ui', model.ui, C.UI_DEFAULTS, doc.ui, fill),
  )
  Object.assign(
    model.volume,
    fillGroup('volume', model.volume, C.VOLUME_DEFAULTS, doc.volume, fill),
  )
  Object.assign(
    model.mesh,
    fillGroup('mesh', model.mesh, C.MESH_DEFAULTS, doc.mesh, fill),
  )
  Object.assign(
    model.draw,
    fillGroup('draw', model.draw, C.DRAW_DEFAULTS, doc.draw, fill),
  )
  Object.assign(
    model.interaction,
    fillGroup(
      'interaction',
      model.interaction,
      C.INTERACTION_DEFAULTS,
      doc.interaction,
      fill,
    ),
  )
  // annotation config resolved the same way, after the annotations array below

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
  // annotation config resolves like the other groups (doc wins; omitted ->
  // default or current per `fill`).
  Object.assign(
    model.annotation,
    fillGroup(
      'annotation',
      model.annotation,
      NVConstants.ANNOTATION_DEFAULTS,
      doc.annotationConfig,
      fill,
    ),
  )

  // Restore signals (data is embedded, so no async fetch is needed). Route each
  // through addSignal so unique-id handling and graph-cache invalidation run (a
  // direct `model.signals = ...` would skip both, leaving a stale _assocCache for
  // the new signal set). Reset the cursor AND the zoom/pan window so a window
  // from the previous scene isn't clamped onto the restored graph.
  model.signals = []
  for (const sig of doc.signals ?? []) model.addSignal(reconstructSignal(sig))
  model.signalCursorX = null
  model.signalViewWindow = null

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
        v.name ?? 'volume',
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
      // The modulator link is just a volume-id string; resolution is deferred
      // to render time (find-by-id), so it is safe even if the modulator volume
      // is restored later in this loop.
      if (v.modulationImage !== undefined)
        vol.modulationImage = v.modulationImage
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
      const kind = m.kind ?? 'mesh'
      const meshOpts: Record<string, unknown> = {
        kind,
        url: m.url,
        name: m.name,
        opacity: m.opacity,
        shaderType: m.shaderType,
        sliceShaderType: m.sliceShaderType,
        color: m.color,
        isColorbarVisible: m.isColorbarVisible,
        isLegendVisible: m.isLegendVisible,
        perVertexColors,
        layers,
      }

      // Restore tract source data so retessellateTract() works
      if (kind === 'tract' && m.tractData) {
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
      if (kind === 'connectome' && m.connectomeData) {
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
        sliceShaderType: m.sliceShaderType,
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
  const a = document.createElement('a')
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
  const name = filename.endsWith('.nvd') ? filename : `${filename}.nvd`
  downloadBlob(new Blob([buffer], { type: 'application/cbor' }), name)
}
