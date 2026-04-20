/**
 * Web Worker for nv-image-processing transforms.
 *
 * Speaks only primitives — no NIFTI header objects cross the boundary.
 *
 * Protocol (NVWorker bridge):
 *   Request:  { _wbId, name, img, datatypeCode, sclSlope, sclInter, ...options }
 *   Response: { _wbId, img, datatypeCode, bitsPerVoxel, sclSlope, sclInter, calMin, calMax }
 *   Error:    { _wbId, _wbError: string }
 */

const post = (self as unknown as { postMessage: (msg: unknown, transfer?: Transferable[]) => void }).postMessage.bind(self);

import { findOtsu, applyOtsu, applyHazeRemoval } from "./processing/otsu";
import { computeConform } from "./processing/conform";
import { computeConnectedLabel } from "./processing/connectedLabel";

/**
 * Wrap an ArrayBuffer as a typed view based on NIfTI datatype code.
 * Self-contained (no niivue imports) to keep the inline worker bundle small.
 */
function toTypedView(img: ArrayLike<number> | ArrayBuffer, dt: number): ArrayLike<number> {
  if (!(img instanceof ArrayBuffer)) return img;
  switch (dt) {
    case 2: return new Uint8Array(img);
    case 4: return new Int16Array(img);
    case 8: return new Int32Array(img);
    case 16: return new Float32Array(img);
    case 64: return new Float64Array(img);
    case 256: return new Int8Array(img);
    case 512: return new Uint16Array(img);
    case 768: return new Uint32Array(img);
    default: return new Float32Array(img);
  }
}

/** Compute scaled min/max from voxel data. */
function computeMinMax(data: ArrayLike<number>, slope: number, inter: number): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] * slope + inter;
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

interface WorkerResult {
  img: ArrayBufferView;
  datatypeCode: number;
  bitsPerVoxel: number;
  sclSlope: number;
  sclInter: number;
  calMin: number;
  calMax: number;
}

type Handler = (
  img: ArrayLike<number>,
  datatypeCode: number,
  sclSlope: number,
  sclInter: number,
  options: Record<string, unknown>,
) => WorkerResult;

const handlers: Record<string, Handler> = {
  otsu(img, datatypeCode, sclSlope, sclInter, options) {
    const levels = (options.levels as number) ?? 3;
    const data = toTypedView(img, datatypeCode);
    const slope = sclSlope || 1;
    const inter = sclInter || 0;
    const [calMin, calMax] = computeMinMax(data, slope, inter);
    const thresholds = findOtsu(data, calMin, calMax, inter, slope, levels);
    return {
      img: applyOtsu(data, thresholds),
      datatypeCode: 2,
      bitsPerVoxel: 8,
      sclSlope: 1,
      sclInter: 0,
      calMin: 0,
      calMax: levels,
    };
  },

  removeHaze(img, datatypeCode, sclSlope, sclInter, options) {
    const level = (options.level as number) ?? 5;
    const otsuLevel = level === 5 || level === 1 ? 4 : level === 4 || level === 2 ? 3 : 2;
    const data = toTypedView(img, datatypeCode);
    const slope = sclSlope || 1;
    const inter = sclInter || 0;
    const [calMin, calMax] = computeMinMax(data, slope, inter);
    const thresholds = findOtsu(data, calMin, calMax, inter, slope, otsuLevel);
    const threshold = level === 1 ? thresholds[2] : level === 2 ? thresholds[1] : thresholds[0];
    return {
      img: applyHazeRemoval(data, inter, slope, calMin, threshold),
      datatypeCode: 16,
      bitsPerVoxel: 32,
      sclSlope: 1,
      sclInter: 0,
      calMin,
      calMax,
    };
  },

  conform(img, datatypeCode, sclSlope, sclInter, options) {
    const result = computeConform({
      img,
      datatypeCode,
      dims: options.dims as number[],
      pixDims: options.pixDims as number[],
      affine: options.affine as number[],
      sclSlope: sclSlope || 1,
      sclInter: sclInter || 0,
      toRAS: (options.toRAS as boolean) ?? false,
      isLinear: (options.isLinear as boolean) ?? true,
      asFloat32: (options.asFloat32 as boolean) ?? false,
      isRobustMinMax: (options.isRobustMinMax as boolean) ?? false,
    });
    return {
      img: result.img,
      datatypeCode: result.datatypeCode,
      bitsPerVoxel: result.bitsPerVoxel,
      sclSlope: result.sclSlope,
      sclInter: result.sclInter,
      calMin: result.calMin,
      calMax: result.calMax,
      // Extra fields for conform (new header geometry)
      dims: result.dims,
      pixDims: result.pixDims,
      affine: result.affine,
    };
  },

  connectedLabel(img, datatypeCode, sclSlope, sclInter, options) {
    const result = computeConnectedLabel({
      img,
      datatypeCode,
      dims: options.dims as number[],
      conn: (options.conn as number) ?? 26,
      binarize: (options.binarize as boolean) ?? false,
      onlyLargestClusterPerClass: (options.onlyLargestClusterPerClass as boolean) ?? false,
    });
    return {
      img: result.img,
      datatypeCode: result.datatypeCode,
      bitsPerVoxel: result.bitsPerVoxel,
      sclSlope: 1,
      sclInter: 0,
      calMin: 0,
      calMax: result.calMax,
    };
  },
};

self.onmessage = (e: MessageEvent) => {
  const { _wbId: id, name, img, datatypeCode, sclSlope, sclInter, options } = e.data;
  const handler = handlers[name];
  if (!handler) {
    post({ _wbId: id, _wbError: `Unknown transform: ${name}` });
    return;
  }
  try {
    const result = handler(img, datatypeCode, sclSlope, sclInter, options ?? {});
    post({ _wbId: id, ...result }, [result.img.buffer as ArrayBuffer]);
  } catch (err: unknown) {
    post({ _wbId: id, _wbError: err instanceof Error ? err.message : String(err) });
  }
};
