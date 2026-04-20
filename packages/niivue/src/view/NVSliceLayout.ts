import { type mat4, vec3, vec4 } from "gl-matrix";
import * as NVTransforms from "@/math/NVTransforms";
import * as NVConstants from "@/NVConstants";
import type NVModel from "@/NVModel";
import type { ViewHitTest } from "@/NVTypes";
import type { BuildLineFn, LineData } from "./NVLine";

// ---------- Types ----------

type ScreenInfo = { mnMM: vec3; mxMM: vec3; fovMM: vec3 };

export type SliceTile = {
  leftTopWidthHeight?: number[];
  axCorSag: number;
  screen?: ScreenInfo;
  azimuth?: number;
  elevation?: number;
  sliceMM?: number;
  renderOrientation?: number;
  crossLines?: { axialMM: number[]; coronalMM: number[]; sagittalMM: number[] };
  showLabels?: boolean;
  // Cached during render loop for fast interactive picking
  mvpMatrix?: mat4;
  planeNormal?: vec3;
  planePoint?: vec3;
};

export type SliceLayoutConfig = {
  canvasWH: [number, number];
  extentsMin: vec3;
  extentsMax: vec3;
  sliceType: number;
  tileMargin?: number;
  isRadiologicalConvention?: boolean;
  multiplanarLayout?: number;
  multiplanarShowRender?: number;
  sliceMosaicString?: string;
  heroImageFraction?: number;
  heroSliceType?: number;
  isMultiplanarEqualSize?: boolean;
  isCrossLines?: boolean;
  isCenterMosaic?: boolean;
};

// ---------- Helpers ----------

const rotations = (sliceType: number, isRadiological = false) => {
  if (sliceType === NVConstants.SLICE_TYPE.SAGITTAL)
    return { azimuth: isRadiological ? 90 : -90, elevation: 0 };
  if (sliceType === NVConstants.SLICE_TYPE.CORONAL)
    return { azimuth: isRadiological ? 180 : 0, elevation: 0 };
  if (sliceType === NVConstants.SLICE_TYPE.AXIAL)
    return {
      azimuth: isRadiological ? 180 : 0,
      elevation: isRadiological ? -90 : 90,
    };
  return { azimuth: 0, elevation: 0 };
};

// idxMap maps each orientation to [inPlaneU, inPlaneV, depth] indices into XYZ
const IDX_MAP = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 2, 0],
]; // axial, coronal, sagittal

/** Map pan2Dxyzmm (world X,Y,Z + zoom) to tile-local [panU, panV, zoom]. */
export function slicePanUV(
  pan: ArrayLike<number>,
  axCorSag: number,
): [number, number, number] {
  const map = IDX_MAP[axCorSag];
  return [pan[map[0]], pan[map[1]], pan[3] ?? 1];
}

const buildScreens = (
  extentsMin: vec3,
  extentsMax: vec3,
  isRadiological: boolean,
): SliceTile[] => {
  const range = vec3.create();
  vec3.sub(range, extentsMax, extentsMin);
  return IDX_MAP.map((map, i) => {
    const mn = vec3.fromValues(
      extentsMin[map[0]],
      extentsMin[map[1]],
      extentsMin[map[2]],
    );
    const mx = vec3.fromValues(
      extentsMax[map[0]],
      extentsMax[map[1]],
      extentsMax[map[2]],
    );
    const fov = vec3.fromValues(range[map[0]], range[map[1]], range[map[2]]);
    const axCorSag = i;
    return {
      axCorSag,
      screen: { mnMM: mn, mxMM: mx, fovMM: fov },
      ...rotations(axCorSag, isRadiological),
    };
  });
};

const buildEqualScreens = (
  extentsMin: vec3,
  extentsMax: vec3,
  isRadiological: boolean,
  maxDim: number,
): SliceTile[] => {
  return IDX_MAP.map((map, i) => {
    const centerU = (extentsMin[map[0]] + extentsMax[map[0]]) / 2;
    const centerV = (extentsMin[map[1]] + extentsMax[map[1]]) / 2;
    const half = maxDim / 2;
    const mn = vec3.fromValues(
      centerU - half,
      centerV - half,
      extentsMin[map[2]],
    );
    const mx = vec3.fromValues(
      centerU + half,
      centerV + half,
      extentsMax[map[2]],
    );
    const fov = vec3.fromValues(
      maxDim,
      maxDim,
      extentsMax[map[2]] - extentsMin[map[2]],
    );
    const axCorSag = i;
    return {
      axCorSag,
      screen: { mnMM: mn, mxMM: mx, fovMM: fov },
      ...rotations(axCorSag, isRadiological),
    };
  });
};

const cloneScreen = (s: ScreenInfo): ScreenInfo => ({
  mnMM: vec3.clone(s.mnMM),
  mxMM: vec3.clone(s.mxMM),
  fovMM: vec3.clone(s.fovMM),
});

// Tile mm dimensions (in-plane width x height) for an orientation
const tileDimsMM = (
  orient: number,
  range: vec3,
  isEqual: boolean,
  maxDim: number,
): [number, number] => {
  if (isEqual) return [maxDim, maxDim];
  if (orient === NVConstants.SLICE_TYPE.AXIAL) return [range[0], range[1]];
  if (orient === NVConstants.SLICE_TYPE.CORONAL) return [range[0], range[2]];
  return [range[1], range[2]]; // sagittal
};

// ---------- Pack helpers ----------

const packRow = (
  canvasWH: number[],
  tileMargin: number,
  sizes: { w: number; h: number }[],
  order: Array<Partial<SliceTile>> = [],
): SliceTile[] => {
  const totalW =
    sizes.reduce((s, t) => s + t.w, 0) + tileMargin * (sizes.length - 1);
  const maxH = Math.max(...sizes.map((t) => t.h));
  const baseX = (canvasWH[0] - totalW) / 2;
  const baseY = (canvasWH[1] - maxH) / 2;
  let x = baseX;
  return sizes.map((t, i) => {
    const y = baseY + (maxH - t.h) / 2;
    const rect = { leftTopWidthHeight: [x, y, t.w, t.h] };
    x += t.w + tileMargin;
    return { ...rect, ...(order[i] ?? {}) } as SliceTile;
  });
};

const packColumn = (
  canvasWH: number[],
  tileMargin: number,
  sizes: { w: number; h: number }[],
  order: Array<Partial<SliceTile>> = [],
): SliceTile[] => {
  const totalH =
    sizes.reduce((s, t) => s + t.h, 0) + tileMargin * (sizes.length - 1);
  const maxW = Math.max(...sizes.map((t) => t.w));
  const baseX = (canvasWH[0] - maxW) / 2;
  const baseY = (canvasWH[1] - totalH) / 2;
  let y = baseY;
  return sizes.map((t, i) => {
    const x = baseX + (maxW - t.w) / 2;
    const rect = { leftTopWidthHeight: [x, y, t.w, t.h] };
    y += t.h + tileMargin;
    return { ...rect, ...(order[i] ?? {}) } as SliceTile;
  });
};

// ---------- Mosaic ----------

function parseMosaicLayout(config: SliceLayoutConfig): SliceTile[] {
  const str = (config.sliceMosaicString ?? "").trim();
  if (!str) return [];

  const { extentsMin, extentsMax, canvasWH } = config;
  const isRad = config.isRadiologicalConvention ?? false;
  const tileMargin = config.tileMargin ?? 0;
  const isEqual = config.isMultiplanarEqualSize ?? false;
  const isCenterMosaic = config.isCenterMosaic ?? true;
  const globalCrossLines = config.isCrossLines ?? false;

  const range = vec3.create();
  vec3.sub(range, extentsMax, extentsMin);
  const maxDim = Math.max(range[0], range[1], range[2]);

  const screens = isEqual
    ? buildEqualScreens(extentsMin, extentsMax, isRad, maxDim)
    : buildScreens(extentsMin, extentsMax, isRad);

  const tokens = str
    .replace(/;/g, " ; ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  type TileDesc = {
    orient: number;
    sliceMM: number;
    isRender: boolean;
    isCrossLines: boolean;
    showLabels: boolean;
    w: number;
    h: number;
  };

  // Collect slice mm positions for cross-lines
  const axialMM: number[] = [];
  const coronalMM: number[] = [];
  const sagittalMM: number[] = [];

  const rows: TileDesc[][] = [];
  let currentRow: TileDesc[] = [];
  let orient = NVConstants.SLICE_TYPE.AXIAL as number;
  let isRender = false;
  let nextCrossLines = false;
  let labelsOn = false;

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === "A") {
      orient = NVConstants.SLICE_TYPE.AXIAL;
      continue;
    }
    if (upper === "C") {
      orient = NVConstants.SLICE_TYPE.CORONAL;
      continue;
    }
    if (upper === "S") {
      orient = NVConstants.SLICE_TYPE.SAGITTAL;
      continue;
    }
    if (upper === "R") {
      isRender = true;
      continue;
    }
    if (upper === "X") {
      nextCrossLines = true;
      continue;
    }
    if (upper === "L") {
      labelsOn = true;
      continue;
    }
    if (upper === "L-") {
      labelsOn = false;
      continue;
    }
    if (upper === ";") {
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [];
      continue;
    }

    const mm = parseFloat(token);
    if (Number.isNaN(mm)) continue;

    const [w, h] = tileDimsMM(orient, range, isEqual, maxDim);

    currentRow.push({
      orient,
      sliceMM: mm,
      isRender,
      isCrossLines: nextCrossLines || (globalCrossLines && isRender),
      showLabels: labelsOn,
      w,
      h,
    });

    if (!isRender) {
      if (orient === NVConstants.SLICE_TYPE.AXIAL) axialMM.push(mm);
      else if (orient === NVConstants.SLICE_TYPE.CORONAL) coronalMM.push(mm);
      else sagittalMM.push(mm);
    }

    nextCrossLines = false;
    isRender = false;
  }
  if (currentRow.length > 0) rows.push(currentRow);
  if (rows.length === 0) return [];

  // Compute row content dimensions in mm (margins are pixel-space, kept separate)
  const rowContentWidths = rows.map((row) =>
    row.reduce((sum, t) => sum + t.w, 0),
  );
  const rowHeights = rows.map((row) => Math.max(...row.map((t) => t.h)));
  const totalContentH = rowHeights.reduce((s, h) => s + h, 0);

  if (totalContentH <= 0) return [];

  // Compute zoom: subtract pixel margins from available canvas space first
  const vMarginsPx = tileMargin * Math.max(0, rows.length - 1);
  const zoomV = (canvasWH[1] - vMarginsPx) / totalContentH;
  const zoomH = Math.min(
    ...rows.map((row, i) => {
      const hMarginsPx = tileMargin * Math.max(0, row.length - 1);
      return rowContentWidths[i] > 0
        ? (canvasWH[0] - hMarginsPx) / rowContentWidths[i]
        : Infinity;
    }),
  );
  const zoom = Math.min(zoomH, zoomV);

  if (zoom <= 0) return [];

  // Compute total pixel dimensions for centering
  const widestRowPx = Math.max(
    ...rows.map((row, i) => {
      const hMarginsPx = tileMargin * Math.max(0, row.length - 1);
      return rowContentWidths[i] * zoom + hMarginsPx;
    }),
  );
  const totalHPx = totalContentH * zoom + vMarginsPx;

  let marginLeft = 0;
  let marginTop = 0;
  if (isCenterMosaic) {
    marginLeft = (canvasWH[0] - widestRowPx) / 2;
    marginTop = (canvasWH[1] - totalHPx) / 2;
  }

  const tiles: SliceTile[] = [];
  let y = 0;

  for (let r = 0; r < rows.length; r++) {
    // Center each row horizontally
    const rowPx =
      rowContentWidths[r] * zoom + tileMargin * Math.max(0, rows[r].length - 1);
    let x = marginLeft + (widestRowPx - rowPx) / 2;
    for (const desc of rows[r]) {
      const w = desc.w * zoom;
      const h = desc.h * zoom;
      const yOff = (rowHeights[r] * zoom - h) / 2;

      const rot = rotations(desc.orient, isRad);
      let azimuth = rot.azimuth;
      if (desc.isRender && (desc.sliceMM < 0 || Object.is(desc.sliceMM, -0))) {
        azimuth += 180;
      }

      const tile: SliceTile = {
        leftTopWidthHeight: [x, marginTop + y + yOff, w, h],
        axCorSag: desc.isRender ? NVConstants.SLICE_TYPE.RENDER : desc.orient,
        screen: cloneScreen(screens[desc.orient].screen!),
        azimuth,
        elevation: rot.elevation,
        showLabels: desc.showLabels,
      };

      if (!desc.isRender) {
        tile.sliceMM = desc.sliceMM;
      }

      if (desc.isRender) {
        tile.renderOrientation = desc.orient;
        if (desc.isCrossLines) {
          tile.crossLines = {
            axialMM: [...axialMM],
            coronalMM: [...coronalMM],
            sagittalMM: [...sagittalMM],
          };
        }
      }

      tiles.push(tile);
      x += w + tileMargin;
    }
    y += rowHeights[r] * zoom + tileMargin;
  }

  return tiles;
}

// ---------- Hero ----------

function heroLayout(config: SliceLayoutConfig): SliceTile[] {
  const { canvasWH, extentsMin, extentsMax } = config;
  const isRad = config.isRadiologicalConvention ?? false;
  const tileMargin = config.tileMargin ?? 0;
  const heroFraction = config.heroImageFraction ?? 0;
  const heroType = config.heroSliceType ?? NVConstants.SLICE_TYPE.RENDER;
  const isEqual = config.isMultiplanarEqualSize ?? false;

  const range = vec3.create();
  vec3.sub(range, extentsMax, extentsMin);
  const maxDim = Math.max(range[0], range[1], range[2]);

  const screens = isEqual
    ? buildEqualScreens(extentsMin, extentsMax, isRad, maxDim)
    : buildScreens(extentsMin, extentsMax, isRad);

  const heroW = canvasWH[0] * heroFraction;
  const remainW = canvasWH[0] - heroW - tileMargin;

  // Build hero tile
  let heroTile: SliceTile;
  if (heroType === NVConstants.SLICE_TYPE.RENDER) {
    heroTile = {
      axCorSag: NVConstants.SLICE_TYPE.RENDER,
      leftTopWidthHeight: [0, 0, heroW, canvasWH[1]],
    };
  } else {
    const screen = screens[heroType];
    const fov = screen.screen?.fovMM;
    const zoom = Math.min(heroW / fov[0], canvasWH[1] / fov[1]);
    const w = fov[0] * zoom;
    const h = fov[1] * zoom;
    heroTile = {
      axCorSag: heroType,
      screen: cloneScreen(screen.screen!),
      azimuth: screen.azimuth,
      elevation: screen.elevation,
      leftTopWidthHeight: [(heroW - w) / 2, (canvasWH[1] - h) / 2, w, h],
    };
  }

  // Layout remaining A+C+S in reduced space
  const remaining = layoutMultiplanar({
    ...config,
    canvasWH: [remainW, canvasWH[1]],
    heroImageFraction: 0,
    multiplanarShowRender: NVConstants.SHOW_RENDER.NEVER,
  });

  // Offset remaining tiles to the right of hero
  const offset = heroW + tileMargin;
  for (const tile of remaining) {
    if (tile.leftTopWidthHeight) {
      tile.leftTopWidthHeight[0] += offset;
    }
  }

  return [heroTile, ...remaining];
}

// ---------- Multiplanar ----------

type Candidate = { type: number; hasRender: boolean; zoom: number };

function layoutMultiplanar(config: SliceLayoutConfig): SliceTile[] {
  const { canvasWH, extentsMin, extentsMax } = config;
  const isRad = config.isRadiologicalConvention ?? false;
  const tileMargin = config.tileMargin ?? 0;
  const multiplanarLayout =
    config.multiplanarLayout ?? NVConstants.MULTIPLANAR_TYPE.AUTO;
  const multiplanarShowRender =
    config.multiplanarShowRender ?? NVConstants.SHOW_RENDER.AUTO;
  const isEqual = config.isMultiplanarEqualSize ?? false;

  const range = vec3.create();
  vec3.sub(range, extentsMax, extentsMin);
  const maxDim = Math.max(range[0], range[1], range[2]);

  const screens = isEqual
    ? buildEqualScreens(extentsMin, extentsMax, isRad, maxDim)
    : buildScreens(extentsMin, extentsMax, isRad);

  // Tile dimensions in mm
  const wAx = isEqual ? maxDim : range[0];
  const hAx = isEqual ? maxDim : range[1];
  const wCor = isEqual ? maxDim : range[0];
  const hCor = isEqual ? maxDim : range[2];
  const wSag = isEqual ? maxDim : range[1];
  const hSag = isEqual ? maxDim : range[2];

  const rowZoom = Math.min(
    (canvasWH[0] - 2 * tileMargin) / (wAx + wCor + wSag),
    canvasWH[1] / Math.max(hAx, hCor, hSag),
  );
  const rowZoomR = Math.min(
    (canvasWH[0] - 3 * tileMargin) / (wAx + wCor + wSag + maxDim),
    canvasWH[1] / Math.max(hAx, hCor, hSag, maxDim),
  );
  const colZoom = Math.min(
    canvasWH[0] / Math.max(wAx, wCor, wSag),
    (canvasWH[1] - 2 * tileMargin) / (hAx + hCor + hSag),
  );
  const colZoomR = Math.min(
    canvasWH[0] / Math.max(wAx, wCor, wSag, maxDim),
    (canvasWH[1] - 3 * tileMargin) / (hAx + hCor + hSag + maxDim),
  );
  const gridZoom = Math.min(
    (canvasWH[0] - tileMargin) / (wAx + wSag),
    (canvasWH[1] - tileMargin) / (hAx + hCor),
  );

  const candidates: Candidate[] = [
    { type: NVConstants.MULTIPLANAR_TYPE.ROW, hasRender: false, zoom: rowZoom },
    {
      type: NVConstants.MULTIPLANAR_TYPE.COLUMN,
      hasRender: false,
      zoom: colZoom,
    },
    {
      type: NVConstants.MULTIPLANAR_TYPE.GRID,
      hasRender: false,
      zoom: gridZoom,
    },
    { type: NVConstants.MULTIPLANAR_TYPE.ROW, hasRender: true, zoom: rowZoomR },
    {
      type: NVConstants.MULTIPLANAR_TYPE.COLUMN,
      hasRender: true,
      zoom: colZoomR,
    },
    {
      type: NVConstants.MULTIPLANAR_TYPE.GRID,
      hasRender: true,
      zoom: gridZoom,
    },
  ];

  const best =
    candidates
      .filter((c) => {
        if (
          multiplanarLayout !== NVConstants.MULTIPLANAR_TYPE.AUTO &&
          c.type !== multiplanarLayout
        )
          return false;
        if (multiplanarShowRender === NVConstants.SHOW_RENDER.ALWAYS)
          return c.hasRender;
        if (multiplanarShowRender === NVConstants.SHOW_RENDER.NEVER)
          return !c.hasRender;
        if (
          c.hasRender &&
          multiplanarShowRender === NVConstants.SHOW_RENDER.AUTO
        ) {
          const base = candidates.find(
            (x) => x.type === c.type && !x.hasRender,
          );
          return !base || c.zoom >= base.zoom - 0.0001;
        }
        return true;
      })
      .sort((a, b) => {
        if (Math.abs(b.zoom - a.zoom) > 0.0001) return b.zoom - a.zoom;
        return (b.hasRender ? 1 : 0) - (a.hasRender ? 1 : 0);
      })[0] || candidates[0];

  const [ax, cor, sag] = screens;
  const ren: SliceTile = { axCorSag: NVConstants.SLICE_TYPE.RENDER };

  const z = best.zoom;
  const sAxial = { w: wAx * z, h: hAx * z };
  const sCoronal = { w: wCor * z, h: hCor * z };
  const sSagittal = { w: wSag * z, h: hSag * z };
  const renderSize = maxDim * z;

  if (best.type === NVConstants.MULTIPLANAR_TYPE.ROW) {
    const tiles = [sAxial, sCoronal, sSagittal];
    const views = [ax, cor, sag];
    if (best.hasRender) {
      tiles.push({ w: renderSize, h: renderSize });
      views.push(ren);
    }
    return packRow(canvasWH, tileMargin, tiles, views);
  }

  if (best.type === NVConstants.MULTIPLANAR_TYPE.COLUMN) {
    const tiles = [sAxial, sCoronal, sSagittal];
    const views = [ax, cor, sag];
    if (best.hasRender) {
      tiles.push({ w: renderSize, h: renderSize });
      views.push(ren);
    }
    return packColumn(canvasWH, tileMargin, tiles, views);
  }

  // GRID
  const gridRenderSize = Math.min(sSagittal.w, sAxial.h);
  const totalW = sAxial.w + sSagittal.w + tileMargin;
  const totalH = sAxial.h + sCoronal.h + tileMargin;
  const offX = (canvasWH[0] - totalW) / 2;
  const offY = (canvasWH[1] - totalH) / 2;
  const tiles = [
    { ...cor, leftTopWidthHeight: [offX, offY, sCoronal.w, sCoronal.h] },
    {
      ...ax,
      leftTopWidthHeight: [
        offX,
        offY + sCoronal.h + tileMargin,
        sAxial.w,
        sAxial.h,
      ],
    },
    {
      ...sag,
      leftTopWidthHeight: [
        offX + sCoronal.w + tileMargin,
        offY,
        sSagittal.w,
        sSagittal.h,
      ],
    },
  ];
  if (best.hasRender) {
    tiles.push({
      ...ren,
      leftTopWidthHeight: [
        offX + sCoronal.w + tileMargin,
        offY + sCoronal.h + tileMargin,
        gridRenderSize,
        gridRenderSize,
      ],
    });
  }
  return tiles;
}

// ---------- Main entry point ----------

export function screenSlicesLayout(config: SliceLayoutConfig): SliceTile[] {
  const { canvasWH, extentsMin, extentsMax } = config;
  const sliceType = config.sliceType;
  const isRad = config.isRadiologicalConvention ?? false;
  const isEqual = config.isMultiplanarEqualSize ?? false;
  const mosaic = config.sliceMosaicString ?? "";
  const heroFraction = config.heroImageFraction ?? 0;

  // Mosaic overrides everything
  if (mosaic.trim().length > 0) {
    return parseMosaicLayout(config);
  }

  // Render-only
  if (sliceType === NVConstants.SLICE_TYPE.RENDER) {
    return [
      {
        leftTopWidthHeight: [0, 0, canvasWH[0], canvasWH[1]],
        axCorSag: sliceType,
      },
    ];
  }

  const range = vec3.create();
  vec3.sub(range, extentsMax, extentsMin);
  const maxDim = Math.max(range[0], range[1], range[2]);

  const screens = isEqual
    ? buildEqualScreens(extentsMin, extentsMax, isRad, maxDim)
    : buildScreens(extentsMin, extentsMax, isRad);

  // Single slice
  if (sliceType !== NVConstants.SLICE_TYPE.MULTIPLANAR) {
    const idx = sliceType; // AXIAL=0, CORONAL=1, SAGITTAL=2
    const fov = screens[idx].screen?.fovMM;
    const zoom = Math.min(canvasWH[0] / fov[0], canvasWH[1] / fov[1]);
    const w = fov[0] * zoom;
    const h = fov[1] * zoom;
    return [
      {
        ...screens[idx],
        leftTopWidthHeight: [
          (canvasWH[0] - w) / 2,
          (canvasWH[1] - h) / 2,
          w,
          h,
        ],
      },
    ];
  }

  // Hero image (multiplanar with hero)
  if (heroFraction > 0 && heroFraction < 1) {
    return heroLayout(config);
  }

  // Standard multiplanar
  return layoutMultiplanar(config);
}

// ---------- Picking ----------

export function screenSlicePick(
  screenSlices: SliceTile[],
  model: NVModel,
  canvasX: number,
  canvasY: number,
  hit: ViewHitTest,
): [number, number, number] | null {
  const tile = screenSlices[hit.tileIndex];
  if (!tile || hit.isRender) return null;
  const ltwh = tile.leftTopWidthHeight as number[];
  if (model.volumes.length === 0) return null;
  if (!model.tex2mm) return null;
  const nx = Math.max(0, Math.min(1, (canvasX - ltwh[0]) / ltwh[2]));
  const ny = Math.max(0, Math.min(1, (canvasY - ltwh[1]) / ltwh[3]));
  // Fast path: use cached MVP and plane from last render
  if (tile.mvpMatrix && tile.planeNormal && tile.planePoint) {
    return NVTransforms.intersectPlane(
      nx,
      ny,
      tile.mvpMatrix,
      tile.planeNormal,
      tile.planePoint,
    );
  }
  // Fallback: recompute (first frame before cache is populated)
  const screen = tile.screen as { mnMM: number[]; mxMM: number[] };
  if (!screen) return null;
  const pan = slicePanUV(model.scene.pan2Dxyzmm, tile.axCorSag);
  const [mvpMatrix] = NVTransforms.calculateMvpMatrix2D(
    ltwh,
    screen.mnMM,
    screen.mxMM,
    Infinity,
    undefined,
    tile.azimuth as number,
    tile.elevation as number,
    model.layout.isRadiological,
    model.volumes[0]?.obliqueRAS,
    undefined,
    pan,
  );
  const sliceDim = NVConstants.sliceTypeDim(hit.sliceType);
  const sliceFrac =
    tile.sliceMM !== undefined
      ? model.getSliceTexFracAtMM(sliceDim, tile.sliceMM)
      : model.getSliceTexFrac(sliceDim);
  return NVTransforms.intersectSlicePlane(
    nx,
    ny,
    mvpMatrix as mat4,
    model.tex2mm,
    hit.sliceType,
    sliceFrac,
  );
}

// ---------- Cross-lines ----------

export function buildCrossLines(
  tile: SliceTile,
  mvpMatrix: mat4,
  extentsMin: vec3,
  extentsMax: vec3,
  thickness: number,
  color: number[],
  lineFn: BuildLineFn,
): LineData[] {
  if (
    !tile.crossLines ||
    tile.renderOrientation === undefined ||
    !tile.leftTopWidthHeight
  )
    return [];
  const orient = tile.renderOrientation;
  const ltwh = tile.leftTopWidthHeight;
  const lines: LineData[] = [];
  // IDX_MAP[orient] = [uDim, vDim, depthDim]
  const [uDim, vDim, depthDim] = IDX_MAP[orient];
  const depthCenter = (extentsMin[depthDim] + extentsMax[depthDim]) / 2;

  // Project a world mm point to canvas pixel coordinates via the tile's MVP
  const project = (x: number, y: number, z: number): [number, number] => {
    const clip = vec4.create();
    vec4.transformMat4(clip, vec4.fromValues(x, y, z, 1), mvpMatrix);
    return [
      ltwh[0] + (clip[0] + 1) * 0.5 * ltwh[2],
      ltwh[1] + (1 - clip[1]) * 0.5 * ltwh[3],
    ];
  };

  // Build a 3D point from swizzled U, V, depth values
  const makePoint = (
    u: number,
    v: number,
    d: number,
  ): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0];
    p[uDim] = u;
    p[vDim] = v;
    p[depthDim] = d;
    return p;
  };

  // Each cross-line set maps to a real mm dimension
  const sets = [
    { mmValues: tile.crossLines.axialMM, dim: 2 },
    { mmValues: tile.crossLines.coronalMM, dim: 1 },
    { mmValues: tile.crossLines.sagittalMM, dim: 0 },
  ];

  for (const { mmValues, dim } of sets) {
    if (dim === depthDim || mmValues.length === 0) continue;
    for (const mm of mmValues) {
      if (dim === vDim) {
        // Horizontal line: span full U extent at this V position
        const [x1, y1] = project(
          ...makePoint(extentsMin[uDim], mm, depthCenter),
        );
        const [x2, y2] = project(
          ...makePoint(extentsMax[uDim], mm, depthCenter),
        );
        lines.push(lineFn(x1, y1, x2, y2, thickness, color));
      } else if (dim === uDim) {
        // Vertical line: span full V extent at this U position
        const [x1, y1] = project(
          ...makePoint(mm, extentsMin[vDim], depthCenter),
        );
        const [x2, y2] = project(
          ...makePoint(mm, extentsMax[vDim], depthCenter),
        );
        lines.push(lineFn(x1, y1, x2, y2, thickness, color));
      }
    }
  }
  return lines;
}
