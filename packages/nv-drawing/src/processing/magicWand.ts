/**
 * Magic Wand (click-to-segment) algorithm.
 * Pure functions — no DOM or Worker dependencies.
 *
 * Given a seed voxel and a background intensity volume, flood-fills all
 * connected voxels whose intensity falls within the specified thresholds.
 * Supports 2D (single-slice) and 3D modes, configurable connectivity
 * (6/18/26 neighbours), and optional maximum distance from the seed.
 */

import type { DrawingDims, RASIndexMap } from "./drawing";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Neighbour connectivity for the flood fill BFS. */
export type Connectivity = 6 | 18 | 26;

/**
 * Threshold mode controls how the intensity range is computed from the seed.
 *
 * - `"symmetric"` (default) — range = `[seed - tolerance, seed + tolerance]`.
 * - `"percent"` — range = `[seed * (1 - percent), seed * (1 + percent)]`.
 *   Requires {@link MagicWandOptions.percent}.
 * - `"bright"` — only voxels **≥** seed are included:
 *   range = `[seed, seed + tolerance]` (or `[seed, Infinity]` when tolerance is 0).
 * - `"dark"` — only voxels **≤** seed are included:
 *   range = `[seed - tolerance, seed]` (or `[-Infinity, seed]` when tolerance is 0).
 * - `"auto"` — automatically choose `"bright"` or `"dark"` based on whether
 *   the seed intensity is above or below the midpoint of `calMin`/`calMax`.
 *   Requires {@link MagicWandOptions.calMin} and {@link MagicWandOptions.calMax}.
 *   When combined with `percent`, the range is computed as percent-based
 *   but only on the bright or dark side.
 */
export type ThresholdMode =
  | "symmetric"
  | "percent"
  | "bright"
  | "dark"
  | "auto";

/** Options that control the magic-wand behaviour. */
export interface MagicWandOptions {
  /**
   * Absolute tolerance around the seed intensity (default 0).
   * Range becomes `[seed - tolerance, seed + tolerance]`.
   * Ignored when `intensityMin`/`intensityMax` are both provided,
   * or when `thresholdMode` is `"percent"`.
   */
  tolerance?: number;
  /** Explicit minimum intensity threshold (overrides all other range logic). */
  intensityMin?: number;
  /** Explicit maximum intensity threshold (overrides all other range logic). */
  intensityMax?: number;
  /**
   * How the intensity range is derived from the seed (default `"symmetric"`).
   * See {@link ThresholdMode} for details.
   */
  thresholdMode?: ThresholdMode;
  /**
   * Percentage threshold (0–1) used when `thresholdMode` is `"percent"` or
   * `"auto"`. Range becomes `[seed * (1-pct), seed * (1+pct)]`.
   * Equivalent to `clickToSegmentPercent` in the old niivue API.
   */
  percent?: number;
  /**
   * Volume calibration minimum — needed for `thresholdMode: "auto"` to
   * determine bright vs dark. Equivalent to `back.cal_min`.
   */
  calMin?: number;
  /**
   * Volume calibration maximum — needed for `thresholdMode: "auto"` to
   * determine bright vs dark. Equivalent to `back.cal_max`.
   */
  calMax?: number;
  /** Neighbour connectivity (default 6). */
  connectivity?: Connectivity;
  /** Maximum Euclidean distance from the seed in **mm** (default Infinity). */
  maxDistanceMM?: number;
  /** If true, constrain fill to the seed's 2-D slice. */
  is2D?: boolean;
  /** Slice axis when `is2D` is true (0 = axial/Z, 1 = coronal/Y, 2 = sagittal/X). */
  sliceAxis?: number;
  /** Pen colour to write into the bitmap (default 1). */
  penValue?: number;
}

/** Result returned by `magicWand`. */
export interface MagicWandResult {
  /** Number of voxels that were filled. */
  filledCount: number;
  /** The seed voxel intensity. */
  seedIntensity: number;
  /** Actual intensity min used. */
  intensityMin: number;
  /** Actual intensity max used. */
  intensityMax: number;
  /**
   * Whether the auto-detect resolved to "bright" (`true`) or "dark" (`false`).
   * Only meaningful when `thresholdMode` was `"auto"`.
   */
  isBright?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Flat index for RAS voxel (x,y,z). */
function rasIdx(x: number, y: number, z: number, dims: DrawingDims): number {
  return x + y * dims.dimX + z * dims.dimX * dims.dimY;
}

/**
 * Flat index for RAS voxel (rx,ry,rz) in header-ordered image data.
 * When no map is provided, assumes header order === RAS order.
 */
function imgIdx(
  rx: number,
  ry: number,
  rz: number,
  dims: DrawingDims,
  rasMap?: RASIndexMap,
): number {
  if (!rasMap) return rasIdx(rx, ry, rz, dims);
  const { img2RASstep: s, img2RASstart: o } = rasMap;
  return o[0] + rx * s[0] + o[1] + ry * s[1] + o[2] + rz * s[2];
}

/** Face-neighbour offsets (6-connectivity). */
const FACE: [number, number, number][] = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];

/** Edge-neighbour offsets (additional 12 for 18-connectivity). */
const EDGE: [number, number, number][] = [
  [-1, -1, 0],
  [1, -1, 0],
  [-1, 1, 0],
  [1, 1, 0],
  [0, -1, -1],
  [0, 1, -1],
  [-1, 0, -1],
  [1, 0, -1],
  [0, -1, 1],
  [0, 1, 1],
  [-1, 0, 1],
  [1, 0, 1],
];

/** Corner-neighbour offsets (additional 8 for 26-connectivity). */
const CORNER: [number, number, number][] = [
  [-1, -1, -1],
  [1, -1, -1],
  [-1, 1, -1],
  [1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [-1, 1, 1],
  [1, 1, 1],
];

function getNeighbourOffsets(
  connectivity: Connectivity,
): [number, number, number][] {
  if (connectivity >= 26) return [...FACE, ...EDGE, ...CORNER];
  if (connectivity >= 18) return [...FACE, ...EDGE];
  return [...FACE];
}

// ---------------------------------------------------------------------------
// Public: magicWand
// ---------------------------------------------------------------------------

/**
 * Flood-fill (magic wand / click-to-segment) starting from a **RAS-voxel**
 * seed coordinate.
 *
 * @param seed        - `[x, y, z]` RAS-voxel coordinate of the seed.
 * @param drawBitmap  - Drawing bitmap in RAS voxel order (modified **in-place**).
 * @param dims        - Volume dimensions in RAS space.
 * @param imageData   - Background intensity volume (may be header-ordered).
 * @param options     - See {@link MagicWandOptions}.
 * @param rasMap      - Optional RAS→header index mapping for `imageData`.
 * @param voxelSizeMM - Voxel size in mm `[sx, sy, sz]` for distance constraints.
 *                       Required when `maxDistanceMM` is finite.
 * @returns Result summary (number of voxels filled, thresholds used, etc.).
 */
export function magicWand(
  seed: [number, number, number],
  drawBitmap: Uint8Array,
  dims: DrawingDims,
  imageData: ArrayLike<number>,
  options: MagicWandOptions = {},
  rasMap?: RASIndexMap,
  voxelSizeMM?: [number, number, number],
): MagicWandResult {
  const {
    tolerance = 0,
    thresholdMode = "symmetric",
    percent = 0,
    calMin = 0,
    calMax = 1,
    connectivity = 6,
    maxDistanceMM = Number.POSITIVE_INFINITY,
    is2D = false,
    sliceAxis = 0,
    penValue = 1,
  } = options;

  const { dimX, dimY, dimZ } = dims;
  const nVox = dimX * dimY * dimZ;

  // --- Validate seed ---
  const [sx, sy, sz] = seed;
  if (sx < 0 || sy < 0 || sz < 0 || sx >= dimX || sy >= dimY || sz >= dimZ) {
    return {
      filledCount: 0,
      seedIntensity: 0,
      intensityMin: 0,
      intensityMax: 0,
    };
  }

  // --- Seed intensity & thresholds ---
  const seedFlatImg = imgIdx(sx, sy, sz, dims, rasMap);
  const seedIntensity = Number(imageData[seedFlatImg]);

  let lo: number;
  let hi: number;
  let isBright: boolean | undefined;

  if (
    options.intensityMin !== undefined &&
    options.intensityMax !== undefined
  ) {
    // Explicit range overrides everything
    lo = options.intensityMin;
    hi = options.intensityMax;
  } else {
    // Resolve effective mode ("auto" picks bright vs dark)
    let effectiveMode: "symmetric" | "percent" | "bright" | "dark" =
      thresholdMode === "auto" ? "symmetric" : thresholdMode;
    if (thresholdMode === "auto") {
      isBright = seedIntensity > (calMin + calMax) * 0.5;
      effectiveMode = isBright ? "bright" : "dark";
    }

    switch (effectiveMode) {
      case "percent": {
        // Range = [seed*(1-pct), seed*(1+pct)], matching old clickToSegmentPercent
        const eff = seedIntensity === 0 ? 0.01 : seedIntensity;
        lo = eff * (1 - percent);
        hi = eff * (1 + percent);
        break;
      }
      case "bright":
        // Only voxels at or above the seed
        if (percent > 0) {
          const eff = seedIntensity === 0 ? 0.01 : seedIntensity;
          lo = eff * (1 - percent);
          hi = eff * (1 + percent);
        } else if (tolerance > 0) {
          lo = seedIntensity;
          hi = seedIntensity + tolerance;
        } else {
          lo = seedIntensity;
          hi = Number.POSITIVE_INFINITY;
        }
        break;
      case "dark":
        // Only voxels at or below the seed
        if (percent > 0) {
          const eff = seedIntensity === 0 ? 0.01 : seedIntensity;
          lo = eff * (1 - percent);
          hi = eff * (1 + percent);
        } else if (tolerance > 0) {
          lo = seedIntensity - tolerance;
          hi = seedIntensity;
        } else {
          lo = Number.NEGATIVE_INFINITY;
          hi = seedIntensity;
        }
        break;
      default: // "symmetric"
        lo = seedIntensity - tolerance;
        hi = seedIntensity + tolerance;
        break;
    }
  }

  // --- Neighbour offsets ---
  const offsets = getNeighbourOffsets(connectivity);

  // --- Distance helpers ---
  const vsX = voxelSizeMM ? voxelSizeMM[0] : 1;
  const vsY = voxelSizeMM ? voxelSizeMM[1] : 1;
  const vsZ = voxelSizeMM ? voxelSizeMM[2] : 1;
  const maxDist2 = maxDistanceMM * maxDistanceMM;

  function withinDistance(x: number, y: number, z: number): boolean {
    if (!Number.isFinite(maxDist2)) return true;
    const dx = (x - sx) * vsX;
    const dy = (y - sy) * vsY;
    const dz = (z - sz) * vsZ;
    return dx * dx + dy * dy + dz * dz <= maxDist2;
  }

  // --- Constrained axis for 2-D fill ---
  // sliceAxis: 0 = axial → constrain Z; 1 = coronal → constrain Y; 2 = sagittal → constrain X
  let constrainDim = -1; // -1 = no constraint
  let constrainVal = -1;
  if (is2D) {
    if (sliceAxis === 0) {
      constrainDim = 2;
      constrainVal = sz;
    } else if (sliceAxis === 1) {
      constrainDim = 1;
      constrainVal = sy;
    } else if (sliceAxis === 2) {
      constrainDim = 0;
      constrainVal = sx;
    }
  }

  // --- BFS flood fill ---
  // We use a visited array to avoid re-visiting voxels.
  const visited = new Uint8Array(nVox);
  const seedFlat = rasIdx(sx, sy, sz, dims);

  // Check seed itself
  if (seedIntensity < lo || seedIntensity > hi) {
    return {
      filledCount: 0,
      seedIntensity,
      intensityMin: lo,
      intensityMax: hi,
      isBright,
    };
  }

  // BFS queue stores flat RAS indices
  const queue: number[] = [seedFlat];
  visited[seedFlat] = 1;
  let filledCount = 0;

  while (queue.length > 0) {
    const idx = queue.shift()!;
    // Decode flat → xyz
    const iz = Math.floor(idx / (dimX * dimY));
    const iy = Math.floor((idx - iz * dimX * dimY) / dimX);
    const ix = idx - iz * dimX * dimY - iy * dimX;

    // Paint this voxel
    drawBitmap[idx] = penValue;
    filledCount++;

    // Explore neighbours
    for (const [dx, dy, dz] of offsets) {
      const nx = ix + dx;
      const ny = iy + dy;
      const nz = iz + dz;
      // Bounds check
      if (nx < 0 || ny < 0 || nz < 0 || nx >= dimX || ny >= dimY || nz >= dimZ)
        continue;
      // 2-D constraint
      if (constrainDim >= 0) {
        const coord = constrainDim === 0 ? nx : constrainDim === 1 ? ny : nz;
        if (coord !== constrainVal) continue;
      }
      const nFlat = rasIdx(nx, ny, nz, dims);
      if (visited[nFlat]) continue;
      visited[nFlat] = 1;
      // Distance constraint
      if (!withinDistance(nx, ny, nz)) continue;
      // Intensity constraint
      const nIntensity = Number(imageData[imgIdx(nx, ny, nz, dims, rasMap)]);
      if (nIntensity < lo || nIntensity > hi) continue;
      queue.push(nFlat);
    }
  }

  return {
    filledCount,
    seedIntensity,
    intensityMin: lo,
    intensityMax: hi,
    isBright,
  };
}

// ---------------------------------------------------------------------------
// Public: magicWandFromBitmap  (erase cluster / recolor cluster)
// ---------------------------------------------------------------------------

/**
 * Flood-fill a connected cluster of identically-coloured voxels
 * in the drawing bitmap, starting from `seed`.  Useful for erasing
 * or recolouring an existing drawn region without reference to the
 * underlying image intensity.
 *
 * @param seed       - `[x, y, z]` RAS-voxel coordinate of the seed.
 * @param drawBitmap - Drawing bitmap in RAS voxel order (modified **in-place**).
 * @param dims       - Volume dimensions in RAS space.
 * @param newColor   - Colour to apply (0 = erase).
 * @param connectivity - Neighbour connectivity (default 6).
 * @returns Number of voxels changed.
 */
export function magicWandFromBitmap(
  seed: [number, number, number],
  drawBitmap: Uint8Array,
  dims: DrawingDims,
  newColor: number,
  connectivity: Connectivity = 6,
): number {
  const { dimX, dimY, dimZ } = dims;
  const [sx, sy, sz] = seed;
  if (sx < 0 || sy < 0 || sz < 0 || sx >= dimX || sy >= dimY || sz >= dimZ)
    return 0;

  const seedFlat = rasIdx(sx, sy, sz, dims);
  const seedColor = drawBitmap[seedFlat];

  // Nothing to do if already the desired colour or seed is empty & we want to erase
  if (seedColor === newColor) return 0;
  if (seedColor === 0) return 0;

  const nVox = dimX * dimY * dimZ;
  const visited = new Uint8Array(nVox);
  const offsets = getNeighbourOffsets(connectivity);

  const queue: number[] = [seedFlat];
  visited[seedFlat] = 1;
  let count = 0;

  while (queue.length > 0) {
    const idx = queue.shift()!;
    drawBitmap[idx] = newColor;
    count++;

    const iz = Math.floor(idx / (dimX * dimY));
    const iy = Math.floor((idx - iz * dimX * dimY) / dimX);
    const ix = idx - iz * dimX * dimY - iy * dimX;

    for (const [dx, dy, dz] of offsets) {
      const nx = ix + dx;
      const ny = iy + dy;
      const nz = iz + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= dimX || ny >= dimY || nz >= dimZ)
        continue;
      const nFlat = rasIdx(nx, ny, nz, dims);
      if (visited[nFlat]) continue;
      visited[nFlat] = 1;
      if (drawBitmap[nFlat] !== seedColor) continue;
      queue.push(nFlat);
    }
  }

  return count;
}
