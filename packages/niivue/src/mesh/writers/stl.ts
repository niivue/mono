export const extensions = ["STL"]

export async function write(
  positions: Float32Array,
  indices: Uint32Array,
): Promise<ArrayBuffer> {
  const numTriangles = indices.length / 3
  // 80-byte header + 4-byte count + 50 bytes per triangle
  const buffer = new ArrayBuffer(84 + numTriangles * 50)
  const view = new DataView(buffer)
  // Header: 80 zero bytes (already zeroed by ArrayBuffer)
  // Triangle count
  view.setUint32(80, numTriangles, true)
  let offset = 84
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3
    const i1 = indices[i + 1] * 3
    const i2 = indices[i + 2] * 3
    // Normal vector (zero — readers recompute from vertices)
    view.setFloat32(offset, 0, true)
    view.setFloat32(offset + 4, 0, true)
    view.setFloat32(offset + 8, 0, true)
    offset += 12
    // Vertex 1
    view.setFloat32(offset, positions[i0], true)
    view.setFloat32(offset + 4, positions[i0 + 1], true)
    view.setFloat32(offset + 8, positions[i0 + 2], true)
    offset += 12
    // Vertex 2
    view.setFloat32(offset, positions[i1], true)
    view.setFloat32(offset + 4, positions[i1 + 1], true)
    view.setFloat32(offset + 8, positions[i1 + 2], true)
    offset += 12
    // Vertex 3
    view.setFloat32(offset, positions[i2], true)
    view.setFloat32(offset + 4, positions[i2 + 1], true)
    view.setFloat32(offset + 8, positions[i2 + 2], true)
    offset += 12
    // Attribute byte count
    view.setUint16(offset, 0, true)
    offset += 2
  }
  return buffer
}
