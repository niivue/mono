// Block (volume-chunk explode) settings. NiiVue can tile a volume into a grid of
// bricks and separate them at draw time ("explode"), a render-time offset that
// leaves the underlying voxel sampling untouched. NeuroVue exposes this as two
// controls: a block grid (how many bricks per axis) and an explode amount (how
// far apart they spread in the 3D render). The settings live here — a plain
// domain type — so both the viewer (`NiivueStage`) and the bundle/session
// persistence layer can share them without importing a component.

export interface BlockSettings {
  /**
   * Bricks per axis. `1` means untiled — a single texture, no blocks. `2`–`6`
   * tiles every loaded volume into `grid × grid × grid` bricks so they can be
   * exploded. Applied per axis and clamped to the volume's voxel dims, so a thin
   * volume never asks for more bricks than it has voxels on an axis.
   */
  grid: number
  /**
   * Draw-time spacing between bricks in the 3D render. `1` is compact (bricks
   * touch, visually identical to untiled); values above 1 spread them apart —
   * `2` leaves a full-cell gap on each axis. Only meaningful when `grid > 1`.
   */
  explode: number
}

/** Untiled by default; the explode amount is pre-seeded for the first tiling. */
export const DEFAULT_BLOCK_SETTINGS: BlockSettings = { grid: 1, explode: 1.4 }

/** Selectable block grids. `1` is the "Off" (untiled) choice. */
export const BLOCK_GRID_OPTIONS = [1, 2, 3, 4, 5, 6] as const

/** Explode slider bounds (multiplier on the per-brick cell spacing). */
export const MIN_EXPLODE = 1
export const MAX_EXPLODE = 2

/** Whether these settings actually tile the volume into separable blocks. */
export function blocksAreTiled(blocks: BlockSettings): boolean {
  return blocks.grid > 1
}

/** Human-readable grid label for the UI ("Off", "3³", …). */
export function blockGridLabel(grid: number): string {
  return grid <= 1 ? 'Off' : `${grid}³`
}
