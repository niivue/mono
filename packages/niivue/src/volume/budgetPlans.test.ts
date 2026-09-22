import { describe, expect, test } from 'bun:test'
import {
  BUDGET_PLANS,
  DEFAULT_BUDGET_BYTES,
  resolveBudgetPlan,
} from './budgetPlans'

const ctx = { levelCount: 5, minHalo: 0, deviceLimit: 256 }

describe('resolveBudgetPlan', () => {
  test('no options reproduces the pre-plan defaults exactly', () => {
    expect(resolveBudgetPlan({}, ctx)).toEqual({
      focus: 'crosshair',
      radius: 'auto',
      budgetBytes: DEFAULT_BUDGET_BYTES,
      maxBricks: 240,
      cellEdge: 128,
      halo: [1, 1, 1],
      detail: 1,
      minLevel: 0,
      deviceLimit: 256,
      targetFrameMs: undefined,
      renderCentering: 'none',
      debounceMs: 150,
      coarseFloor: true,
    })
  })

  test("the 'focus' preset is the baseline, so naming it changes nothing", () => {
    expect(resolveBudgetPlan({ budgetPlan: 'focus' }, ctx)).toEqual(
      resolveBudgetPlan({}, ctx),
    )
  })

  test("'uniform' pins the centre and covers the whole volume", () => {
    const o = resolveBudgetPlan({ budgetPlan: 'uniform' }, ctx)
    expect(o.focus).toBe('none')
    expect(o.radius).toBe('volume')
  })

  test("'interactive' trades brick count for frame time", () => {
    const o = resolveBudgetPlan({ budgetPlan: 'interactive' }, ctx)
    expect(o.maxBricks).toBe(128)
    expect(o.maxBricks).toBeLessThan(BUDGET_PLANS.focus.maxBricks)
    expect(o.targetFrameMs).toBe(16.7)
    expect(o.focus).toBe('crosshair')
  })

  test('an individual option beats the named preset', () => {
    const o = resolveBudgetPlan(
      { budgetPlan: 'interactive', maxBricks: 512, focus: [0.1, 0.2, 0.3] },
      ctx,
    )
    expect(o.maxBricks).toBe(512)
    expect(o.focus).toEqual([0.1, 0.2, 0.3])
    // Untouched knobs still come from the preset.
    expect(o.targetFrameMs).toBe(16.7)
  })

  test('an explicit plan object layers over the baseline, knobs still win', () => {
    const o = resolveBudgetPlan(
      { budgetPlan: { radius: 'volume', budgetBytes: 2e9 }, budgetBytes: 1e9 },
      ctx,
    )
    expect(o.radius).toBe('volume')
    expect(o.budgetBytes).toBe(1e9)
    // Not mentioned by the partial plan, so the baseline supplies it.
    expect(o.focus).toBe('crosshair')
  })

  test('an unknown plan name falls back to the baseline rather than throwing', () => {
    // Reachable from plain JS (and from a URL parameter), so it must degrade.
    const o = resolveBudgetPlan({ budgetPlan: 'nonesuch' as 'focus' }, ctx)
    expect(o).toEqual(resolveBudgetPlan({}, ctx))
  })

  test('minLevel is clamped into the pyramid, halo raised to the host minimum', () => {
    expect(resolveBudgetPlan({ minLevel: 99 }, ctx).minLevel).toBe(4)
    expect(resolveBudgetPlan({ minLevel: -3 }, ctx).minLevel).toBe(0)
    expect(
      resolveBudgetPlan({ halo: [1, 4, 1] }, { ...ctx, minHalo: 2 }).halo,
    ).toEqual([2, 4, 2])
  })

  test('a single-level pyramid still clamps to a valid index', () => {
    expect(
      resolveBudgetPlan({ minLevel: 3 }, { ...ctx, levelCount: 1 }).minLevel,
    ).toBe(0)
  })

  test('BUDGET_PLANS is not mutated by resolution', () => {
    resolveBudgetPlan({ budgetPlan: 'uniform', maxBricks: 7 }, ctx)
    expect(BUDGET_PLANS.uniform.maxBricks).toBe(240)
  })
})
