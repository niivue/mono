/**
 * NiiVue's settings by name.
 *
 * NiiVue keeps about a hundred plain settings as properties of the
 * instance: switches, numbers, colours, and a few it keeps as numbers
 * that stand for names. `set_options` sets any of them and `get_options`
 * reads them, so this table says what each one is, so that the server's
 * schema and the page's handler agree on the kind and the words, and so
 * an agent reads a name (`pan`) where NiiVue keeps a number (3). The
 * settings with tools of their own (the crosshair, the camera, the clip
 * plane, the view layout) are left out, as is `isDragging`, which is
 * NiiVue's own note of a pointer being down.
 */

import { SLICE_TYPES } from './views'

export type SettingKind =
  | 'boolean'
  | 'number'
  | 'integer'
  | 'string'
  /** Three or four numbers 0 to 1, red, green, blue and alpha; alpha 1 when left out. */
  | 'color'
  /** A list of colours, one per axis. */
  | 'colors'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  /** Three numbers in millimetres, or null. */
  | 'mm-or-null'
  /** One of NiiVue's numbers, named. */
  | 'enum'
  /** One of a few strings NiiVue takes as they are. */
  | 'choice'

export interface Setting {
  name: string
  kind: SettingKind
  /** For an enum, NiiVue's number for each name; for a choice, the strings. */
  values?: Readonly<Record<string, number>> | readonly string[]
  /** Bounds a number is clamped to, when NiiVue has them. */
  min?: number
  max?: number
  description: string
}

/** NiiVue's `DRAG_MODE`: what a pointer drag does. */
export const DRAG_MODES = {
  none: 0,
  contrast: 1,
  measurement: 2,
  pan: 3,
  slicer3D: 4,
  callbackOnly: 5,
  roiSelection: 6,
  angle: 7,
  crosshair: 8,
  windowing: 9,
  crosshairPan: 10,
} as const

/** NiiVue's `PEN_SHAPE`. */
export const PEN_SHAPES = { rectangle: 0, circle: 1 } as const

/** NiiVue's `VOLUME_RENDER_MODE`. */
export const RENDER_MODES = { composite: 0, maximum: 1, slices: 2 } as const

/** NiiVue's `LAYER_GRADIENT_MODE`. */
export const GRADIENT_MODES = { central: 0, blob: 1, sobel8: 2 } as const

/** NiiVue's `OVERLAY_ALPHA_BLEND`: how overlapping overlays combine their opacities. */
export const OVERLAY_ALPHA_BLENDS = { max: 0, additive: 1, over: 2 } as const

/** NiiVue's `OVERLAY_COLOR_BLEND`: how overlapping overlays combine their colours. */
export const OVERLAY_COLOR_BLENDS = { additive: 0, mean: 1 } as const

/** NiiVue's `COLORMAP_TYPE`: how a volume's window is drawn below its minimum. */
export const COLORMAP_TYPES = {
  min_to_max: 0,
  zero_to_max_transparent_below_min: 1,
  zero_to_max_translucent_below_min: 2,
} as const

/** NiiVue's `AnnotationTool` names. */
export const ANNOTATION_TOOLS = [
  'freehand',
  'ellipse',
  'rectangle',
  'line',
  'arrow',
  'measureEllipse',
  'measureRect',
  'measureLine',
  'circle',
  'measureCircle',
  'spline',
  'measureSpline',
  'livewire',
  'measureLivewire',
  'bidirectional',
  'measureBidirectional',
] as const

/** NiiVue's `SlideDrawTool` names. */
export const SLIDE_TOOLS = [
  'pen',
  'eraser',
  'bucket',
  'filled',
  'wand',
  'vector',
] as const

const setting = (
  name: string,
  kind: SettingKind,
  description: string,
  extra: Partial<Setting> = {},
): Setting => ({ name, kind, description, ...extra })

const bool = (name: string, description: string) =>
  setting(name, 'boolean', description)
const num = (name: string, description: string, extra?: Partial<Setting>) =>
  setting(name, 'number', description, extra)
const int = (name: string, description: string, extra?: Partial<Setting>) =>
  setting(name, 'integer', description, extra)
const str = (name: string, description: string) =>
  setting(name, 'string', description)
const color = (name: string, description: string) =>
  setting(name, 'color', description)

/** Every setting `set_options` takes, in the order `get_options` reports them. */
export const SETTINGS: readonly Setting[] = [
  // Colours and text
  color('backgroundColor', 'The colour behind everything.'),
  color('crosshairColor', 'The colour of the crosshair.'),
  setting(
    'crosshairColorPerAxis',
    'colors',
    'A colour for each crosshair axis, x, y and z, over crosshairColor.',
  ),
  num(
    'crosshairWidth',
    'The width of the crosshair lines, in pixels; 0 hides it.',
    {
      min: 0,
    },
  ),
  num('crosshairGap', 'The gap at the centre of the crosshair, in pixels.', {
    min: 0,
  }),
  color('fontColor', 'The colour of the text NiiVue draws.'),
  num('fontMinSize', 'The smallest size text is drawn at, in pixels.', {
    min: 0,
  }),
  num('fontScale', 'A multiplier on the size of all text.', { min: 0 }),
  color('clipPlaneColor', 'The colour the clip plane is drawn in.'),
  color('measureLineColor', 'The colour of measurement lines.'),
  color('measureTextColor', 'The colour of measurement text.'),
  color('selectionBoxColor', 'The colour of the drag-selection box.'),
  str('placeholderText', 'The text shown when nothing is loaded.'),
  str(
    'thumbnailUrl',
    'A picture to show until the first draw; empty for none.',
  ),
  num(
    'devicePixelRatio',
    'The device pixels per CSS pixel the canvas is sized by.',
    {
      min: 0,
    },
  ),
  num(
    'forceDevicePixelRatio',
    "A device pixel ratio to use instead of the window's; 0 for the window's, -1 for none.",
  ),
  num('tileMargin', 'The gap between multiplanar tiles, in pixels.', {
    min: 0,
  }),
  num('rulerWidth', 'The width of the ruler line, in pixels.', { min: 0 }),

  // Switches for what is drawn
  bool('is3DCrosshairVisible', 'Whether the crosshair is drawn in the render.'),
  bool(
    'isCrossLinesVisible',
    'Whether the slice-position lines cross each 2D tile.',
  ),
  bool(
    'isOrientationTextVisible',
    'Whether L, R, A, P, S and I are drawn on the tiles.',
  ),
  bool(
    'isOrientCubeVisible',
    'Whether the orientation cube is drawn in the render.',
  ),
  bool('isRulerVisible', 'Whether a ruler is drawn.'),
  bool('isMeasureUnitsVisible', 'Whether measurements show their units.'),
  bool('isMeasurementDrawn', 'Whether measurements are drawn at all.'),
  bool('isLegendVisible', 'Whether a legend of label names is drawn.'),
  bool('isGraphVisible', 'Whether the signal graph is drawn.'),
  bool(
    'isThumbnailVisible',
    'Whether the thumbnail is shown before the first draw.',
  ),
  bool(
    'isClipPlaneCutaway',
    'Whether the clip plane cuts the volume away rather than clipping the render.',
  ),
  bool('clipPlaneOverlay', 'Whether the clip plane is drawn over the render.'),
  bool('isEqualSize', 'Whether multiplanar tiles are given equal size.'),
  bool('isMosaicCentered', 'Whether a mosaic is centred on the canvas.'),
  bool(
    'isSingleViewFillCanvas',
    "Whether a single 2D view fills the canvas instead of keeping the slice's shape.",
  ),
  bool('isPanFollowingCrosshair', 'Whether the 2D pan follows the crosshair.'),
  bool(
    'isPositionInMM',
    'Whether the position readout is in millimetres rather than voxels.',
  ),
  bool('isSnapToVoxelCenters', 'Whether the crosshair snaps to voxel centres.'),
  bool('isYoked3DTo2DZoom', 'Whether zooming a 2D tile zooms the render too.'),
  bool('isDragDropEnabled', 'Whether files dropped on the canvas are loaded.'),
  bool('isViewModeHotKeyEnabled', 'Whether the V key cycles the view mode.'),
  num(
    'meshXRay',
    'How see-through meshes are drawn in the render, 0 (solid) to 1.',
    {
      min: 0,
      max: 1,
    },
  ),
  num(
    'meshThicknessOn2D',
    'How thick a mesh slab is drawn on a 2D slice, in millimetres.',
    {
      min: 0,
    },
  ),
  num(
    'heroFraction',
    'The share of the canvas the hero tile takes in a hero layout, 0 to 1.',
    {
      min: 0,
      max: 1,
    },
  ),
  setting(
    'heroSliceType',
    'enum',
    'Which view is the hero tile of a hero layout.',
    {
      values: SLICE_TYPES,
    },
  ),
  num('gamma', 'The gamma applied to volume colours; 1 is none.', { min: 0 }),
  num('scaleMultiplier', 'The 2D zoom; 1 fits the slice to its tile.', {
    min: 0,
  }),
  setting(
    'wheelZoomAnchor',
    'choice',
    'What the wheel zooms about: the crosshair, or the pointer.',
    { values: ['crosshair', 'pointer'] },
  ),
  setting(
    'primaryDragMode',
    'enum',
    'What a primary-button drag does: pan, contrast (window), measurement, angle, crosshair, and so on.',
    { values: DRAG_MODES },
  ),
  setting(
    'secondaryDragMode',
    'enum',
    'What a secondary-button drag does; the same choices as primaryDragMode.',
    { values: DRAG_MODES },
  ),

  // Graph
  bool(
    'graphAutoResetView',
    'Whether the graph view resets when its data changes.',
  ),
  bool(
    'graphIsRangeCalMinMax',
    "Whether the graph's y range is the volume's display window.",
  ),
  num('graphLineAlpha', 'The opacity of graph lines, 0 to 1.', {
    min: 0,
    max: 1,
  }),
  num('graphLineWidth', 'The width of graph lines, in pixels.', { min: 0 }),
  bool('graphNormalizeValues', 'Whether graph values are normalised.'),
  bool(
    'graphShowVolumeTimecourse',
    'Whether the graph shows the 4D timecourse at the crosshair.',
  ),

  // Drawing
  bool('drawIsEnabled', 'Whether drawing on the slices is on.'),
  str('drawColormap', 'The colormap the drawing is shown with.'),
  num('drawOpacity', 'The opacity of the drawing, 0 to 1.', { min: 0, max: 1 }),
  num(
    'drawRimOpacity',
    'The opacity of the rim around drawn regions, 0 to 1; negative for none.',
    {
      max: 1,
    },
  ),
  int('drawPenValue', 'The label the pen draws; 0 erases.', { min: 0 }),
  int('drawPenSize', 'The width of the pen, in voxels.', { min: 1 }),
  setting('drawPenShape', 'enum', 'The shape of the pen.', {
    values: PEN_SHAPES,
  }),
  bool(
    'drawIsFillOverwriting',
    'Whether a fill replaces other labels it meets.',
  ),
  bool(
    'drawIsClickToSegment',
    'Whether a click grows a region from the voxel clicked.',
  ),
  bool(
    'drawClickToSegmentIs2D',
    'Whether click-to-segment grows in the slice only.',
  ),
  num(
    'drawClickToSegmentTolerance',
    'How far in intensity click-to-segment grows.',
    {
      min: 0,
    },
  ),

  // Annotations
  bool('annotationIsEnabled', 'Whether the annotation tools are on.'),
  setting('annotationTool', 'choice', 'The annotation tool in hand.', {
    values: ANNOTATION_TOOLS,
  }),
  str('annotationActiveGroup', 'The group new annotations go in.'),
  int('annotationActiveLabel', 'The label new annotations carry.', { min: 0 }),
  num('annotationBrushRadius', 'The radius of the freehand brush.', { min: 0 }),
  bool('annotationIsErasing', 'Whether the annotation brush erases.'),
  bool(
    'annotationIsVisibleIn3D',
    'Whether annotations are drawn in the render.',
  ),
  bool(
    'annotationMergesOverlaps',
    'Whether a new annotation is merged with one it overlaps.',
  ),
  bool('isAnnotationDrawn', 'Whether annotations are drawn at all.'),

  // Slide (whole-slide) tools
  setting('slideTool', 'choice', 'The slide drawing tool in hand.', {
    values: SLIDE_TOOLS,
  }),
  num('slideWandTolerance', 'How far in intensity the slide wand reaches.', {
    min: 0,
  }),

  // Volume rendering
  setting(
    'volumeRenderMode',
    'enum',
    'How the render composes the volume: front to back, maximum intensity, or slices.',
    {
      values: RENDER_MODES,
    },
  ),
  num(
    'volumeSampleRate',
    'How many samples per voxel the ray-march takes; more is finer and slower.',
    {
      min: 0,
    },
  ),
  num('volumeIllumination', 'How strongly the render is lit, 0 to 1.', {
    min: 0,
    max: 1,
  }),
  num(
    'volumeSilhouette',
    'How strongly edges are darkened in the render, 0 to 1.',
    {
      min: 0,
      max: 1,
    },
  ),
  num(
    'volumeGradientOpacity',
    "How much a voxel's gradient adds to its opacity in the render.",
    {
      min: 0,
    },
  ),
  num(
    'volumeOutlineWidth',
    'The width of the outline drawn around the volume in the render.',
    {
      min: 0,
    },
  ),
  num(
    'volumeTransmittanceCutoff',
    'How opaque a ray gets before it stops, 0 to 1.',
    {
      min: 0,
      max: 1,
    },
  ),
  str('volumeMatcap', 'The matcap used for shading, by name or address.'),
  setting(
    'volumeLayerGradientMode',
    'enum',
    'How overlay gradients are computed.',
    {
      values: GRADIENT_MODES,
    },
  ),
  setting(
    'volumeOverlayAlphaBlend',
    'enum',
    'How overlapping overlays combine their opacities: max (no more opaque than either), additive (fractions that sum to 1, as tissue maps do), or over (stacked like transparencies).',
    {
      values: OVERLAY_ALPHA_BLENDS,
    },
  ),
  setting(
    'volumeOverlayColorBlend',
    'enum',
    'How overlapping overlays combine their colours: additive (red and green make yellow, may clip) or mean (their average, never clips).',
    {
      values: OVERLAY_COLOR_BLENDS,
    },
  ),
  num(
    'volumeLodBrightnessCompensation',
    'How much coarse levels of a chunked volume are brightened.',
  ),
  num(
    'volumeLodOpacityCompensation',
    'How much coarse levels of a chunked volume are made more opaque.',
  ),
  setting(
    'volumePaqdUniforms',
    'vec4',
    'The four PAQD uniforms of the ray-march.',
  ),
  num(
    'volumeAlphaShader',
    "The alpha shader's strength in the render; 0 is off.",
    {
      min: 0,
    },
  ),
  bool(
    'volumeIsAlphaClipDark',
    'Whether dark voxels are clipped from the render.',
  ),
  bool(
    'volumeIsBackgroundMasking',
    'Whether overlays are hidden where the base is zero.',
  ),
  bool(
    'volumeIsColormapAlphaOn2D',
    "Whether the colormap's alpha applies on 2D slices.",
  ),
  bool(
    'volumeIsCubicInterpolation',
    'Whether the render samples with a cubic filter.',
  ),
  bool(
    'volumeIsNearestInterpolation',
    'Whether slices sample nearest-neighbour rather than linear.',
  ),
  bool('volumeIsV1SliceShader', 'Whether the V1 slice shader is used.'),
]

const BY_NAME = new Map(SETTINGS.map((s) => [s.name, s]))

/** The setting called `name`, or undefined. */
export function findSetting(name: string): Setting | undefined {
  return BY_NAME.get(name)
}

const numbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((v) => Number.isFinite(Number(v)))

const fail = (setting: Setting, want: string) =>
  new Error(`${setting.name} must be ${want}.`)

const enumNames = (setting: Setting): string[] =>
  Array.isArray(setting.values)
    ? [...setting.values]
    : Object.keys(setting.values ?? {})

/**
 * Turns a value an agent gives into the one NiiVue takes, or throws in
 * words: a name into NiiVue's number, a colour into four numbers, a
 * number into its bounds.
 */
export function coerceSetting(setting: Setting, value: unknown): unknown {
  switch (setting.kind) {
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 'true' || value === 'false') return value === 'true'
      throw fail(setting, 'true or false')
    case 'number':
    case 'integer': {
      const n = Number(value)
      if (value === '' || value === null || !Number.isFinite(n))
        throw fail(setting, 'a number')
      if (setting.kind === 'integer' && !Number.isInteger(n))
        throw fail(setting, 'a whole number')
      if (setting.min !== undefined && n < setting.min)
        throw fail(setting, `at least ${setting.min}`)
      if (setting.max !== undefined && n > setting.max)
        throw fail(setting, `at most ${setting.max}`)
      return n
    }
    case 'string':
      if (typeof value !== 'string') throw fail(setting, 'text')
      return value
    case 'color':
      return coerceColor(setting, value)
    case 'colors':
      if (!Array.isArray(value)) throw fail(setting, 'a list of colours')
      return value.map((v) => coerceColor(setting, v))
    case 'vec2':
    case 'vec3':
    case 'vec4': {
      const length = Number(setting.kind.slice(3))
      if (!numbers(value) || value.length !== length)
        throw fail(setting, `${length} numbers`)
      return value.map(Number)
    }
    case 'mm-or-null':
      if (value === null) return null
      if (!numbers(value) || value.length !== 3)
        throw fail(setting, 'three numbers in millimetres, or null')
      return value.map(Number)
    case 'enum': {
      const table = setting.values as Readonly<Record<string, number>>
      const name = String(value)
      if (Object.hasOwn(table, name)) return table[name]
      // NiiVue's own number is taken too, when it is one of the table's.
      if (Object.values(table).includes(Number(value))) return Number(value)
      throw fail(setting, `one of ${enumNames(setting).join(', ')}`)
    }
    case 'choice': {
      const choices = setting.values as readonly string[]
      if (typeof value === 'string' && choices.includes(value)) return value
      throw fail(setting, `one of ${choices.join(', ')}`)
    }
  }
}

function coerceColor(setting: Setting, value: unknown): number[] {
  if (
    !numbers(value) ||
    value.length < 3 ||
    value.length > 4 ||
    value.some((v) => Number(v) < 0 || Number(v) > 1)
  ) {
    throw fail(
      setting,
      'a colour: red, green, blue and alpha as numbers 0 to 1, alpha 1 when left out',
    )
  }
  const rgba = value.map(Number)
  return rgba.length === 3 ? [...rgba, 1] : rgba
}

/** A value as NiiVue keeps it, turned into what an agent reads: a name for an enum, a plain array for a typed one. */
export function readSetting(setting: Setting, value: unknown): unknown {
  if (setting.kind === 'enum') {
    const table = setting.values as Readonly<Record<string, number>>
    for (const [name, n] of Object.entries(table)) if (n === value) return name
    return value
  }
  if (ArrayBuffer.isView(value)) return plainArray(value)
  if (Array.isArray(value))
    return value.map((v) => (ArrayBuffer.isView(v) ? plainArray(v) : v))
  return value
}

/** A typed array as a plain one, so it serializes as numbers rather than an object. */
function plainArray(view: ArrayBufferView): number[] {
  return Array.from(view as unknown as ArrayLike<number>)
}

/** The names an enum or choice setting takes. */
export function settingChoices(setting: Setting): string[] {
  return enumNames(setting)
}
