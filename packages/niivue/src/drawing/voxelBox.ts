/** An inclusive box of RAS voxel indices. */
export type VoxelBox = {
  min: [number, number, number]
  max: [number, number, number]
}

/** `box` grown to take in voxel (x, y, z) and `radius` voxels around it (a new box from null). */
export function growVoxelBox(
  box: VoxelBox | null,
  x: number,
  y: number,
  z: number,
  radius: number,
): VoxelBox {
  const lo: [number, number, number] = [x - radius, y - radius, z - radius]
  const hi: [number, number, number] = [x + radius, y + radius, z + radius]
  if (!box) return { min: lo, max: hi }
  for (let i = 0; i < 3; i++) {
    box.min[i] = Math.min(box.min[i], lo[i])
    box.max[i] = Math.max(box.max[i], hi[i])
  }
  return box
}

/** `box` as whole voxels inside a grid of `dims`; null when it misses the grid. */
export function clampVoxelBox(
  box: VoxelBox,
  dims: readonly [number, number, number],
): VoxelBox | null {
  const min = box.min.map((v) => Math.max(0, Math.floor(v))) as VoxelBox['min']
  const max = box.max.map((v, i) =>
    Math.min(dims[i] - 1, Math.ceil(v)),
  ) as VoxelBox['max']
  return min.every((v, i) => v <= max[i]) ? { min, max } : null
}
