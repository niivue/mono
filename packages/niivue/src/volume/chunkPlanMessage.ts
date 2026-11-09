import { NiiDataType } from '@/NVConstants'
import {
  bytesPerSourceVoxel,
  estimateChunkedBytes,
  formatBytes,
} from './chunkBudget'
import type { ChunkPlan, Vec3i } from './chunking'

/**
 * The log line explaining why a volume is drawn in chunks and what the plan
 * is: an axis is larger than the device limit (warn), or a chunk grid was
 * requested on a volume that fits (info). An octree plan is described by its
 * bricks per level, since its mixed-size bricks are not a grid.
 */
export function chunkPlanMessage(o: {
  name: string
  datatypeCode: number
  rasDims: Vec3i
  limit: number
  limitName: string
  plan: ChunkPlan
}): { level: 'warn' | 'info'; text: string } {
  const { plan, limit, rasDims } = o
  const budget = estimateChunkedBytes(
    plan,
    bytesPerSourceVoxel(o.datatypeCode) || 4,
  )
  const dtype =
    Object.entries(NiiDataType)
      .find(([, code]) => code === o.datatypeCode)?.[0]
      .slice(3)
      .toLowerCase() ?? `datatype ${o.datatypeCode}`
  const volume = `Volume "${o.name}" (${rasDims.join('x')} ${dtype})`
  const gpu =
    `~${formatBytes(budget.totalBytes)} GPU ` +
    `(${formatBytes(budget.scalarBytes)} scalar + ` +
    `${formatBytes(budget.rgbaBytes)} RGBA + ` +
    `${formatBytes(budget.gradientBytes)} gradient)`
  const n = plan.chunks.length
  const [gx, gy, gz] = plan.gridDims
  // ChunkPlan's contract: a real grid's gridDims product is its chunk count.
  // One brick satisfies it either way (a 1x1x1 grid, or an octree cut to one
  // brick by its budget), so it gets neutral wording.
  const isOctree = gx * gy * gz !== n
  const bricks = `${n} brick${n === 1 ? '' : 's'}`
  let layout: string
  if (n === 1) {
    const level = plan.chunks[0]?.sourceLevel ?? 0
    layout = `1 brick${level > 0 ? ` at L${level}` : ''}, ${gpu}`
  } else if (isOctree) {
    const perLevel = new Map<number, number>()
    for (const c of plan.chunks) {
      const level = c.sourceLevel ?? 0
      perLevel.set(level, (perLevel.get(level) ?? 0) + 1)
    }
    const moves = `${gpu}; bricks may be re-chosen as the view moves`
    if (perLevel.size > 1) {
      const levels = [...perLevel]
        .sort(([a], [b]) => b - a)
        .map(([level, count]) => `L${level}: ${count}`)
        .join(', ')
      layout = `a multi-resolution octree, ${bricks} in the plan (${levels}), ${moves}`
    } else {
      // Every brick samples one level: the bricks differ in extent only.
      const level = plan.chunks[0]?.sourceLevel ?? 0
      layout = `an adaptive octree, ${bricks} in the plan${level > 0 ? ` at L${level}` : ''}, ${moves}`
    }
  } else {
    layout = `a ${plan.gridDims.join('x')} grid = ${bricks}, ${gpu}`
  }
  // RAS dims are the source dims reordered, so they decide and name the axes.
  const axes = ['x', 'y', 'z'].filter((_, a) => rasDims[a] > limit)
  if (axes.length === 0) {
    return {
      level: 'info',
      text: `${volume} fits ${o.limitName} (${limit}), but was given ${layout}.`,
    }
  }
  const on =
    axes.length === 1
      ? axes[0]
      : `${axes.slice(0, -1).join(', ')} and ${axes[axes.length - 1]}`
  const verb =
    n === 1 ? 'drawing it as' : isOctree ? 'streaming it as' : 'tiling it into'
  return {
    level: 'warn',
    text: `${volume} exceeds ${o.limitName} (${limit}) on ${on}: ${verb} ${layout}.`,
  }
}
