import { type mat4, vec3, vec4 } from 'gl-matrix'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
import type {
  CustomLayoutTile,
  FocusBox,
  NVGlobalCamera,
  ViewHitTest,
} from '@/NVTypes'
import { getAxisColor } from '@/view/crosshairColor'
import type { BuildLineFn, LineData } from './NVLine'

// ---------- Types ----------

export type ScreenInfo = { mnMM: vec3; mxMM: vec3; fovMM: vec3 }

export type SliceTile = {
  leftTopWidthHeight?: number[]
  axCorSag: number
  screen?: ScreenInfo
  azimuth?: number
  elevation?: number
  sliceMM?: number
  renderOrientation?: number
  crossLines?: { axialMM: number[]; coronalMM: number[]; sagittalMM: number[] }
  showLabels?: boolean
  // Cached during render loop for fast interactive picking
  mvpMatrix?: mat4
  planeNormal?: vec3
  planePoint?: vec3
  // --- Multi-instance fields (used when controller is in `instances` mode) ---
  /** Per-instance 2D pan override (canvas-space normalized) */
  pan?: [number, number]
  /** Per-instance 2D zoom override */
  zoom?: number
  /** Per-instance volume identifier (selects which loaded volume this tile renders) */
  volumeId?: string
  /** When set to `'global3d'`, this tile renders into a shared 3D scene */
  space?: 'canvas' | 'global3d'
  /** Global-space position in world units (used when `space === 'global3d'`) */
  position?: [number, number, number]
  /** Global-space scale (uniform scalar or per-axis vec3) */
  scale?: number | [number, number, number]
  /** Global-space Euler rotation in radians [x, y, z] */
  orientation?: [number, number, number]
  /** Shared 3D camera (passed through from controller) */
  globalCamera?: NVGlobalCamera
}

export type SliceLayoutConfig = {
  canvasWH: [number, number]
  extentsMin: vec3
  extentsMax: vec3
  sliceType: number
  tileMargin?: number
  isRadiologicalConvention?: boolean
  multiplanarLayout?: number
  multiplanarShowRender?: number
  sliceMosaicString?: string
  heroImageFraction?: number
  heroSliceType?: number
  isMultiplanarEqualSize?: boolean
  isCrossLines?: boolean
  isCenterMosaic?: boolean
  isSingleViewFillCanvas?: boolean
  customLayout?: CustomLayoutTile[] | null
}

// ---------- Helpers ----------

const rotations = (sliceType: number, isRadiological = false) => {
  if (sliceType === NVConstants.SLICE_TYPE.SAGITTAL)
    return { azimuth: isRadiological ? 90 : -90, elevation: 0 }
  if (sliceType === NVConstants.SLICE_TYPE.CORONAL)
    return { azimuth: isRadiological ? 180 : 0, elevation: 0 }
  if (sliceType === NVConstants.SLICE_TYPE.AXIAL)
    return {
      azimuth: isRadiological ? 180 : 0,
      elevation: isRadiological ? -90 : 90,
    }
  return { azimuth: 0, elevation: 0 }
}

// idxMap maps each orientation to [inPlaneU, inPlaneV, depth] indices into XYZ
const IDX_MAP = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 2, 0],
] // axial, coronal, sagittal

/** Map pan2Dxyzmm (world X,Y,Z + zoom) to tile-local [panU, panV, zoom]. */
export function slicePanUV(
  pan: ArrayLike<number>,
  axCorSag: number,
): [number, number, number] {
  const map = IDX_MAP[axCorSag]
  return [pan[map[0]], pan[map[1]], pan[3] ?? 1]
}

/**
 * World-mm cylinder radius that makes the crosshair `ui.crosshairWidth` canvas
 * pixels thick on this tile.
 *
 * `crosshairWidth` is a screen weight, like every other piece of UI chrome, and
 * the mosaic cross-lines have always treated it that way. The 2D and 3D
 * crosshairs are world-space cylinders, so the value has to be converted with
 * the tile's own mm-per-pixel or the same setting comes out as a solid block on
 * a millimetre-wide microscopy volume and a hairline on a whole-body scan, and
 * grows as you zoom. Halved because the width is a diameter.
 *
 * Returns 0 for tiles that draw no crosshair (mosaic tiles, global3d tiles) and
 * for degenerate geometry, which callers can use to skip the draw.
 */
export function crosshairRadiusMM(model: NVModel, tile: SliceTile): number {
  const widthPx = model.ui.crosshairWidth
  if (!(widthPx > 0)) return 0
  const ltwh = tile.leftTopWidthHeight
  if (!ltwh) return 0
  let mmPerPixel = 0
  if (tile.axCorSag === NVConstants.SLICE_TYPE.RENDER) {
    mmPerPixel = NVTransforms.mmPerPixelRender(
      ltwh,
      model.furthestFromPivot,
      model.scene.scaleMultiplier,
    )
  } else if (tile.screen) {
    mmPerPixel = NVTransforms.mmPerPixel2D(
      tile.screen.mnMM,
      tile.screen.mxMM,
      ltwh,
      slicePanUV(model.scene.pan2Dxyzmm, tile.axCorSag),
    )
  }
  return (widthPx * mmPerPixel) / 2
}

const buildScreens = (
  extentsMin: vec3,
  extentsMax: vec3,
  isRadiological: boolean,
): SliceTile[] => {
  const range = vec3.create()
  vec3.sub(range, extentsMax, extentsMin)
  return IDX_MAP.map((map, i) => {
    const mn = vec3.fromValues(
      extentsMin[map[0]],
      extentsMin[map[1]],
      extentsMin[map[2]],
    )
    const mx = vec3.fromValues(
      extentsMax[map[0]],
      extentsMax[map[1]],
      extentsMax[map[2]],
    )
    const fov = vec3.fromValues(range[map[0]], range[map[1]], range[map[2]])
    const axCorSag = i
    return {
      axCorSag,
      screen: { mnMM: mn, mxMM: mx, fovMM: fov },
      ...rotations(axCorSag, isRadiological),
    }
  })
}

const buildEqualScreens = (
  extentsMin: vec3,
  extentsMax: vec3,
  isRadiological: boolean,
  maxDim: number,
): SliceTile[] => {
  return IDX_MAP.map((map, i) => {
    const centerU = (extentsMin[map[0]] + extentsMax[map[0]]) / 2
    const centerV = (extentsMin[map[1]] + extentsMax[map[1]]) / 2
    const half = maxDim / 2
    const mn = vec3.fromValues(
      centerU - half,
      centerV - half,
      extentsMin[map[2]],
    )
    const mx = vec3.fromValues(
      centerU + half,
      centerV + half,
      extentsMax[map[2]],
    )
    const fov = vec3.fromValues(
      maxDim,
      maxDim,
      extentsMax[map[2]] - extentsMin[map[2]],
    )
    const axCorSag = i
    return {
      axCorSag,
      screen: { mnMM: mn, mxMM: mx, fovMM: fov },
      ...rotations(axCorSag, isRadiological),
    }
  })
}

const cloneScreen = (s: ScreenInfo): ScreenInfo => ({
  mnMM: vec3.clone(s.mnMM),
  mxMM: vec3.clone(s.mxMM),
  fovMM: vec3.clone(s.fovMM),
})

/**
 * Widen the in-plane mm window about its own centre: scale and centre hold.
 *
 * `fovMM` deliberately keeps the DATA's span while `mnMM`/`mxMM` become the
 * wider ortho window -- the two are equal for every other tile. Chrome that
 * should size against the image rather than the empty margin (the scale ruler)
 * reads `fovMM`; anything projecting the window reads `mnMM`/`mxMM`.
 */
const fillScreen = (s: ScreenInfo, spans: [number, number]): ScreenInfo => {
  const out = cloneScreen(s)
  spans.forEach((span, i) => {
    const centre = (s.mnMM[i] + s.mxMM[i]) / 2
    out.mnMM[i] = centre - span / 2
    out.mxMM[i] = centre + span / 2
  })
  return out
}

// Tile mm dimensions (in-plane width x height) for an orientation
const tileDimsMM = (
  orient: number,
  range: vec3,
  isEqual: boolean,
  maxDim: number,
): [number, number] => {
  if (isEqual) return [maxDim, maxDim]
  if (orient === NVConstants.SLICE_TYPE.AXIAL) return [range[0], range[1]]
  if (orient === NVConstants.SLICE_TYPE.CORONAL) return [range[0], range[2]]
  return [range[1], range[2]] // sagittal
}

// ---------- Pack helpers ----------

const packRow = (
  canvasWH: number[],
  tileMargin: number,
  sizes: { w: number; h: number }[],
  order: Array<Partial<SliceTile>> = [],
): SliceTile[] => {
  const totalW =
    sizes.reduce((s, t) => s + t.w, 0) + tileMargin * (sizes.length - 1)
  const maxH = Math.max(...sizes.map((t) => t.h))
  const baseX = (canvasWH[0] - totalW) / 2
  const baseY = (canvasWH[1] - maxH) / 2
  let x = baseX
  return sizes.map((t, i) => {
    const y = baseY + (maxH - t.h) / 2
    const rect = { leftTopWidthHeight: [x, y, t.w, t.h] }
    x += t.w + tileMargin
    return { ...rect, ...(order[i] ?? {}) } as SliceTile
  })
}

const packColumn = (
  canvasWH: number[],
  tileMargin: number,
  sizes: { w: number; h: number }[],
  order: Array<Partial<SliceTile>> = [],
): SliceTile[] => {
  const totalH =
    sizes.reduce((s, t) => s + t.h, 0) + tileMargin * (sizes.length - 1)
  const maxW = Math.max(...sizes.map((t) => t.w))
  const baseX = (canvasWH[0] - maxW) / 2
  const baseY = (canvasWH[1] - totalH) / 2
  let y = baseY
  return sizes.map((t, i) => {
    const x = baseX + (maxW - t.w) / 2
    const rect = { leftTopWidthHeight: [x, y, t.w, t.h] }
    y += t.h + tileMargin
    return { ...rect, ...(order[i] ?? {}) } as SliceTile
  })
}

// ---------- Mosaic ----------

function parseMosaicLayout(config: SliceLayoutConfig): SliceTile[] {
  const str = (config.sliceMosaicString ?? '').trim()
  if (!str) return []

  const { extentsMin, extentsMax, canvasWH } = config
  const isRad = config.isRadiologicalConvention ?? false
  const tileMargin = config.tileMargin ?? 0
  const isEqual = config.isMultiplanarEqualSize ?? false
  const isCenterMosaic = config.isCenterMosaic ?? true
  const globalCrossLines = config.isCrossLines ?? false

  const range = vec3.create()
  vec3.sub(range, extentsMax, extentsMin)
  const maxDim = Math.max(range[0], range[1], range[2])

  const screens = isEqual
    ? buildEqualScreens(extentsMin, extentsMax, isRad, maxDim)
    : buildScreens(extentsMin, extentsMax, isRad)

  const tokens = str
    .replace(/;/g, ' ; ')
    .split(/\s+/)
    .filter((t) => t.length > 0)

  type TileDesc = {
    orient: number
    sliceMM: number
    isRender: boolean
    isCrossLines: boolean
    showLabels: boolean
    w: number
    h: number
  }

  // Collect slice mm positions for cross-lines
  const axialMM: number[] = []
  const coronalMM: number[] = []
  const sagittalMM: number[] = []

  const rows: TileDesc[][] = []
  let currentRow: TileDesc[] = []
  let orient = NVConstants.SLICE_TYPE.AXIAL as number
  let isRender = false
  let nextCrossLines = false
  let labelsOn = false

  for (const token of tokens) {
    const upper = token.toUpperCase()
    if (upper === 'A') {
      orient = NVConstants.SLICE_TYPE.AXIAL
      continue
    }
    if (upper === 'C') {
      orient = NVConstants.SLICE_TYPE.CORONAL
      continue
    }
    if (upper === 'S') {
      orient = NVConstants.SLICE_TYPE.SAGITTAL
      continue
    }
    if (upper === 'R') {
      isRender = true
      continue
    }
    if (upper === 'X') {
      nextCrossLines = true
      continue
    }
    if (upper === 'L') {
      labelsOn = true
      continue
    }
    if (upper === 'L-') {
      labelsOn = false
      continue
    }
    if (upper === ';') {
      if (currentRow.length > 0) rows.push(currentRow)
      currentRow = []
      continue
    }

    const mm = parseFloat(token)
    if (Number.isNaN(mm)) continue

    const [w, h] = tileDimsMM(orient, range, isEqual, maxDim)

    currentRow.push({
      orient,
      sliceMM: mm,
      isRender,
      isCrossLines: nextCrossLines || (globalCrossLines && isRender),
      showLabels: labelsOn,
      w,
      h,
    })

    if (!isRender) {
      if (orient === NVConstants.SLICE_TYPE.AXIAL) axialMM.push(mm)
      else if (orient === NVConstants.SLICE_TYPE.CORONAL) coronalMM.push(mm)
      else sagittalMM.push(mm)
    }

    nextCrossLines = false
    isRender = false
  }
  if (currentRow.length > 0) rows.push(currentRow)
  if (rows.length === 0) return []

  // Compute row content dimensions in mm (margins are pixel-space, kept separate)
  const rowContentWidths = rows.map((row) =>
    row.reduce((sum, t) => sum + t.w, 0),
  )
  const rowHeights = rows.map((row) => Math.max(...row.map((t) => t.h)))
  const totalContentH = rowHeights.reduce((s, h) => s + h, 0)

  if (totalContentH <= 0) return []

  // Compute zoom: subtract pixel margins from available canvas space first
  const vMarginsPx = tileMargin * Math.max(0, rows.length - 1)
  const zoomV = (canvasWH[1] - vMarginsPx) / totalContentH
  const zoomH = Math.min(
    ...rows.map((row, i) => {
      const hMarginsPx = tileMargin * Math.max(0, row.length - 1)
      return rowContentWidths[i] > 0
        ? (canvasWH[0] - hMarginsPx) / rowContentWidths[i]
        : Infinity
    }),
  )
  const zoom = Math.min(zoomH, zoomV)

  if (zoom <= 0) return []

  // Compute total pixel dimensions for centering
  const widestRowPx = Math.max(
    ...rows.map((row, i) => {
      const hMarginsPx = tileMargin * Math.max(0, row.length - 1)
      return rowContentWidths[i] * zoom + hMarginsPx
    }),
  )
  const totalHPx = totalContentH * zoom + vMarginsPx

  let marginLeft = 0
  let marginTop = 0
  if (isCenterMosaic) {
    marginLeft = (canvasWH[0] - widestRowPx) / 2
    marginTop = (canvasWH[1] - totalHPx) / 2
  }

  const tiles: SliceTile[] = []
  let y = 0

  for (let r = 0; r < rows.length; r++) {
    // Center each row horizontally
    const rowPx =
      rowContentWidths[r] * zoom + tileMargin * Math.max(0, rows[r].length - 1)
    let x = marginLeft + (widestRowPx - rowPx) / 2
    for (const desc of rows[r]) {
      const w = desc.w * zoom
      const h = desc.h * zoom
      const yOff = (rowHeights[r] * zoom - h) / 2

      const rot = rotations(desc.orient, isRad)
      let azimuth = rot.azimuth
      if (desc.isRender && (desc.sliceMM < 0 || Object.is(desc.sliceMM, -0))) {
        azimuth += 180
      }

      const tile: SliceTile = {
        leftTopWidthHeight: [x, marginTop + y + yOff, w, h],
        axCorSag: desc.isRender ? NVConstants.SLICE_TYPE.RENDER : desc.orient,
        screen: cloneScreen(screens[desc.orient].screen as ScreenInfo),
        azimuth,
        elevation: rot.elevation,
        showLabels: desc.showLabels,
      }

      if (!desc.isRender) {
        tile.sliceMM = desc.sliceMM
      }

      if (desc.isRender) {
        tile.renderOrientation = desc.orient
        if (desc.isCrossLines) {
          tile.crossLines = {
            axialMM: [...axialMM],
            coronalMM: [...coronalMM],
            sagittalMM: [...sagittalMM],
          }
        }
      }

      tiles.push(tile)
      x += w + tileMargin
    }
    y += rowHeights[r] * zoom + tileMargin
  }

  return tiles
}

// ---------- Hero ----------

function heroLayout(config: SliceLayoutConfig): SliceTile[] {
  const { canvasWH, extentsMin, extentsMax } = config
  const isRad = config.isRadiologicalConvention ?? false
  const tileMargin = config.tileMargin ?? 0
  const heroFraction = config.heroImageFraction ?? 0
  const heroType = config.heroSliceType ?? NVConstants.SLICE_TYPE.RENDER
  const isEqual = config.isMultiplanarEqualSize ?? false

  const range = vec3.create()
  vec3.sub(range, extentsMax, extentsMin)
  const maxDim = Math.max(range[0], range[1], range[2])

  const screens = isEqual
    ? buildEqualScreens(extentsMin, extentsMax, isRad, maxDim)
    : buildScreens(extentsMin, extentsMax, isRad)

  const heroW = canvasWH[0] * heroFraction
  const remainW = canvasWH[0] - heroW - tileMargin

  // Build hero tile
  let heroTile: SliceTile
  if (heroType === NVConstants.SLICE_TYPE.RENDER) {
    heroTile = {
      axCorSag: NVConstants.SLICE_TYPE.RENDER,
      leftTopWidthHeight: [0, 0, heroW, canvasWH[1]],
    }
  } else {
    const screen = screens[heroType]
    const fov = screen.screen?.fovMM
    if (!fov) {
      throw new Error('Missing fovMM for hero slice')
    }
    const zoom = Math.min(heroW / fov[0], canvasWH[1] / fov[1])
    const w = fov[0] * zoom
    const h = fov[1] * zoom
    heroTile = {
      axCorSag: heroType,
      screen: cloneScreen(screen.screen as ScreenInfo),
      azimuth: screen.azimuth,
      elevation: screen.elevation,
      leftTopWidthHeight: [(heroW - w) / 2, (canvasWH[1] - h) / 2, w, h],
    }
  }

  // Layout remaining A+C+S in reduced space
  const remaining = layoutMultiplanar({
    ...config,
    canvasWH: [remainW, canvasWH[1]],
    heroImageFraction: 0,
    multiplanarShowRender: NVConstants.SHOW_RENDER.NEVER,
  })

  // Offset remaining tiles to the right of hero
  const offset = heroW + tileMargin
  for (const tile of remaining) {
    if (tile.leftTopWidthHeight) {
      tile.leftTopWidthHeight[0] += offset
    }
  }

  return [heroTile, ...remaining]
}

// ---------- Multiplanar ----------

type Candidate = { type: number; hasRender: boolean; zoom: number }

function layoutMultiplanar(config: SliceLayoutConfig): SliceTile[] {
  const { canvasWH, extentsMin, extentsMax } = config
  const isRad = config.isRadiologicalConvention ?? false
  const tileMargin = config.tileMargin ?? 0
  const multiplanarLayout =
    config.multiplanarLayout ?? NVConstants.MULTIPLANAR_TYPE.AUTO
  const multiplanarShowRender =
    config.multiplanarShowRender ?? NVConstants.SHOW_RENDER.AUTO
  const isEqual = config.isMultiplanarEqualSize ?? false

  const range = vec3.create()
  vec3.sub(range, extentsMax, extentsMin)
  const maxDim = Math.max(range[0], range[1], range[2])

  const screens = isEqual
    ? buildEqualScreens(extentsMin, extentsMax, isRad, maxDim)
    : buildScreens(extentsMin, extentsMax, isRad)

  // Tile dimensions in mm
  const wAx = isEqual ? maxDim : range[0]
  const hAx = isEqual ? maxDim : range[1]
  const wCor = isEqual ? maxDim : range[0]
  const hCor = isEqual ? maxDim : range[2]
  const wSag = isEqual ? maxDim : range[1]
  const hSag = isEqual ? maxDim : range[2]

  const rowZoom = Math.min(
    (canvasWH[0] - 2 * tileMargin) / (wAx + wCor + wSag),
    canvasWH[1] / Math.max(hAx, hCor, hSag),
  )
  const rowZoomR = Math.min(
    (canvasWH[0] - 3 * tileMargin) / (wAx + wCor + wSag + maxDim),
    canvasWH[1] / Math.max(hAx, hCor, hSag, maxDim),
  )
  const colZoom = Math.min(
    canvasWH[0] / Math.max(wAx, wCor, wSag),
    (canvasWH[1] - 2 * tileMargin) / (hAx + hCor + hSag),
  )
  const colZoomR = Math.min(
    canvasWH[0] / Math.max(wAx, wCor, wSag, maxDim),
    (canvasWH[1] - 3 * tileMargin) / (hAx + hCor + hSag + maxDim),
  )
  const gridZoom = Math.min(
    (canvasWH[0] - tileMargin) / (wAx + wSag),
    (canvasWH[1] - tileMargin) / (hAx + hCor),
  )

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
  ]

  const best =
    candidates
      .filter((c) => {
        if (
          multiplanarLayout !== NVConstants.MULTIPLANAR_TYPE.AUTO &&
          c.type !== multiplanarLayout
        )
          return false
        if (multiplanarShowRender === NVConstants.SHOW_RENDER.ALWAYS)
          return c.hasRender
        if (multiplanarShowRender === NVConstants.SHOW_RENDER.NEVER)
          return !c.hasRender
        if (
          c.hasRender &&
          multiplanarShowRender === NVConstants.SHOW_RENDER.AUTO
        ) {
          const base = candidates.find((x) => x.type === c.type && !x.hasRender)
          return !base || c.zoom >= base.zoom - 0.0001
        }
        return true
      })
      .sort((a, b) => {
        if (Math.abs(b.zoom - a.zoom) > 0.0001) return b.zoom - a.zoom
        return (b.hasRender ? 1 : 0) - (a.hasRender ? 1 : 0)
      })[0] || candidates[0]

  const [ax, cor, sag] = screens
  const ren: SliceTile = { axCorSag: NVConstants.SLICE_TYPE.RENDER }

  const z = best.zoom
  const sAxial = { w: wAx * z, h: hAx * z }
  const sCoronal = { w: wCor * z, h: hCor * z }
  const sSagittal = { w: wSag * z, h: hSag * z }
  const renderSize = maxDim * z

  if (best.type === NVConstants.MULTIPLANAR_TYPE.ROW) {
    const tiles = [sAxial, sCoronal, sSagittal]
    const views = [ax, cor, sag]
    if (best.hasRender) {
      tiles.push({ w: renderSize, h: renderSize })
      views.push(ren)
    }
    return packRow(canvasWH, tileMargin, tiles, views)
  }

  if (best.type === NVConstants.MULTIPLANAR_TYPE.COLUMN) {
    const tiles = [sAxial, sCoronal, sSagittal]
    const views = [ax, cor, sag]
    if (best.hasRender) {
      tiles.push({ w: renderSize, h: renderSize })
      views.push(ren)
    }
    return packColumn(canvasWH, tileMargin, tiles, views)
  }

  // GRID
  const gridRenderSize = Math.min(sSagittal.w, sAxial.h)
  const totalW = sAxial.w + sSagittal.w + tileMargin
  const totalH = sAxial.h + sCoronal.h + tileMargin
  const offX = (canvasWH[0] - totalW) / 2
  const offY = (canvasWH[1] - totalH) / 2
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
  ]
  if (best.hasRender) {
    tiles.push({
      ...ren,
      leftTopWidthHeight: [
        offX + sCoronal.w + tileMargin,
        offY + sCoronal.h + tileMargin,
        gridRenderSize,
        gridRenderSize,
      ],
    })
  }
  return tiles
}

// ---------- Custom layout ----------

/**
 * Validate a custom layout for overlapping tiles and out-of-range positions.
 * @returns Object with `valid` flag and optional `error` message.
 */
export function validateCustomLayout(layout: CustomLayoutTile[]): {
  valid: boolean
  error?: string
} {
  for (let i = 0; i < layout.length; i++) {
    const [l, t, w, h] = layout[i].position
    if (w <= 0 || h <= 0) {
      return {
        valid: false,
        error: `Custom layout tile ${i} has non-positive size (${w}×${h}).`,
      }
    }
    if (l < 0 || t < 0 || l + w > 1.0001 || t + h > 1.0001) {
      return {
        valid: false,
        error: `Custom layout tile ${i} exceeds normalized [0,1] bounds.`,
      }
    }
    for (let j = i + 1; j < layout.length; j++) {
      const [l2, t2, w2, h2] = layout[j].position
      if (l < l2 + w2 && l + w > l2 && t < t2 + h2 && t + h > t2) {
        return {
          valid: false,
          error: `Custom layout tile ${i} overlaps with tile ${j}.`,
        }
      }
    }
  }
  return { valid: true }
}

function buildCustomLayout(config: SliceLayoutConfig): SliceTile[] {
  const { canvasWH, extentsMin, extentsMax, customLayout } = config
  if (!customLayout || customLayout.length === 0) return []

  const isRad = config.isRadiologicalConvention ?? false
  const isEqual = config.isMultiplanarEqualSize ?? false

  const range = vec3.create()
  vec3.sub(range, extentsMax, extentsMin)
  const maxDim = Math.max(range[0], range[1], range[2])

  const screens = isEqual
    ? buildEqualScreens(extentsMin, extentsMax, isRad, maxDim)
    : buildScreens(extentsMin, extentsMax, isRad)

  const tiles: SliceTile[] = []
  for (const spec of customLayout) {
    const [left, top, width, height] = spec.position
    // Convert normalized position to pixel coordinates, clamped to canvas
    const px = left * canvasWH[0]
    const py = top * canvasWH[1]
    const pw = Math.min(width * canvasWH[0], canvasWH[0] - px)
    const ph = Math.min(height * canvasWH[1], canvasWH[1] - py)
    if (pw <= 0 || ph <= 0) continue

    if (spec.sliceType === NVConstants.SLICE_TYPE.RENDER) {
      tiles.push({
        leftTopWidthHeight: [px, py, pw, ph],
        axCorSag: NVConstants.SLICE_TYPE.RENDER,
      })
    } else {
      const idx = spec.sliceType // AXIAL=0, CORONAL=1, SAGITTAL=2
      const screen = screens[idx]
      if (!screen?.screen) continue
      // Fit the slice's mm aspect ratio within the available tile area
      const fov = screen.screen.fovMM
      const zoom = Math.min(pw / fov[0], ph / fov[1])
      const fw = fov[0] * zoom
      const fh = fov[1] * zoom
      const rot = rotations(idx, isRad)
      const tile: SliceTile = {
        leftTopWidthHeight: [px + (pw - fw) / 2, py + (ph - fh) / 2, fw, fh],
        axCorSag: idx,
        screen: cloneScreen(screen.screen),
        azimuth: rot.azimuth,
        elevation: rot.elevation,
      }
      if (spec.sliceMM !== undefined) {
        tile.sliceMM = spec.sliceMM
      }
      tiles.push(tile)
    }
  }
  return tiles
}

// ---------- Main entry point ----------

/** Width of the bounding box enclosing all laid-out tiles. */
function sliceBoundingWidth(tiles: SliceTile[]): number {
  let minL = Number.POSITIVE_INFINITY
  let maxR = Number.NEGATIVE_INFINITY
  for (const t of tiles) {
    const r = t.leftTopWidthHeight
    if (!r) continue
    minL = Math.min(minL, r[0])
    maxR = Math.max(maxR, r[0] + r[2])
  }
  if (!Number.isFinite(minL) || !Number.isFinite(maxR)) return 0
  return maxR - minL
}

/**
 * Lay out slices and let the graph reclaim horizontal slack. The graph reserves
 * a base width and the slices fill the rest; for a SINGLE-orientation view the
 * tile is often narrower than that area (a tall axial slice in a wide pane),
 * wasting space. In that case the slack is handed to the graph (which grows) and
 * the slices are re-laid into the reduced area so they sit flush.
 *
 * Restricted to single-orientation views (axial/coronal/sagittal, no
 * mosaic/custom layout) where the tile is one centered rect and re-layout is
 * stable; grids/mosaics can reflow when the width changes, so they keep the base
 * graph width. `config.canvasWH[0]` is the base slice-area width.
 */
export function fitSlicesAndGraph(
  config: SliceLayoutConfig,
  baseGraphWidth: number,
): { screenSlices: SliceTile[]; graphWidth: number } {
  const screenSlices = screenSlicesLayout(config)
  if (baseGraphWidth <= 0) return { screenSlices, graphWidth: 0 }
  // A filled single slice uses the slack itself, so the graph keeps base width.
  const single =
    (config.sliceType === NVConstants.SLICE_TYPE.AXIAL ||
      config.sliceType === NVConstants.SLICE_TYPE.CORONAL ||
      config.sliceType === NVConstants.SLICE_TYPE.SAGITTAL) &&
    !config.sliceMosaicString &&
    !(config.customLayout && config.customLayout.length > 0)
  if (!single) return { screenSlices, graphWidth: baseGraphWidth }
  const baseW = config.canvasWH[0]
  const usedW = sliceBoundingWidth(screenSlices)
  // Require meaningful slack (avoid churn from sub-pixel rounding).
  if (usedW <= 0 || usedW >= baseW - 1) {
    return { screenSlices, graphWidth: baseGraphWidth }
  }
  return {
    screenSlices: screenSlicesLayout({
      ...config,
      canvasWH: [usedW, config.canvasWH[1]],
    }),
    graphWidth: baseGraphWidth + (baseW - usedW),
  }
}

/**
 * Both renderers' slice-layout step. Emits no tiles when the spatial view is
 * hidden (signal-only scene, or `SLICE_TYPE.NONE`), so nothing spatial renders
 * and the graph has the area to itself. The model-to-config mapping lives here
 * and nowhere else: a flag threaded into one backend's copy is a parity break.
 *
 * @param paneWH - the slice area: canvas minus the legend, graph and colorbar
 */
export function fitSlicesFromModel(
  model: NVModel,
  paneWH: [number, number],
  baseGraphWidth: number,
): { screenSlices: SliceTile[]; graphWidth: number } {
  if (model.isSpatialViewHidden()) {
    return { screenSlices: [], graphWidth: baseGraphWidth }
  }
  return fitSlicesAndGraph(
    {
      canvasWH: paneWH,
      sliceType: model.layout.sliceType,
      tileMargin: model.layout.margin,
      extentsMin: model.extentsMin,
      extentsMax: model.extentsMax,
      isRadiologicalConvention: model.layout.isRadiological,
      multiplanarLayout: model.layout.multiplanarType,
      multiplanarShowRender: model.layout.showRender,
      sliceMosaicString: model.layout.mosaicString,
      heroImageFraction: model.layout.heroFraction,
      heroSliceType: model.layout.heroSliceType,
      isMultiplanarEqualSize: model.layout.isEqualSize,
      isCrossLines: model.ui.isCrossLinesVisible,
      isCenterMosaic: model.layout.isMosaicCentered,
      isSingleViewFillCanvas: model.layout.isSingleViewFillCanvas,
      customLayout: model.layout.customLayout,
    },
    baseGraphWidth,
  )
}

export function screenSlicesLayout(config: SliceLayoutConfig): SliceTile[] {
  const { canvasWH, extentsMin, extentsMax } = config
  const sliceType = config.sliceType
  const isRad = config.isRadiologicalConvention ?? false
  const isEqual = config.isMultiplanarEqualSize ?? false
  const mosaic = config.sliceMosaicString ?? ''
  const heroFraction = config.heroImageFraction ?? 0

  // Custom layout overrides everything
  if (config.customLayout && config.customLayout.length > 0) {
    return buildCustomLayout(config)
  }

  // Mosaic overrides everything
  if (mosaic.trim().length > 0) {
    return parseMosaicLayout(config)
  }

  // Render-only
  if (sliceType === NVConstants.SLICE_TYPE.RENDER) {
    return [
      {
        leftTopWidthHeight: [0, 0, canvasWH[0], canvasWH[1]],
        axCorSag: sliceType,
      },
    ]
  }

  const range = vec3.create()
  vec3.sub(range, extentsMax, extentsMin)
  const maxDim = Math.max(range[0], range[1], range[2])

  const screens = isEqual
    ? buildEqualScreens(extentsMin, extentsMax, isRad, maxDim)
    : buildScreens(extentsMin, extentsMax, isRad)

  // Single slice
  if (sliceType !== NVConstants.SLICE_TYPE.MULTIPLANAR) {
    const idx = sliceType // AXIAL=0, CORONAL=1, SAGITTAL=2
    const fov = screens[idx].screen?.fovMM
    if (!fov) {
      throw new Error('Missing fovMM for slice')
    }
    const zoom = Math.min(canvasWH[0] / fov[0], canvasWH[1] / fov[1])
    // Fill needs a usable fit scale: zero or infinite gives NaN mm bounds.
    const fill =
      (config.isSingleViewFillCanvas ?? true) &&
      Number.isFinite(zoom) &&
      zoom > 0
    const w = fill ? canvasWH[0] : fov[0] * zoom
    const h = fill ? canvasWH[1] : fov[1] * zoom
    return [
      {
        ...screens[idx],
        // Spans are stored PRE-zoom: calculateMvpMatrix2D divides by it (#68).
        ...(fill && {
          screen: fillScreen(screens[idx].screen as ScreenInfo, [
            w / zoom,
            h / zoom,
          ]),
        }),
        leftTopWidthHeight: [
          (canvasWH[0] - w) / 2,
          (canvasWH[1] - h) / 2,
          w,
          h,
        ],
      },
    ]
  }

  // Hero image (multiplanar with hero)
  if (heroFraction > 0 && heroFraction < 1) {
    return heroLayout(config)
  }

  // Standard multiplanar
  return layoutMultiplanar(config)
}

// ---------- Picking ----------

export function screenSlicePick(
  screenSlices: SliceTile[],
  model: NVModel,
  canvasX: number,
  canvasY: number,
  hit: ViewHitTest,
): [number, number, number] | null {
  const tile = screenSlices[hit.tileIndex]
  if (!tile || hit.isRender) return null
  const ltwh = tile.leftTopWidthHeight as number[]
  if (model.volumes.length === 0) return null
  if (!model.tex2mm) return null
  const nx = Math.max(0, Math.min(1, (canvasX - ltwh[0]) / ltwh[2]))
  const ny = Math.max(0, Math.min(1, (canvasY - ltwh[1]) / ltwh[3]))
  // Fast path: use cached MVP and plane from last render
  if (tile.mvpMatrix && tile.planeNormal && tile.planePoint) {
    return NVTransforms.intersectPlane(
      nx,
      ny,
      tile.mvpMatrix,
      tile.planeNormal,
      tile.planePoint,
    )
  }
  // Fallback: recompute (first frame before cache is populated)
  const screen = tile.screen as { mnMM: number[]; mxMM: number[] }
  if (!screen) return null
  const pan = slicePanUV(model.scene.pan2Dxyzmm, tile.axCorSag)
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
  )
  const sliceDim = NVConstants.sliceTypeDim(hit.sliceType)
  const sliceFrac =
    tile.sliceMM !== undefined
      ? model.getSliceTexFracAtMM(sliceDim, tile.sliceMM)
      : model.getSliceTexFrac(sliceDim)
  return NVTransforms.intersectSlicePlane(
    nx,
    ny,
    mvpMatrix as mat4,
    model.tex2mm,
    hit.sliceType,
    sliceFrac,
  )
}

// ---------- Visible window ----------

/**
 * A world-mm interval along one world axis.
 *
 * Closed at both ends: `maxMM` is the last millimetre visible, not one past it.
 * Worth stating because the neighbouring box types disagree -- `FocusBox` is
 * inclusive, `MultiLodBounds` is exclusive -- so a caller converting between
 * them cannot tell which this is from the shape alone.
 */
export type AxisWindowMM = { minMM: number; maxMM: number }

/**
 * The visible world-mm window on each world axis, indexed `[X, Y, Z]`.
 *
 * An axis is `null` when no tile shows a range along it -- either nothing is
 * laid out, or every tile that touches the axis has it as its depth axis.
 */
export type VisibleWindowMM = [
  AxisWindowMM | null,
  AxisWindowMM | null,
  AxisWindowMM | null,
]

/**
 * World-mm window a single 2D tile currently shows, per world axis.
 *
 * `screen.mnMM`/`mxMM` are the tile's ortho window before interaction and are
 * stored tile-local (`[u, v, depth]`), so this both applies the 2D pan/zoom the
 * way {@link NVTransforms.calculateMvpMatrix2D} does -- shrink about the window
 * centre by `zoom`, then shift by `-pan` -- and remaps the result back onto
 * world XYZ via {@link IDX_MAP}.
 *
 * Radiological convention is deliberately not a parameter: it negates both the
 * ortho bounds and `panU`, which mirrors what lands on the left of the screen
 * but leaves the world-mm interval identical.
 *
 * Only the two in-plane axes get a window. The depth axis is left `null`
 * because a slice tile shows a plane there, not a range; callers that want the
 * slice position already have it from `tile.sliceMM` or the crosshair.
 *
 * `global3d` tiles return null: their ortho window is in instance space and
 * would need the tile's position/scale/orientation applied before it means
 * anything in world mm. Returning the raw numbers would label instance-space
 * millimetres as world millimetres, which no caller can detect.
 *
 * @param tile - a 2D slice tile (returns null for render, global3d or non-orientation tiles)
 * @param pan2Dxyzmm - the scene's `[panX, panY, panZ, zoom]`
 * @returns per-world-axis windows, or null for a tile with no 2D world-mm ortho window
 */
export function tileVisibleWindowMM(
  tile: SliceTile,
  pan2Dxyzmm: ArrayLike<number> = [0, 0, 0, 1],
): VisibleWindowMM | null {
  const map = IDX_MAP[tile.axCorSag]
  if (!map || !tile.screen || tile.space === 'global3d') return null
  const { mnMM, mxMM } = tile.screen
  const pan = slicePanUV(pan2Dxyzmm, tile.axCorSag)
  // A zero or non-finite zoom would blow the window up to infinity; treat it
  // the same 1:1 way the MVP does.
  const zoom = Number.isFinite(pan[2]) && pan[2] > 0 ? pan[2] : 1
  const out: VisibleWindowMM = [null, null, null]
  for (let i = 0; i < 2; i++) {
    const centre = (mnMM[i] + mxMM[i]) / 2 - pan[i]
    const half = Math.abs(mxMM[i] - mnMM[i]) / (2 * zoom)
    if (!Number.isFinite(centre) || !Number.isFinite(half)) continue
    out[map[i]] = { minMM: centre - half, maxMM: centre + half }
  }
  return out
}

/**
 * Union of every 2D tile's visible window, per world axis.
 *
 * The answer to "which world mm are on screen right now" for a whole layout:
 * a standard multiplanar returns all three axes, a sagittal-only layout returns
 * Y and Z with X `null`. The window is the ortho window, so it can reach past
 * the data -- a tile filling the canvas has margin around the volume, and
 * `isMultiplanarEqualSize` pads the short axes. Intersect with the volume
 * extents yourself if you want the visible part of the data rather than of the
 * world.
 *
 * A union is what a prefetcher wants: the mm a caller must have loaded to cover
 * everything on screen. It is NOT what "keep this point visible in every tile"
 * wants, which needs the intersection. The two coincide in every layout today,
 * because tiles sharing a world axis are laid out from the same extents and get
 * the same window (checked on standard and equal-size multiplanar, and on a
 * custom layout with deliberately mismatched pane aspects). Per-tile fill would
 * break the tie -- one tile widened, its neighbour not -- so a caller with
 * every-tile semantics should reduce over {@link tileVisibleWindowMM} itself
 * rather than assume this stays interchangeable.
 *
 * Render and `global3d` tiles are skipped, for the reasons on
 * {@link tileVisibleWindowMM}.
 *
 * @param tiles - the laid-out screen slices
 * @param pan2Dxyzmm - the scene's `[panX, panY, panZ, zoom]`
 */
export function visibleWindowMM(
  tiles: SliceTile[],
  pan2Dxyzmm: ArrayLike<number> = [0, 0, 0, 1],
): VisibleWindowMM {
  const out: VisibleWindowMM = [null, null, null]
  for (const tile of tiles) {
    const windows = tileVisibleWindowMM(tile, pan2Dxyzmm)
    if (!windows) continue
    for (let axis = 0; axis < 3; axis++) {
      const win = windows[axis]
      if (!win) continue
      const prev = out[axis]
      out[axis] = prev
        ? {
            minMM: Math.min(prev.minMM, win.minMM),
            maxMM: Math.max(prev.maxMM, win.maxMM),
          }
        : win
    }
  }
  return out
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
  perAxisColors?: number[][],
): LineData[] {
  if (
    !tile.crossLines ||
    tile.renderOrientation === undefined ||
    !tile.leftTopWidthHeight
  )
    return []
  const orient = tile.renderOrientation
  const ltwh = tile.leftTopWidthHeight
  const lines: LineData[] = []
  // IDX_MAP[orient] = [uDim, vDim, depthDim]
  const [uDim, vDim, depthDim] = IDX_MAP[orient]
  const depthCenter = (extentsMin[depthDim] + extentsMax[depthDim]) / 2

  // Project a world mm point to canvas pixel coordinates via the tile's MVP
  const project = (x: number, y: number, z: number): [number, number] => {
    const clip = vec4.create()
    vec4.transformMat4(clip, vec4.fromValues(x, y, z, 1), mvpMatrix)
    return [
      ltwh[0] + (clip[0] + 1) * 0.5 * ltwh[2],
      ltwh[1] + (1 - clip[1]) * 0.5 * ltwh[3],
    ]
  }

  // Build a 3D point from swizzled U, V, depth values
  const makePoint = (
    u: number,
    v: number,
    d: number,
  ): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0]
    p[uDim] = u
    p[vDim] = v
    p[depthDim] = d
    return p
  }

  // Each cross-line set maps to a real mm dimension
  const sets = [
    { mmValues: tile.crossLines.axialMM, dim: 2 },
    { mmValues: tile.crossLines.coronalMM, dim: 1 },
    { mmValues: tile.crossLines.sagittalMM, dim: 0 },
  ]

  for (const { mmValues, dim } of sets) {
    if (dim === depthDim || mmValues.length === 0) continue
    for (const mm of mmValues) {
      if (dim === vDim) {
        // Horizontal line: span full U extent at this V position (extends along uDim)
        const [x1, y1] = project(
          ...makePoint(extentsMin[uDim], mm, depthCenter),
        )
        const [x2, y2] = project(
          ...makePoint(extentsMax[uDim], mm, depthCenter),
        )
        const lineColor = getAxisColor(uDim, color, perAxisColors)
        lines.push(lineFn(x1, y1, x2, y2, thickness, lineColor))
      } else if (dim === uDim) {
        // Vertical line: span full V extent at this U position (extends along vDim)
        const [x1, y1] = project(
          ...makePoint(mm, extentsMin[vDim], depthCenter),
        )
        const [x2, y2] = project(
          ...makePoint(mm, extentsMax[vDim], depthCenter),
        )
        const lineColor = getAxisColor(vDim, color, perAxisColors)
        lines.push(lineFn(x1, y1, x2, y2, thickness, lineColor))
      }
    }
  }
  return lines
}

// ---------- Focus box ----------

// 12 edges of an axis-aligned box, as index pairs into the 8 corners below.
const FOCUS_BOX_EDGES: [number, number][] = [
  [0, 1],
  [1, 3],
  [3, 2],
  [2, 0], // min-z face
  [4, 5],
  [5, 7],
  [7, 6],
  [6, 4], // max-z face
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7], // verticals
]

/**
 * Build the 12 screen-space edges of a world-mm axis-aligned `box` for a 3D
 * render tile, projecting its 8 corners through the tile's (perspective) MVP.
 * Edges with a corner at/behind the camera (clip w <= 0) are dropped. `ltwh` is
 * the tile's pixel rect; `lineFn` is the backend's `buildLine`.
 */
export function buildFocusBoxLines(
  box: FocusBox,
  mvpMatrix: mat4,
  ltwh: number[],
  lineFn: BuildLineFn,
): LineData[] {
  const { min, max } = box
  const corners: [number, number, number][] = [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [min[0], max[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [min[0], max[1], max[2]],
    [max[0], max[1], max[2]],
  ]
  // Perspective-correct projection (unlike the orthographic slice path): divide
  // by clip w. Null for corners at/behind the camera.
  const screen = corners.map((c): [number, number] | null => {
    const clip = vec4.create()
    vec4.transformMat4(clip, vec4.fromValues(c[0], c[1], c[2], 1), mvpMatrix)
    const w = clip[3]
    if (w <= 1e-6) return null
    return [
      ltwh[0] + (clip[0] / w + 1) * 0.5 * ltwh[2],
      ltwh[1] + (1 - clip[1] / w) * 0.5 * ltwh[3],
    ]
  })
  const thickness = Math.max(1, box.thickness)
  const lines: LineData[] = []
  for (const [a, b] of FOCUS_BOX_EDGES) {
    const p0 = screen[a]
    const p1 = screen[b]
    if (!p0 || !p1) continue
    // The line renderer draws full-canvas (not scissored to the tile), so a box
    // whose projected corners fall outside the render tile would bleed its edges
    // across the neighbouring slice tiles (visible once the render is zoomed so
    // the box extends past the tile). Clip each edge to the tile rect first.
    const seg = clipSegmentToRect(
      p0[0],
      p0[1],
      p1[0],
      p1[1],
      ltwh[0],
      ltwh[1],
      ltwh[0] + ltwh[2],
      ltwh[1] + ltwh[3],
    )
    if (seg)
      lines.push(lineFn(seg[0], seg[1], seg[2], seg[3], thickness, box.color))
  }
  return lines
}

/**
 * Liang-Barsky clip of segment (x0,y0)-(x1,y1) to the axis-aligned rect
 * [xmin,ymin]-[xmax,ymax]. Returns the clipped endpoints, or null if the segment
 * is entirely outside the rect.
 */
function clipSegmentToRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
): [number, number, number, number] | null {
  const dx = x1 - x0
  const dy = y1 - y0
  let t0 = 0
  let t1 = 1
  const p = [-dx, dx, -dy, dy]
  const q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0]
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null // parallel and outside this edge
    } else {
      const r = q[i] / p[i]
      if (p[i] < 0) {
        if (r > t1) return null
        if (r > t0) t0 = r
      } else {
        if (r < t0) return null
        if (r < t1) t1 = r
      }
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy]
}
