/**
 * The view layout by name.
 *
 * NiiVue keeps what the canvas shows as numbers: which slice type, how the
 * multiplanar tiles are arranged, whether the render tile joins them. An
 * agent names them instead, and these tables go between the two, so the
 * server's schemas and the page's handler agree on the words. The numbers
 * are NiiVue 1.0's `SLICE_TYPE`, `MULTIPLANAR_TYPE` and `SHOW_RENDER`.
 */

/** What the canvas shows, by NiiVue's `sliceType`. `none` is left out: it shows nothing. */
export const SLICE_TYPES = {
  axial: 0,
  coronal: 1,
  sagittal: 2,
  multiplanar: 3,
  render: 4,
} as const

/** How the multiplanar tiles are arranged, by NiiVue's `multiplanarType`. */
export const LAYOUTS = {
  auto: 0,
  column: 1,
  grid: 2,
  row: 3,
} as const

/** Whether the multiplanar view includes the render tile, by NiiVue's `showRender`. */
export const SHOW_RENDER = {
  never: 0,
  always: 1,
  auto: 2,
} as const

export type SliceName = keyof typeof SLICE_TYPES
export type LayoutName = keyof typeof LAYOUTS
export type ShowRenderName = keyof typeof SHOW_RENDER

const names = <T extends Record<string, number>>(table: T) =>
  Object.keys(table) as [keyof T & string, ...(keyof T & string)[]]

export const SLICE_NAMES = names(SLICE_TYPES)
export const LAYOUT_NAMES = names(LAYOUTS)
export const SHOW_RENDER_NAMES = names(SHOW_RENDER)

/** The name for one of NiiVue's numbers, or `other` for one the table does not have. */
export function nameFor<T extends Record<string, number>>(
  table: T,
  value: number | undefined,
): (keyof T & string) | 'other' {
  for (const name of names(table)) if (table[name] === value) return name
  return 'other'
}

/** The state of the view layout, as `set_view` and `where_am_i` report it. */
export interface ViewState {
  slice: SliceName | 'other'
  layout: LayoutName | 'other'
  /** The mosaic string, when one is drawn. */
  mosaic?: string
  showRender: ShowRenderName | 'other'
  radiological: boolean
  colorbar: boolean
}
