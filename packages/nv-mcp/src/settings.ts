/** NiiVue's `COLORMAP_TYPE`: how a volume's window is drawn below its minimum. */
export const COLORMAP_TYPES = {
  min_to_max: 0,
  zero_to_max_transparent_below_min: 1,
  zero_to_max_translucent_below_min: 2,
} as const
