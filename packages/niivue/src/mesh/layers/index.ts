import * as NVCmaps from "@/cmap/NVCmaps";
import { log } from "@/logger";
import { COLORMAP_TYPE } from "@/NVConstants";
import * as NVLoader from "@/NVLoader";
import type { LUT, MeshLayerFromUrlOptions, NVMeshLayer } from "@/NVTypes";
import { resolveNegativeRange } from "@/view/NVUILayout";

// --- Layer reader auto-discovery ---

type LayerReadResult = {
  values: Float32Array;
  nFrame4D: number;
  colormapLabel?: LUT | null;
  colormapType?: number;
  isTransparentBelowCalMin?: boolean;
};

type LayerReader = {
  extensions?: string[];
  read: (
    buffer: ArrayBuffer,
    nVert: number,
  ) => LayerReadResult | Promise<LayerReadResult>;
  isCurv?: (buffer: ArrayBuffer) => boolean;
};

const layerModules = import.meta.glob<LayerReader>("./readers/*.ts", {
  eager: true,
});
const layerReaderByExt = NVLoader.buildExtensionMap(layerModules);
let curvReader: LayerReader | null = null;
for (const mod of Object.values(layerModules)) {
  if (typeof mod.isCurv === "function") {
    curvReader = mod;
    break;
  }
}

// Mesh readers that support scalar-only mode (n_vert > 0)
// Imported directly to avoid circular dependency with NVMesh.ts
type MeshReader = {
  extensions?: string[];
  read: (
    buffer: ArrayBufferLike,
    n_vert?: number,
  ) => Promise<{ scalars?: Float32Array; colormapLabel?: unknown }>;
};
const meshReaderModules = import.meta.glob<MeshReader>("../readers/*.ts", {
  eager: true,
});
const meshReaderByExt = NVLoader.buildExtensionMap(meshReaderModules);

// Volume readers for NII/MGH as vertex scalars
type VolumeReader = {
  extensions?: string[];
  read: (
    buffer: ArrayBuffer,
    name?: string,
  ) => Promise<{
    hdr: {
      dims: number[];
      scl_slope: number;
      scl_inter: number;
      datatypeCode: number;
    };
    img: ArrayBuffer | Float32Array;
  }>;
};
const volumeReaderModules = import.meta.glob<VolumeReader>(
  "../../volume/readers/*.ts",
  { eager: true },
);
const volumeReaderByExt = NVLoader.buildExtensionMap(volumeReaderModules);

/** Extensions supported for layer loading (scalar-only + mesh scalar + volume) */
export function layerExtensions(): string[] {
  const exts = new Set<string>();
  for (const k of layerReaderByExt.keys()) exts.add(k);
  // MZ3 and GII support scalar-only mode
  exts.add("MZ3");
  exts.add("GII");
  // Volume formats that can provide per-vertex scalars
  exts.add("NII");
  exts.add("MGH");
  exts.add("MGZ");
  return Array.from(exts).sort();
}

// --- Default layer values ---

const LAYER_DEFAULTS: Omit<NVMeshLayer, "values" | "globalMin" | "globalMax"> =
  {
    nFrame4D: 1,
    frame4D: 0,
    calMin: 0,
    calMax: 0,
    calMinNeg: NaN,
    calMaxNeg: NaN,
    opacity: 0.5,
    colormap: "warm",
    colormapNegative: "",
    isColormapInverted: false,
    colormapType: COLORMAP_TYPE.ZERO_TO_MAX_TRANSPARENT_BELOW_MIN,
    isTransparentBelowCalMin: true,
    isAdditiveBlend: false,
    isColorbarVisible: true,
    colormapLabel: null,
    outlineWidth: 0,
  };

// --- Public API ---

/**
 * Create an NVMeshLayer from scalar values with computed min/max and merged options.
 */
export function createLayer(
  values: Float32Array,
  nVert: number,
  options: Partial<NVMeshLayer> = {},
): NVMeshLayer {
  // Compute global min/max
  let mn = values[0];
  let mx = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < mn) mn = values[i];
    if (values[i] > mx) mx = values[i];
  }
  const nFrame4D =
    options.nFrame4D ?? Math.max(1, Math.floor(values.length / nVert));
  const calMin = options.calMin ?? mn;
  const calMax = options.calMax ?? mx;
  // Strip undefined values so they don't override LAYER_DEFAULTS
  const defined = Object.fromEntries(
    Object.entries(options).filter(([, v]) => v !== undefined),
  );
  return {
    ...LAYER_DEFAULTS,
    ...defined,
    values,
    globalMin: mn,
    globalMax: mx,
    calMin,
    calMax,
    nFrame4D,
  };
}

/**
 * Read scalar data from a buffer, dispatching to the appropriate reader.
 * Tries layer-only readers, then mesh readers (MZ3/GII in scalar mode),
 * then volume readers (NII/MGH).
 */
export async function readLayerFile(
  buffer: ArrayBuffer,
  ext: string,
  nVert: number,
): Promise<LayerReadResult> {
  ext = ext.toUpperCase();

  // 1. Layer-only readers (CURV, SMP, STC)
  const layerReader = layerReaderByExt.get(ext);
  if (layerReader) {
    return await layerReader.read(buffer, nVert);
  }

  // 2. Mesh readers in scalar-only mode (MZ3, GII)
  const meshReader = meshReaderByExt.get(ext);
  if (meshReader) {
    const result = await meshReader.read(buffer, nVert);
    if (result.scalars && result.scalars.length > 0) {
      const nFrame = Math.max(1, Math.floor(result.scalars.length / nVert));
      return {
        values: result.scalars,
        nFrame4D: nFrame,
        colormapLabel: result.colormapLabel as LUT | undefined,
      };
    }
    throw new Error(`Mesh reader for ${ext} returned no scalar data`);
  }

  // 3. Volume readers (NII, MGH) — treat voxel data as per-vertex scalars
  const volReader = volumeReaderByExt.get(ext);
  if (volReader) {
    const volResult = await volReader.read(buffer);
    const hdr = volResult.hdr;
    const nVox = hdr.dims[1] * hdr.dims[2] * hdr.dims[3];
    if (nVox !== nVert) {
      log.warn(`Volume has ${nVox} voxels but mesh has ${nVert} vertices`);
    }
    const nFrame = hdr.dims[0] >= 4 ? Math.max(1, hdr.dims[4]) : 1;
    // Convert to Float32Array with slope/intercept scaling
    const rawImg = volResult.img;
    let f32: Float32Array;
    if (rawImg instanceof Float32Array) {
      f32 = rawImg;
    } else {
      f32 = new Float32Array(rawImg);
    }
    // Apply slope/intercept if needed
    const slope = hdr.scl_slope || 1;
    const inter = hdr.scl_inter || 0;
    if (slope !== 1 || inter !== 0) {
      const scaled = new Float32Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        scaled[i] = f32[i] * slope + inter;
      }
      f32 = scaled;
    }
    return { values: f32, nFrame4D: nFrame };
  }

  // 4. Hail-Mary: try FreeSurfer curv detection
  if (curvReader?.isCurv?.(buffer)) {
    return await curvReader.read(buffer, nVert);
  }

  throw new Error(`No layer reader available for extension "${ext}"`);
}

/**
 * Fetch a layer file from URL and read its scalar data.
 */
export async function loadLayerFromUrl(
  url: string | File,
  nVert: number,
): Promise<LayerReadResult> {
  const buffer = await NVLoader.fetchFile(url);
  const ext = NVLoader.getFileExt(url);
  return readLayerFile(buffer, ext, nVert);
}

/**
 * Composite layers over base colors.
 * Writes the result into the target Uint32Array (typically mesh.colors).
 *
 * @param perVertexColors - Per-vertex colors from file (packed ABGR), or null for uniform color
 * @param color - Uniform color [r,g,b,a] in 0-1 range (used when perVertexColors is null)
 * @param layers - Array of NVMeshLayer to composite in order
 * @param target - Output Uint32Array to write composited colors into
 */
export function compositeLayers(
  perVertexColors: Uint32Array | null,
  color: [number, number, number, number],
  layers: NVMeshLayer[],
  target: Uint32Array,
): void {
  const nVert = target.length;

  // Start with base colors
  if (perVertexColors) {
    target.set(perVertexColors);
  } else {
    const packed =
      (Math.round(color[3] * 255) << 24) |
      (Math.round(color[2] * 255) << 16) |
      (Math.round(color[1] * 255) << 8) |
      Math.round(color[0] * 255);
    target.fill(packed);
  }

  for (const layer of layers) {
    if (layer.opacity <= 0) continue;

    const calMin = layer.calMin;
    const calMax = layer.calMax;
    const ct =
      layer.colormapType ?? COLORMAP_TYPE.ZERO_TO_MAX_TRANSPARENT_BELOW_MIN;
    const isZeroBased = ct !== COLORMAP_TYPE.MIN_TO_MAX;

    // Build LUT for this layer
    let lut: Uint8ClampedArray;
    let lutNeg: Uint8ClampedArray | null = null;
    const isLabel = layer.colormapLabel !== null;

    if (isLabel) {
      // Use label colormap directly
      lut = layer.colormapLabel?.lut ?? new Uint8ClampedArray(0);
    } else {
      lut = NVCmaps.lutrgba8(layer.colormap);
      if (layer.colormapNegative) {
        lutNeg = NVCmaps.lutrgba8(layer.colormapNegative);
      }
    }

    // Positive lookup range: [0, cal_max] for zero-based, [cal_min, cal_max] for min-to-max
    const posMn = isZeroBased ? 0 : calMin;
    const posRange = calMax - posMn;

    // Negative calibration range (work with absolute magnitudes)
    const [negThresh, negMaxColor] = resolveNegativeRange(
      calMin,
      calMax,
      layer.calMinNeg,
      layer.calMaxNeg,
    );
    // Negative lookup range: [0, negMaxColor] for zero-based, [negThresh, negMaxColor] for min-to-max
    const negMn = isZeroBased ? 0 : negThresh;
    const negRange = negMaxColor - negMn;

    // Frame offset for 4D
    const frameOffset = layer.frame4D * nVert;

    const opacity = layer.opacity;

    for (let i = 0; i < nVert; i++) {
      const scalar = layer.values[frameOffset + i];
      if (scalar === undefined) continue;

      let lr: number, lg: number, lb: number, la: number;

      if (isLabel) {
        // Label colormap: scalar is an index
        const labelMin = layer.colormapLabel?.min ?? 0;
        const labelMax = layer.colormapLabel?.max ?? 0;
        const labelIdx = Math.round(scalar);
        if (labelIdx < labelMin || labelIdx > labelMax) continue;
        const lutOffset = (labelIdx - labelMin) * 4;
        lr = lut[lutOffset];
        lg = lut[lutOffset + 1];
        lb = lut[lutOffset + 2];
        la = lut[lutOffset + 3];
        if (la === 0) continue; // transparent label
        la = (la * opacity) / 255;
      } else if (lutNeg && scalar < 0) {
        // Negative colormap: use absolute magnitudes
        const absScalar = Math.abs(scalar);
        if (negRange <= 0) continue;
        // Below-threshold behavior for negative values
        if (absScalar < negThresh) {
          if (ct === COLORMAP_TYPE.ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN) {
            // proceed — alpha will be modulated below
          } else if (
            ct === COLORMAP_TYPE.MIN_TO_MAX &&
            !layer.isTransparentBelowCalMin
          ) {
            // proceed — will clamp to min LUT color below
          } else {
            continue; // transparent for MIN_TO_MAX (default), ZERO_TO_MAX_TRANSPARENT
          }
        }
        const frac = (absScalar - negMn) / negRange;
        const idx = Math.max(
          0,
          Math.min(255, Math.round(Math.max(0, Math.min(1, frac)) * 255)),
        );
        const lutIdx = layer.isColormapInverted ? 255 - idx : idx;
        lr = lutNeg[lutIdx * 4];
        lg = lutNeg[lutIdx * 4 + 1];
        lb = lutNeg[lutIdx * 4 + 2];
        la = opacity;
        // Alpha modulation for translucent mode
        if (
          ct === COLORMAP_TYPE.ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN &&
          absScalar < negThresh &&
          negThresh > 0
        ) {
          la *= (absScalar / negThresh) ** 2.0;
        }
      } else {
        // Positive colormap
        if (posRange <= 0) continue;
        // Below-threshold behavior for positive values
        if (scalar >= 0 && scalar < calMin) {
          if (ct === COLORMAP_TYPE.ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN) {
            // proceed — alpha will be modulated below
          } else if (
            ct === COLORMAP_TYPE.MIN_TO_MAX &&
            !layer.isTransparentBelowCalMin
          ) {
            // proceed — will clamp to min LUT color below
          } else {
            continue; // transparent for MIN_TO_MAX (default), ZERO_TO_MAX_TRANSPARENT
          }
        }
        const frac = (scalar - posMn) / posRange;
        const idx = Math.max(
          0,
          Math.min(255, Math.round(Math.max(0, Math.min(1, frac)) * 255)),
        );
        const lutIdx = layer.isColormapInverted ? 255 - idx : idx;
        lr = lut[lutIdx * 4];
        lg = lut[lutIdx * 4 + 1];
        lb = lut[lutIdx * 4 + 2];
        la = opacity;
        // Alpha modulation for translucent mode
        if (
          ct === COLORMAP_TYPE.ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN &&
          scalar > 0 &&
          scalar < calMin &&
          calMin > 0
        ) {
          la *= (scalar / calMin) ** 2.0;
        }
      }

      // Unpack current target color (ABGR little-endian)
      const packed = target[i];
      let dr = packed & 0xff;
      let dg = (packed >> 8) & 0xff;
      let db = (packed >> 16) & 0xff;
      let da = (packed >> 24) & 0xff;

      // Blend
      if (layer.isAdditiveBlend) {
        dr = Math.min(255, dr + Math.round(lr * la));
        dg = Math.min(255, dg + Math.round(lg * la));
        db = Math.min(255, db + Math.round(lb * la));
      } else {
        dr = Math.round(lr * la + dr * (1 - la));
        dg = Math.round(lg * la + dg * (1 - la));
        db = Math.round(lb * la + db * (1 - la));
      }
      da = Math.max(da, Math.round(la * 255));

      target[i] = (da << 24) | (db << 16) | (dg << 8) | dr;
    }
  }
}

/**
 * Load layer options from URLs, create NVMeshLayer objects, and return them.
 */
export async function loadLayersFromOptions(
  layerOptions: MeshLayerFromUrlOptions[],
  nVert: number,
): Promise<NVMeshLayer[]> {
  const layers: NVMeshLayer[] = [];
  for (const opts of layerOptions) {
    const result = await loadLayerFromUrl(opts.url, nVert);
    const urlString = typeof opts.url === "string" ? opts.url : opts.url.name;
    layers.push(
      createLayer(result.values, nVert, {
        nFrame4D: result.nFrame4D,
        colormapLabel: result.colormapLabel ?? null,
        colormapType: opts.colormapType ?? result.colormapType,
        isTransparentBelowCalMin:
          opts.isTransparentBelowCalMin ?? result.isTransparentBelowCalMin,
        colormap: opts.colormap,
        colormapNegative: opts.colormapNegative,
        calMin: opts.calMin,
        calMax: opts.calMax,
        calMinNeg: opts.calMinNeg,
        calMaxNeg: opts.calMaxNeg,
        opacity: opts.opacity,
        isColorbarVisible: opts.isColorbarVisible,
        isColormapInverted: opts.isColormapInverted,
        isAdditiveBlend: opts.isAdditiveBlend,
        outlineWidth: opts.outlineWidth,
        url: urlString,
        name: opts.name ?? urlString,
      }),
    );
  }
  return layers;
}

/**
 * Compute center-of-mass (in mm) for each label region in a mesh layer.
 * Vertex positions are already in mm space, so no affine needed.
 */
export function computeMeshLabelCentroids(
  positions: Float32Array,
  layer: NVMeshLayer,
): Record<string, [number, number, number]> {
  const lut = layer.colormapLabel;
  if (!lut?.labels) return {};

  const labels = lut.labels;
  const lutMin = lut.min ?? 0;
  const lutMax = lut.max ?? labels.length - 1 + lutMin;
  const nVert = positions.length / 3;

  const sumX: Record<string, number> = {};
  const sumY: Record<string, number> = {};
  const sumZ: Record<string, number> = {};
  const count: Record<string, number> = {};

  for (let i = 0; i < nVert; i++) {
    const labelIdx = Math.round(layer.values[i]);
    if (labelIdx < lutMin || labelIdx > lutMax) continue;
    const name = labels[labelIdx - lutMin];
    if (!name) continue;
    const px = positions[i * 3],
      py = positions[i * 3 + 1],
      pz = positions[i * 3 + 2];
    sumX[name] = (sumX[name] ?? 0) + px;
    sumY[name] = (sumY[name] ?? 0) + py;
    sumZ[name] = (sumZ[name] ?? 0) + pz;
    count[name] = (count[name] ?? 0) + 1;
  }

  const centroids: Record<string, [number, number, number]> = {};
  for (const name of Object.keys(count)) {
    const c = count[name];
    if (c > 0) {
      centroids[name] = [sumX[name] / c, sumY[name] / c, sumZ[name] / c];
    }
  }
  return centroids;
}
