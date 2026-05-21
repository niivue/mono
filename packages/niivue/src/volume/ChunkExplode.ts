import type { ChunkPlan, Vec3f } from './chunking'

export interface ChunkExplodeOptions {
  enabled?: boolean
  scale?: readonly [number, number, number]
}

const IDENTITY_SCALE: Vec3f = [1, 1, 1]
const ZERO_OFFSET: Vec3f = [0, 0, 0]

export function chunkExplodeEnabled(
  explode: ChunkExplodeOptions | null | undefined,
): boolean {
  if (!explode?.enabled) return false
  const scale = chunkExplodeScale(explode)
  return scale.some((axisScale) => axisScale > 1)
}

export function chunkExplodeScale(
  explode: ChunkExplodeOptions | null | undefined,
): Vec3f {
  if (!explode?.enabled) return IDENTITY_SCALE
  const src = explode.scale ?? [1.5, 1.5, 1.5]
  return [
    sanitizeExplodeScale(src[0]),
    sanitizeExplodeScale(src[1]),
    sanitizeExplodeScale(src[2]),
  ]
}

function sanitizeExplodeScale(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(1, value)
}

export function chunkExplodeOffsetFrac(
  plan: ChunkPlan,
  chunkIndex: number,
  explode: ChunkExplodeOptions | null | undefined,
): Vec3f {
  if (!chunkExplodeEnabled(explode)) return ZERO_OFFSET
  const desc = plan.chunks[chunkIndex]
  if (!desc) return ZERO_OFFSET
  const scale = chunkExplodeScale(explode)
  return [
    explodeAxisOffset(desc.gridIndex[0], plan.gridDims[0], scale[0]),
    explodeAxisOffset(desc.gridIndex[1], plan.gridDims[1], scale[1]),
    explodeAxisOffset(desc.gridIndex[2], plan.gridDims[2], scale[2]),
  ]
}

function explodeAxisOffset(index: number, gridDim: number, scale: number) {
  if (gridDim <= 1 || scale <= 1) return 0
  const center = (gridDim - 1) / 2
  return ((index - center) * (scale - 1)) / gridDim
}

export function chunkExplodedMatRAS(
  plan: ChunkPlan,
  chunkIndex: number,
  matRAS: Float32Array | number[],
  explode: ChunkExplodeOptions | null | undefined,
): Float32Array | number[] {
  const offset = chunkExplodeOffsetFrac(plan, chunkIndex, explode)
  if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) return matRAS

  const [vx, vy, vz] = plan.volumeDims
  const ox = offset[0] * vx
  const oy = offset[1] * vy
  const oz = offset[2] * vz
  const out = new Float32Array(16)
  for (let i = 0; i < 16; i++) out[i] = matRAS[i] ?? 0

  out[3] += ox * matRAS[0] + oy * matRAS[1] + oz * matRAS[2]
  out[7] += ox * matRAS[4] + oy * matRAS[5] + oz * matRAS[6]
  out[11] += ox * matRAS[8] + oy * matRAS[9] + oz * matRAS[10]
  out[15] += ox * matRAS[12] + oy * matRAS[13] + oz * matRAS[14]
  return out
}
