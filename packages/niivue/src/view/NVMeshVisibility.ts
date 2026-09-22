/**
 * Whether a mesh contributes to a draw. `visible` is the explicit toggle
 * (`setMesh(i, { visible: false })`); zero opacity is the same thing reached
 * through the opacity control. Both must also gate PICKING, or a hidden mesh
 * still answers a double-click.
 */
export function isMeshDrawn(mesh: {
  opacity?: number
  visible?: boolean
}): boolean {
  return mesh.visible !== false && (mesh.opacity ?? 1.0) > 0.0
}
