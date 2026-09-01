# Budget Plans

A plan for giving the chunked-volume planner more than one policy.

Status: **Stages 1-3 implemented** (`src/volume/budgetPlans.ts`, exposed by the
Plan control in `examples/range.html`). Stage 4, the closed-loop frame-time
controller behind `targetFrameMs`, is still design. Tracked from
`docs/streaming-todos.md`; background on the machinery this builds on:
`docs/high-res-streaming.md`.

## Terms

Keep these two apart, in code and in prose:

- A **budget plan** is the POLICY: what the viewer should spend its VRAM and
  its frame time on. It is an input.
- A **chunk plan** (`ChunkPlan`, built by `chunkVolumeMultiLOD`) is the RESULT
  of applying a budget plan to a particular pyramid, focus and device. It is an
  output.

## The problem

`loadChunkedVolume` has exactly one policy today: an octree focused on the
crosshair (or a pinned point), refined by `detail`, coarsened until it fits
`budgetBytes` and `maxBricks`. That is the right policy for exploring a volume
and the wrong one for at least two other real uses.

| Use case | What the user wants | What they get today |
| --- | --- | --- |
| Interactive exploration | Detail where you are looking | Correct |
| Static image of the whole volume | The finest UNIFORM level that fits VRAM, quality everywhere, no falloff | A sharp core at the crosshair and a coarse periphery, which is wrong for a figure |
| Smooth rotate/zoom | The finest detail that still holds a frame-rate target | A byte budget, which does not predict frame time: brick count and sampled voxels do |

## API

One new option, taking either a preset name or an explicit object:

```ts
nv.loadChunkedVolume(source, { budgetPlan: 'uniform' })
nv.loadChunkedVolume(source, { budgetPlan: { ...BUDGET_PLANS.interactive, budgetBytes: 2e9 } })
```

```ts
export interface BudgetPlan {
  /** Which region gets the finest data. 'none' pins the volume centre and does
   *  not subscribe locationChange. */
  focus: 'crosshair' | 'none' | Vec3f
  /** Finest-LOD radius in common-grid voxels. 'volume' covers every brick;
   *  'auto' derives it from the view (per-axis half-extents over zoom in 2D
   *  slice views); a Vec3f is a per-axis (ellipsoidal) radius. */
  radius: 'auto' | 'volume' | number | Vec3f
  /** LOD falloff factor (1 = 2:1-balanced octree). */
  detail: number
  /** VRAM ceiling for the planned brick set. */
  budgetBytes: number
  /** Brick-count ceiling (must stay under the renderer's per-tile cap). */
  maxBricks: number
  /** Frame-time target in ms. When set, the plan adapts to hold it. */
  targetFrameMs?: number
  /** Re-plan debounce, ms. */
  debounceMs: number
}

export type BudgetPlanName = 'focus' | 'uniform' | 'interactive'
```

Presets:

| Preset | focus | radius | maxBricks | targetFrameMs | Notes |
| --- | --- | --- | --- | --- | --- |
| `focus` | `'crosshair'` | `'auto'` | 240 | - | Exactly today's defaults |
| `uniform` | `'none'` | `'volume'` | 240 | - | Finest uniform level that fits |
| `interactive` | `'crosshair'` | `'auto'` | 128 | 16.7 | Budgeted by draw cost |

**Every preset carries the same `budgetBytes`.** How much VRAM a machine can
spare is a property of the DEVICE; how to spend it is the use case. So an app
pins the ceiling once as an individual option (which wins over the plan) and
still switches plans freely. `examples/range.js` does exactly that with its
2 GB ceiling.

**Why 128 and not 96.** Measured on the HOA heart pyramid at `cellEdge` 128:
the octree coarsens a whole shell at a time, so plans come in steps -- a 4x4x4
core is 64 bricks and each further shell adds ~56. `focus` lands on 176 bricks
(L2/L3/L4, 1582 MB); a cap of 128 lands on 120 (L3/L4, 1071 MB), one shell
less; a cap of 96 collapses all the way to the 64-brick uniform coarse plan,
which is `uniform`, not a cheaper focused plan. Where the BYTE budget binds
first (a 2048^3 cube at 2 GB pins both presets to the same 64 bricks) the two
plans agree, which is correct: the draw count was already at its floor.

**Compatibility.** The existing per-knob options (`focus`, `radius`, `detail`,
`budgetBytes`, `maxBricks`, `debounceMs`) stay and win over the plan, so no
existing call changes behavior. Precedence, lowest first:

    'focus' preset  <  named preset  <  explicit budgetPlan object  <  individual options

`resolveBudgetPlan({})` must produce byte-identical `ResolvedOptions` to today.

## Stages

### Stage 1 - name what already exists (no behavior change) - DONE

- New `src/volume/budgetPlans.ts`: the `BudgetPlan` type, `BUDGET_PLANS`, and
  `resolveBudgetPlan(options): ResolvedOptions`.
- `NVChunkedVolume` resolves through it instead of reading each option inline.
- No renderer change, so no backend work in this stage.
- Test: `resolveBudgetPlan({})` deep-equals the current resolved defaults, and
  each individual option still overrides its preset field.

### Stage 2 - `'uniform'` - DONE

The claim to verify first, because if it holds this stage is nearly free: with
a radius that covers the whole volume, the budget pass in `chunkVolumeMultiLOD`
already converges on the finest uniform level that fits. The `detail` shrink
pass only affects cells BEYOND the radius, so it has nothing to bite on; the
pass falls through to raising the global level floor, which coarsens uniformly.

- `radius: 'volume'` resolves to half the common-grid diagonal.
- `focus: 'none'` pins the centre and skips the `locationChange` subscription.
- Check `focusCenterBiased` with a whole-volume radius: the bias is irrelevant
  there but must not push the centre outside the volume.
- Test (`NVChunkedVolume.test.ts`, so the plan name is exercised end to end):
  every brick reports the same `sourceLevel`, and cutting the budget 8x steps
  that level by exactly 1. It lifts `maxBricks` for the measurement, since with
  the preset's cap the brick count binds first and the bytes never bite.
- Keep the coarse floor on. It is what shows while the uniform set streams.

### Stage 3 - switching plans mid-session - DONE

The natural flow is explore with `'focus'`, then switch to `'uniform'` to take
a figure. `swapChunkedVolumePlan` already swaps in place keeping unchanged
bricks resident, so the plumbing exists.

- Public `NVChunkedVolume.setBudgetPlan(plan)`: re-resolve, rebuild, swap.
- Subscription handling: switching to `'none'` unsubscribes `locationChange`;
  switching back resubscribes. Guard against double-subscribe.
- Test: `focus -> uniform -> focus` leaves the manager consistent and leaks no
  subscriptions, and a switch after `dispose()` does not resubscribe.

As implemented, the switch re-folds the new plan over the options the volume was
LOADED with, so a knob the app pinned then (the demo's VRAM ceiling, a pinned
`radius`) still wins -- the same precedence `loadChunkedVolume` applied. Two
things are deliberately carried over from the CURRENT state instead: `minLevel`,
so a plan switch cannot silently undo a `setMaxDetail` made in between, and the
halo, which stays raise-only so a switch cannot undercut a wider reconstruction
kernel that was already streamed for. Subscription state is tracked by a
`subscribedToCrosshair` flag, so init / switch / dispose are all idempotent.

### Stage 4 - `'interactive'` and the cost model - NOT DONE

`targetFrameMs` is resolved and readable but nothing acts on it yet. What
shipped is the static half: `interactive` buys its headroom with a lower
`maxBricks`, the direct proxy for draw count (one brick = one ray-marched cube
draw). The closed loop below is what remains.

This is the only stage that needs genuinely new machinery, because bytes do not
predict frame time.

**Starting plan (static estimate).** Ray-march cost is dominated by samples
taken, so `bricks x mean sampled voxels per brick` is a usable proxy for
picking the initial `maxBricks`/`detail`. Projected screen area would be more
accurate and needs the camera, which the planner does not have; start with the
proxy.

**Holding the target (closed loop).** Measure frame time in the existing
`NVControlBase` RAF tick over a rolling window, and step `detail` by the same
1.6 factor the budget pass uses. Two rules keep it from oscillating, which
matters because a volume flipping between two levels looks far worse than one
that is slightly too coarse:

- Use a rolling MEDIAN, not a mean. One GC pause must not coarsen the volume.
- Hysteresis band: coarsen only above ~1.15x target, refine only below ~0.8x,
  and require K consecutive windows on the same side before stepping.

**Interaction-gated is the real behavior.** There is no point coarsening a
still image. The honest version of `'interactive'` is: run the loop while the
user is dragging or zooming, and settle back to the byte-budgeted plan when
idle. That is the classic LOD-on-interaction pattern and it is what "highest
detail that lets me rotate smoothly" actually asks for.

## Open questions

- **Does `'interactive'` belong on the volume or the view?** Frame time is a
  property of the whole scene (several volumes, meshes, overlays), not of one
  volume. A view-level frame budget that the volumes divide is probably right;
  a per-volume target is a good approximation while there is one streamed
  volume, which is every current demo. Decide before Stage 4, not during.
- **Should `'uniform'` disable the coarse floor?** No. It is the fallback while
  the uniform set streams, and it costs one coarsest-level fetch.
- **Does `'uniform'` want a different `cellEdge`?** Larger bricks mean fewer
  draws for the same voxels, which suits a static image. Measure rather than
  assume.

## Not in this plan

- Moving chunk decode off the main thread (`docs/streaming-todos.md`). That is
  performance work and is deliberately sequenced AFTER the visual artifacts.
- Cross-LOD blending at brick faces (`FEATURE_PARITY.md`, deferred).
