import type { Vec3f, Vec3i } from './chunking'

/**
 * A budget plan is the POLICY that shapes a streamed volume's octree: where the
 * finest data goes, how fast detail falls off, and what the plan is allowed to
 * cost. It is an INPUT. Do not confuse it with a `ChunkPlan`, the brick list
 * `chunkVolumeMultiLOD` produces from it, which is the OUTPUT.
 *
 * Presets live in {@link BUDGET_PLANS}; {@link resolveBudgetPlan} folds a
 * preset, an explicit plan, and the individual per-knob options into the one
 * {@link ResolvedOptions} the manager runs on.
 */
export interface BudgetPlan {
  /**
   * Which region gets the finest data. `'crosshair'` follows the crosshair
   * (the manager subscribes `locationChange`); `'none'` pins the volume centre
   * and does NOT subscribe; a `[x,y,z]` fraction pins an arbitrary point.
   */
  focus: 'crosshair' | 'none' | Vec3f
  /**
   * Finest-LOD radius in common-grid voxels. `'auto'` derives it from the view
   * (tight in the 3D render view; per-axis half-extents over zoom in 2D slice
   * views, so anisotropic volumes are covered without over- or under-shooting);
   * `'volume'` covers every brick, so the plan is uniform; a number pins an
   * isotropic ball; a `[rx, ry, rz]` pins an ellipsoid.
   */
  radius: 'auto' | 'volume' | number | Vec3f
  /** LOD falloff factor (1 = 2:1-balanced octree; smaller coarsens faster). */
  detail: number
  /**
   * VRAM ceiling for the planned brick set. Every preset shares
   * {@link DEFAULT_BUDGET_BYTES}: how much VRAM a machine can spare is a
   * property of the DEVICE, not of the use case, so an app pins it once (as an
   * individual option, which wins over the plan) and still switches plans
   * freely.
   */
  budgetBytes: number
  /** Brick-count ceiling (must stay under the renderer's per-tile cap). */
  maxBricks: number
  /**
   * Frame-time target in ms. RECORDED but not yet acted on: the closed-loop
   * controller that adapts the plan to hold a frame time is the next stage (see
   * `docs/budget-plans.md`). Today `'interactive'` gets its headroom from a
   * lower {@link maxBricks} alone, which is the direct proxy for draw cost --
   * each brick is one ray-marched cube draw.
   */
  targetFrameMs?: number
  /** Re-plan debounce, ms. */
  debounceMs: number
}

/** Default GPU byte budget for a planned brick set. */
export const DEFAULT_BUDGET_BYTES = 1_500_000_000

/** A key of {@link BUDGET_PLANS}. */
export type BudgetPlanName = 'focus' | 'uniform' | 'interactive'

/**
 * Named budget plans. `'focus'` is the default and reproduces the behavior that
 * predates this API, so `resolveBudgetPlan({})` is a no-op change.
 *
 * | name | focus | radius | maxBricks | for |
 * |------|-------|--------|-----------|-----|
 * | `focus` | crosshair | auto | 240 | reading around the crosshair |
 * | `uniform` | none | volume | 240 | one static picture of the whole volume |
 * | `interactive` | crosshair | auto | 128 | smooth rotate/zoom |
 *
 * The presets differ ONLY in where the detail goes and how many bricks it may
 * cost; they all carry {@link DEFAULT_BUDGET_BYTES} (see
 * {@link BudgetPlan.budgetBytes} for why the VRAM ceiling is the app's to pin).
 *
 * The octree coarsens a whole shell at a time, so brick counts come in steps
 * (a 4x4x4 core is 64 bricks, each further shell adds ~56). `interactive`'s 128
 * therefore buys exactly one shell less than `focus` -- a real cut in draw
 * count, not a fractional one. Where the BYTE budget binds first, both presets
 * plan the same brick set; that is correct, since the draw count was already at
 * its floor.
 */
export const BUDGET_PLANS: Readonly<Record<BudgetPlanName, BudgetPlan>> = {
  focus: {
    focus: 'crosshair',
    radius: 'auto',
    detail: 1,
    budgetBytes: DEFAULT_BUDGET_BYTES,
    maxBricks: 240,
    debounceMs: 150,
  },
  uniform: {
    focus: 'none',
    radius: 'volume',
    detail: 1,
    budgetBytes: DEFAULT_BUDGET_BYTES,
    maxBricks: 240,
    debounceMs: 150,
  },
  interactive: {
    focus: 'crosshair',
    radius: 'auto',
    detail: 1,
    budgetBytes: DEFAULT_BUDGET_BYTES,
    maxBricks: 128,
    targetFrameMs: 16.7,
    debounceMs: 150,
  },
}

/** A named preset, or a partial plan layered over the `'focus'` preset. */
export type BudgetPlanSpec = BudgetPlanName | Partial<BudgetPlan>

/**
 * The plan-shaping half of {@link ChunkedVolumeOptions}. Split out so
 * `resolveBudgetPlan` needs no import from the manager (and so the precedence
 * rule has one authoritative list of knobs).
 */
export interface BudgetPlanOptions {
  /**
   * Budget plan: a {@link BUDGET_PLANS} name, or a plan object. Every knob below
   * still wins over it, so an existing call that sets them keeps its behavior.
   */
  budgetPlan?: BudgetPlanSpec
  /**
   * Focus that drives the octree. `'crosshair'` (default) makes the finest
   * bricks follow the crosshair (auto-subscribes `locationChange`); `'none'`
   * pins the volume centre and does not subscribe; a `[x,y,z]` fraction pins an
   * arbitrary static focus.
   */
  focus?: 'crosshair' | 'none' | Vec3f
  /**
   * Finest-LOD radius in common-grid voxels. `'auto'` (default) derives it from
   * the view: tight in the 3D render view; PER-AXIS half-extents over zoom in
   * 2D slice views (shrinking with 2D zoom), so a long thin volume gets an
   * ellipsoid that hugs it instead of a diagonal ball. `'volume'` covers every
   * brick. A number pins an isotropic ball; a `[rx, ry, rz]` an ellipsoid.
   */
  radius?: 'auto' | 'volume' | number | Vec3f
  /** GPU byte budget for the planned brick set (default 1.5 GB). */
  budgetBytes?: number
  /** Max bricks in the plan (default 240; must stay < the renderer's per-tile cap). */
  maxBricks?: number
  /** Brick texture edge in level voxels (default 128). */
  cellEdge?: number
  /**
   * EXACT uniform lattice: tile the volume into `gridDims[a]` bricks per axis,
   * all drawn from `minLevel`. Pins the brick COUNT rather than letting it fall
   * out of `cellEdge` and the pyramid, which is what a lattice the user picks
   * bricks out of needs. Bypasses the octree, so `focus`, `radius`, `detail`,
   * `budgetBytes` and `maxBricks` have no effect while it is set; an axis grows
   * when its brick would not fit `deviceLimit`, so read the built plan's own
   * `gridDims` back for what was actually planned.
   */
  gridDims?: Vec3i
  /**
   * Per-axis halo in level voxels (default [1,1,1], which is what hardware
   * trilinear sampling needs). Raised to at least `CUBIC_MIN_HALO` on every axis
   * while the host has `volumeIsCubicInterpolation` on, because the cubic kernel
   * reaches two voxels past a brick face.
   */
  halo?: Vec3i
  /** LOD falloff factor (default 1 = 2:1-balanced octree). */
  detail?: number
  /** Finest level index (max-detail cap; 0 = finest, default 0). */
  minLevel?: number
  /**
   * Max brick texture edge the renderer will upload. Defaults to the host's
   * configured `maxTextureDimension3D` option (256 when the host does not set
   * one), so planned bricks never exceed the renderer's tile limit.
   */
  deviceLimit?: number
  /** Frame-time target in ms (see {@link BudgetPlan.targetFrameMs}). */
  targetFrameMs?: number
  /** Center the 3D render on the crosshair: 'pivot' (orbit about it) or 'none' (default). */
  renderCentering?: 'pivot' | 'none'
  /** Debounce for focus-follow rebuilds, ms (default 150). */
  debounceMs?: number
  /**
   * Back the streamed bricks with a whole-volume coarse "floor", built from the
   * coarsest pyramid level and installed via `NiiVue.setBaseCoarseFloor`
   * (default true). A brick with no resident texture draws nothing, so without a
   * floor the scene background shows through — briefly for EVERY region after a
   * refocus swaps the plan, which is what reads as a flash while zooming. The
   * floor also gives the streaming cross-fade something to dissolve in over.
   * Skipped (with a warning) when the coarsest level is too large to upload as
   * one texture, or carries a datatype with no per-voxel intensity.
   */
  coarseFloor?: boolean
}

/** Every option resolved to a concrete value; what the manager actually runs on. */
export interface ResolvedOptions {
  focus: 'crosshair' | 'none' | Vec3f
  radius: 'auto' | 'volume' | number | Vec3f
  budgetBytes: number
  maxBricks: number
  cellEdge: number
  gridDims?: Vec3i
  halo: Vec3i
  detail: number
  minLevel: number
  deviceLimit: number
  targetFrameMs?: number
  renderCentering: 'pivot' | 'none'
  debounceMs: number
  coarseFloor: boolean
}

/** The subset of {@link ResolvedOptions} that shapes the octree itself. */
export type PlanShapeOptions = Pick<
  ResolvedOptions,
  | 'budgetBytes'
  | 'maxBricks'
  | 'cellEdge'
  | 'gridDims'
  | 'halo'
  | 'detail'
  | 'minLevel'
  | 'deviceLimit'
>

/** Host/source facts a plan cannot know on its own. */
export interface BudgetPlanContext {
  /** Number of pyramid levels, used to clamp `minLevel`. */
  levelCount: number
  /** Minimum per-axis halo the host's reconstruction filter needs. */
  minHalo: number
  /** Max brick texture edge the renderer will upload. */
  deviceLimit: number
}

/** Resolve a named preset or partial plan against the `'focus'` baseline. */
function planFromSpec(spec: BudgetPlanSpec | undefined): BudgetPlan {
  const base = BUDGET_PLANS.focus
  if (spec === undefined) return { ...base }
  if (typeof spec === 'string') {
    const named = (BUDGET_PLANS as Partial<Record<string, BudgetPlan>>)[spec]
    // An unknown name is a caller typo, not a reason to render nothing: fall
    // back to the baseline rather than throwing mid-load.
    return { ...base, ...(named ?? {}) }
  }
  return { ...base, ...spec }
}

/**
 * Fold a budget plan and the individual knobs into one {@link ResolvedOptions}.
 *
 * Precedence, lowest first: the `'focus'` preset, then a named preset, then an
 * explicit `budgetPlan` object, then any individual option. So an existing call
 * that passes `focus`/`radius`/`detail`/`budgetBytes`/`maxBricks`/`debounceMs`
 * keeps its exact behavior, and `resolveBudgetPlan({}, ctx)` reproduces the
 * defaults that predate this API.
 */
export function resolveBudgetPlan(
  options: BudgetPlanOptions,
  ctx: BudgetPlanContext,
): ResolvedOptions {
  const plan = planFromSpec(options.budgetPlan)
  const halo = options.halo ?? [1, 1, 1]
  return {
    focus: options.focus ?? plan.focus,
    radius: options.radius ?? plan.radius,
    budgetBytes: options.budgetBytes ?? plan.budgetBytes,
    maxBricks: options.maxBricks ?? plan.maxBricks,
    cellEdge: options.cellEdge ?? 128,
    gridDims: options.gridDims,
    halo: [
      Math.max(halo[0], ctx.minHalo),
      Math.max(halo[1], ctx.minHalo),
      Math.max(halo[2], ctx.minHalo),
    ],
    detail: options.detail ?? plan.detail,
    minLevel: Math.min(
      Math.max(0, Math.floor(options.minLevel ?? 0)),
      Math.max(0, ctx.levelCount - 1),
    ),
    deviceLimit: options.deviceLimit ?? ctx.deviceLimit,
    targetFrameMs: options.targetFrameMs ?? plan.targetFrameMs,
    renderCentering: options.renderCentering ?? 'none',
    debounceMs: options.debounceMs ?? plan.debounceMs,
    coarseFloor: options.coarseFloor ?? true,
  }
}
