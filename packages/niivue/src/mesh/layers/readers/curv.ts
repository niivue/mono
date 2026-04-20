import { log } from "@/logger";
import { COLORMAP_TYPE } from "@/NVConstants";
import type { LUT } from "@/NVTypes";

export const extensions = ["CURV", "CRV", "THICKNESS", "AREA", "SULC"];

export type LayerReadResult = {
  values: Float32Array;
  nFrame4D: number;
  colormapLabel?: LUT | null;
  colormapType?: number;
  isTransparentBelowCalMin?: boolean;
};

/**
 * Detect FreeSurfer curv format by magic bytes (0xFF 0xFF 0xFF).
 */
export function isCurv(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 3) return false;
  const view = new DataView(buffer);
  return (
    view.getUint8(0) === 255 &&
    view.getUint8(1) === 255 &&
    view.getUint8(2) === 255
  );
}

/**
 * Read FreeSurfer curvature format (big-endian).
 * Normalizes values to [0,1] range and inverts (1.0 - normalized).
 */
export function read(buffer: ArrayBuffer, nVert: number): LayerReadResult {
  const view = new DataView(buffer);
  const sig0 = view.getUint8(0);
  const sig1 = view.getUint8(1);
  const sig2 = view.getUint8(2);
  if (sig0 !== 255 || sig1 !== 255 || sig2 !== 255) {
    log.warn("Does not appear to be FreeSurfer curv format");
  }
  const nVertex = view.getUint32(3, false);
  const nTime = view.getUint32(11, false);
  if (nVert !== nVertex) {
    throw new Error(`CURV file has ${nVertex} vertices, expected ${nVert}`);
  }
  if (buffer.byteLength < 15 + 4 * nVertex * nTime) {
    throw new Error("CURV file smaller than specified");
  }
  const f32 = new Float32Array(nTime * nVertex);
  let pos = 15;
  for (let i = 0; i < nTime * nVertex; i++) {
    f32[i] = view.getFloat32(pos, false);
    pos += 4;
  }
  // Normalize to [0,1] and invert
  let mn = f32[0];
  let mx = f32[0];
  for (let i = 1; i < f32.length; i++) {
    if (f32[i] < mn) mn = f32[i];
    if (f32[i] > mx) mx = f32[i];
  }
  const range = mx - mn;
  if (range > 0) {
    const scale = 1.0 / range;
    for (let i = 0; i < f32.length; i++) {
      f32[i] = 1.0 - (f32[i] - mn) * scale;
    }
  }
  return {
    values: f32,
    nFrame4D: Math.max(1, nTime),
    colormapType: COLORMAP_TYPE.MIN_TO_MAX,
    isTransparentBelowCalMin: false,
  };
}
